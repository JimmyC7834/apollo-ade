---
label: wayfinder:grilling
title: What pi-agent-core already does that we are reimplementing
parent: ../map.md
blocked-by: []
assignee: jc4649
status: open
---

# What pi-agent-core already does that we are reimplementing

## Question

Raised by the dev while planning a slash-command system for the agent chat: *"shouldn't
the pi agent package we use have these features?"* — and then, when the first answer was
only half right, *"pi harness is composed of multiple packages, see what other of their
packages we can just use."*

Both questions are now answered factually. The second answer is **no** — and the first is
**mostly yes**, which is the finding this ticket exists to act on.

### Fact 1 — no other pi package is adoptable

All nine were surveyed in the `pi/` clone at `aa0ec808b`.

| Package | Runtime deps | Verdict |
| --- | --- | --- |
| `pi-agent-core` | `pi-ai`, `diff`, `ignore`, `typebox`, `yaml` | **ours already** |
| `pi-ai` | provider SDKs, `partial-json`, `typebox` | **ours already** |
| `pi-protocol` | `typebox` | browser-safe, but it is the wire format for **out-of-process** agents. We chose in-process. No. |
| `pi-client` | `pi-protocol` | RPC client for `pi-server`. Same reason. No. |
| `pi-tui` | `get-east-asian-width`, `marked` | terminal renderer. No. |
| `pi-coding-agent` | `cross-spawn`, `glob`, `proper-lockfile`, `undici`, `jiti`, `chalk`, … | Node-bound. No. |
| `pi-server` | `pi-coding-agent` | Node. No. |
| `storage/sqlite-node` | — | Node sqlite. No. |
| `pi-evals` | none | pi's own eval harness. No. |

This confirms rather than changes the map: `pi-coding-agent` was already ruled out as a
sidecar, and `pi-server`/`pi-client` were already out of scope. What is *new* is the
detail on `pi-coding-agent`'s command system specifically, since that is what prompted
the question:

- `src/core/slash-commands.ts` is **42 lines** — a list of names and one-line
  descriptions, plus two interfaces. It contains no dispatch.
- The dispatch lives in `src/modes/interactive/interactive-mode.ts`, **6,125 lines**,
  importing `node:fs`, `node:os`, `node:crypto`, `child_process`, `chalk` and
  `@earendil-works/pi-tui`.

So parse-and-route is genuinely ours to write. That much of the original plan stands.

### Fact 2 — we use roughly 40% of the package we already depend on

`pi-agent-core`'s `dist/index.d.ts` re-exports twenty modules. These are the ones that
land on work already queued on this map, each verified against the **installed 0.83.0
tarball** rather than the clone:

**Command parsing and user-authored commands** — `harness/prompt-templates.ts`

```ts
parseCommandArgs(argsString: string): string[]
substituteArgs(content: string, args: string[]): string
formatPromptTemplateInvocation(template: PromptTemplate, args?: string[]): string
loadPromptTemplates(env: ExecutionEnv, paths: string | string[]): Promise<{…}>
loadSourcedPromptTemplates<TSource, TPromptTemplate>(env, inputs): Promise<{…}>
```

plus `AgentHarness.promptFromTemplate(name, args)` and
`AgentHarnessResources.promptTemplates`. `PromptTemplate.description` is documented
upstream as *"Optional description for command lists or autocomplete"* — pi expects the
application to render the picker and hands it everything behind it. `loadPromptTemplates`
takes an `ExecutionEnv`, which we already have, so reading user commands off disk through
Rust costs nothing new.

**A bash tool** — `harness/tools/bash.ts`

```ts
createBashTool<TContext>(options?: { commandPrefix?: string; prepare?: BashPrepare }):
  AgentHarnessTool<TContext, { command: string; timeout?: number }, BashToolDetails>
```

It is in **core**, not `pi-coding-agent`, and it runs against `ExecutionEnv.exec` — which
our env currently stubs as `shell_unavailable`. `harness/utils/shell-output.ts` and
`harness/utils/truncate.ts` handle the output side. The `prepare` hook is the same one
[ticket 11](11-rtk-in-profile.md) already chose for rtk.

**Session persistence** — `harness/session/jsonl-storage.ts`

```ts
JsonlSessionStorage.create(fs, filePath, { cwd, sessionId, parentSessionPath?, metadata? })
JsonlSessionStorage.open(fs, filePath)
```

where `fs` is `Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">`
— four methods. This is [ticket 09](09-session-store.md)'s resolution ("JSONL through the
Rust adapter … only four FS methods required") sitting implemented in the package. It also
carries `getSessionStats()` (message count, cached/uncached tokens, cost total) and
`getPathToRootOrCompaction()`.

**Compaction and a context meter** — `harness/compaction/compaction.ts`

```ts
shouldCompact, calculateContextTokens, estimateContextTokens, findCutPoint,
findTurnStartIndex, prepareCompaction, generateSummary, generateSummaryWithUsage,
getLastAssistantUsage, serializeConversation, DEFAULT_COMPACTION_SETTINGS
```

plus `AgentHarness.compact(customInstructions?)` and branch summarisation
(`generateBranchSummary`, `prepareBranchEntries`). We currently approximate the context
meter with the provider's own `usage.totalTokens`, noted in `events.ts` as "enough for a
meter; revisit if it has to drive compaction."

**Also unused**: `createImageTool`, `loadSkills`, `formatSkillInvocation`,
`formatSkillsForSystemPrompt`, `AgentHarness.skill(name)`,
`AgentHarness.navigateTree(targetId, …)` (which backs `/tree` and `/fork`), and the
`memory-repo` / `memory-storage` pair.

### The decisions to settle

This is not an inventory ticket. Each item below is a live choice, and the tension running
through all of them is the map's own standing rule from
[ticket 07](07-pi-dependency.md): **wrap pi's interfaces in our own rather than
implementing them directly**, because upstream ships a breaking change every few days.
Every export adopted here widens the surface that breaks on upgrade. "It already exists"
is an argument for adopting it; it is not the whole argument.

Settle:

- **The standing rule.** Before any slice, grep `dist/index.d.ts` for what core already
  exports. Three consecutive plans on this map proposed building something core ships.
  Decide whether that becomes a written rule in `context.md` or stays a habit — and
  whether it belongs in the wayfinder ticket template rather than here.

- **Which of the five adoptions above are in, and in what order.** Each has a different
  cost/benefit against the wrapping rule. `parseCommandArgs` is a pure function with no
  pi types in its signature and is nearly free to adopt or to drop later.
  `JsonlSessionStorage` returns pi's `SessionTreeEntry` shapes and is the deepest
  coupling of the five. They should not be decided as one block.

- **Whether the command system is a ticket at all**, or falls out of the two slices it
  depends on. Its builtin half is a lookup table; its user half is `promptFromTemplate`.
  Neither looks like a decision once the harness outlives the turn.

- **The prerequisite nobody has written down.** `src/agent/provider.ts` builds a new
  `AgentHarness` and a new `Session` inside `start()`, so **every turn is a fresh
  conversation with no memory of the last one**. `/compact` has nothing to compact,
  `setModel` would forget itself, and `compacted` has never fired because it is
  unreachable, not because it is untested. Decide whether the persistent harness is its
  own slice or arrives with `JsonlSessionStorage` — the two edits touch the same lines.

- **Whether adopting core's compaction closes the map's open fog entry**, "Whether pi's
  compaction defaults need touching." The exports make it answerable; it is currently
  listed as unspecified.

Out of scope: `navigateTree`, `/fork` and `/tree`. Session branching is a real feature
with real UI, and folding it into an inventory ticket would hide it. Noted here so it is
not forgotten — the transcript should not be assumed to be a flat list forever.

---

## Resolution

<!-- filled on close -->
