---
label: wayfinder:grilling
title: What pi already does that we are reimplementing
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# What pi already does that we are reimplementing

## Question

Raised by the dev while planning a slash-command system for the agent chat: *"shouldn't
the pi agent package we use have these features?"* Then twice more, because the first two
answers were each too narrow: *"pi harness is composed of multiple packages, see what
other of their packages we can just use"*, and *"do a comprehensive review … reuse all
harness code we can."*

The survey is now complete. **Every runtime export of the two packages we depend on has
been enumerated** against the installed 0.83.0 `dist/`, not the `pi/` clone — the map
warns the clone is ahead of published, and every claim below must survive an upgrade
check.

The short answer: **no other pi package is adoptable, and we are using roughly a third of
the one we already have.**

---

## Fact 1 — no other pi package is adoptable

All nine surveyed.

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

This confirms the map rather than changing it — `pi-coding-agent` was already ruled out as
a sidecar, `pi-server`/`pi-client` already out of scope. What is *new* is detail on
`pi-coding-agent`'s command system, since that is what prompted the question:

- `src/core/slash-commands.ts` is **42 lines** — names and one-line descriptions, plus two
  interfaces. No dispatch.
- Dispatch lives in `src/modes/interactive/interactive-mode.ts`, **6,125 lines**,
  importing `node:fs`, `node:os`, `node:crypto`, `child_process`, `chalk` and `pi-tui`.

So parse-and-route is genuinely ours to write.

## Fact 2 — browser safety is verifiable, not just claimed

`grep -rl 'from "node:"' dist/**/*.js` across `pi-agent-core` returns **exactly one file**:
`dist/harness/env/nodejs.js` (`NodeExecutionEnv`). Every other module in the package —
harness, session, compaction, tools, prompt templates, skills — is free of Node imports.

This is stronger than the map's existing note that `node.ts` is 88 bytes, and it is the
fact that makes everything below safe to adopt in a WebView.

## Fact 3 — complete export inventory of `pi-agent-core`

Every exported function, class and const in `dist/`, classified.

### Already in use (7)

`AgentHarness`, `Session`, `InMemorySessionStorage`, `createReadTool`, `createWriteTool`,
`createEditTool`, and the `types.ts` error classes (`FileError`, `ExecutionError`) plus
`ok`/`err` in `src/agent/env.ts`.

### Adopt — lands on queued work (5 groups)

**A. Session management and forking** — `harness/session/jsonl-repo.ts`

```ts
class JsonlSessionRepo {
  create(options): Promise<Session<JsonlSessionMetadata>>
  open(metadata): Promise<Session<JsonlSessionMetadata>>
  list(options?): Promise<JsonlSessionMetadata[]>
  delete(metadata): Promise<void>
  fork(sourceMetadata, { entryId?, position?: "before" | "at", id? }): Promise<Session<…>>
}
```

plus `JsonlSessionStorage.create/open`, `loadJsonlSessionMetadata`, `getEntriesToFork`,
`createSessionId`, `createTimestamp`, `toSession`, and on `Session` itself:
`moveTo(entryId, summary?)`, `getBranch(fromId?)`, `getSessionStats()`, `appendLabel`,
`appendSessionName`, `appendCustomEntry`, `appendCustomMessageEntry`, `appendModelChange`,
`appendThinkingLevelChange`, `appendActiveToolsChange`, `appendCompaction`.

**This is the whole of session persistence, listing, resuming, branching and forking.**
[Ticket 09](09-session-store.md) resolved "JSONL through the Rust adapter, only four FS
methods required" — the implementation was already in the package. `appendModelChange` /
`appendThinkingLevelChange` / `appendActiveToolsChange` are the exact entry types
[ticket 14](14-switch-aftermath.md) named for recording a profile switch.

**Cost.** `JsonlSessionRepo` needs eleven `FileSystem` methods:
`cwd`, `absolutePath`, `joinPath`, `readTextFile`, `readTextLines`, `writeFile`,
`appendFile`, `listDir`, `exists`, `createDir`, `remove`. We implement four and stub
seven. Of the seven, `joinPath` and `absolutePath` are pure string operations needing no
Rust, and `readTextLines` is `readTextFile` plus a split. **Four new Rust commands —
`appendFile`, `listDir`, `createDir`, `remove` — buy persistence, session list, resume,
delete and fork.**

**B. Commands** — `harness/prompt-templates.ts`

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
application to render the picker and supplies everything behind it. `loadPromptTemplates`
takes an `ExecutionEnv`, so reading user commands off disk through Rust costs nothing new.

**C. A bash tool** — `harness/tools/bash.ts`, `harness/utils/shell-output.ts`,
`harness/utils/truncate.ts`

```ts
createBashTool<TContext>(options?: { commandPrefix?, prepare?: BashPrepare })
executeShellWithCapture(env, command, options?): Promise<Result<ShellCaptureResult, ExecutionError>>
sanitizeBinaryOutput, truncateHead, truncateTail, truncateLine, formatSize
DEFAULT_MAX_LINES = 2000, DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH = 500
```

In **core**, not `pi-coding-agent`. It runs on `ExecutionEnv.exec`, which we stub as
`shell_unavailable`. `ShellCaptureResult` carries `truncated`, `cancelled`, `exitCode`,
`fullOutputPath` — the overflow-file behaviour [ticket 02](02-exec-not-terminal.md)
specified is already implemented. The `prepare` hook is the same one
[ticket 11](11-rtk-in-profile.md) chose for rtk, and is a natural second inspection point
for the deny list.

**D. Compaction and a real context meter** — `harness/compaction/`

```ts
shouldCompact, calculateContextTokens, estimateContextTokens, estimateTokens,
findCutPoint, findTurnStartIndex, prepareCompaction, compact,
generateSummary, generateSummaryWithUsage, getLastAssistantUsage,
serializeConversation, DEFAULT_COMPACTION_SETTINGS, SUMMARIZATION_SYSTEM_PROMPT,
collectEntriesForBranchSummary, prepareBranchEntries, generateBranchSummary,
createFileOps, extractFileOpsFromMessage, computeFileLists, formatFileOperations
```

plus `AgentHarness.compact(customInstructions?)`. `src/agent/events.ts` currently
approximates the context meter with the provider's `usage.totalTokens` and says so:
*"enough for a meter; revisit if it has to drive compaction."* This is that revisit.
`computeFileLists`/`formatFileOperations` are the ledger of files read and modified that
[ticket 14](14-switch-aftermath.md) noted pi carries forward through compaction.

**E. Skills and system prompt** — `harness/skills.ts`, `harness/system-prompt.ts`,
`harness/messages.ts`

```ts
loadSkills(env, dirs), loadSourcedSkills, formatSkillInvocation,
formatSkillsForSystemPrompt(skills)
convertToLlm, createCustomMessage, createCompactionSummaryMessage,
createBranchSummaryMessage, bashExecutionToText
COMPACTION_SUMMARY_PREFIX / _SUFFIX, BRANCH_SUMMARY_PREFIX / _SUFFIX
```

The map lists "Skills: composition with profiles" as fog. The *loading* half is solved.

### Adopt opportunistically (2)

`harness/tools/edit-diff.ts` — `generateUnifiedPatch`, `generateDiffString`,
`detectLineEnding`, `normalizeToLF`, `restoreLineEndings`, `stripBom`, `fuzzyFindText`.
If the transcript ever renders a diff for an `edit` approval — which is the obvious next
step for the gate — this is the diff generator, already line-ending and BOM correct.

`harness/tools/path-utils.ts` (`resolveToolPath`, `resolveReadToolPath`) and
`harness/tools/file-mutation-queue.ts` (`withFileMutationQueue`, which serialises
concurrent writes to one file).

### Not applicable (5)

`NodeExecutionEnv` (the one Node module). `Agent` / `agentLoop` / `runAgentLoop` — the
low-level loop beneath `AgentHarness`; we want the harness. `InMemorySessionRepo` — useful
only if browser mode grows session listing. `detectSupportedImageMimeType` / `encodeBase64`
— image support, and note there is **no `createImageTool`**; images arrive through
`ReadToolOptions.ReadImageProcessor`.

`streamProxy` deserves a line of its own, because it looks like our architecture and is
not. Its doc comment reads *"for apps that route LLM calls through a server. The server
manages auth and proxies requests to LLM providers"* — pi anticipated exactly the
credential split [ticket 06](06-credentials-and-http.md) settled. But it takes
`{ proxyUrl, authToken }` and speaks HTTP to a remote server; ours is Tauri IPC to the
same machine with no token at all. **Considered and set down**, recorded so nobody
rediscovers it as a missed opportunity.

### The complete tool set is four

`createBashTool`, `createReadTool`, `createWriteTool`, `createEditTool`. That is all of
`harness/tools/index.ts`. No grep, no ls, no find, no glob — those live in
`pi-coding-agent` and are Node-bound. **Anything beyond read/write/edit/bash is ours to
build**, which is directly relevant to [ticket 13](13-user-authored-tools.md).

## Fact 4 — `pi-ai` ships model machinery we hand-rolled, and one trap

`src/agent/provider.ts` hand-writes a `SHAPES` table and a `modelFor()` with two
apologetic comments: a `reasoning: /reason|think/i.test(modelId)` heuristic ("knowingly a
poor one") and a zeroed cost table ("wrong cost table produces confident wrong numbers").

pi-ai exports the real thing: `MODELS`, `getModel`, `getModels`, `getProviders`,
`flattenModelCatalog`, `calculateCost(model, usage)`, `getSupportedThinkingLevels(model)`,
`clampThinkingLevel(model, level)`, `modelsAreEqual`, `InMemoryModelsStore`, and 81
per-provider modules including `providers/deepseek` (`deepseekProvider()`).

Catalog entries carry two fields our hand-written model omits entirely:

```jsonc
"compat": { "thinkingFormat": "deepseek", "requiresReasoningContentOnAssistantMessages": true, … },
"thinkingLevelMap": { "minimal": null, "low": null, "medium": null, "high": "high", "max": "max" }
```

**The trap.** `deepseek-reasoner` — the model this repo actually runs and tested the gate
against — **is not in pi 0.83.0's catalog at all.** It ships `deepseek-v4-flash` and
`deepseek-v4-pro` and nothing else. And for both, `thinkingLevelMap.medium` is `null`,
meaning the `thinkingLevel: 'medium'` we hard-code would resolve to *disabled* — the exact
silent failure that cost this repo a debugging session.

So adopting the catalog wholesale would have **broken the working setup**. This is the map's
existing warning ("pi's bundled model catalogs go stale, and pinning does not help",
found via `gemini-2.5-flash` 404) confirmed from the opposite direction: not only does the
catalog list models that no longer work, it omits models that do.

The lesson is to separate the two: **adopt the machinery and the field shapes; do not
adopt the entries as truth.** `getSupportedThinkingLevels` and `clampThinkingLevel` are
strictly better than a regex on the model id whatever catalog backs them, and
`createModels` accepts a `fetchModels(context)` callback for a live list.

## Corrections to this ticket's first draft

Recorded rather than quietly edited.

- **Forking and session management were under-sold.** The first draft found
  `JsonlSessionStorage` (one session's file) and put forking in "out of scope". The
  `JsonlSessionRepo` layer above it does `create`/`open`/`list`/`delete`/`fork`, and
  `Session.moveTo` does branch switching. Forking is not future work; it is an unused
  export.
- **`createImageTool` does not exist.** The first draft listed it as unused. There are
  four tools, not five.

## The decisions to settle

The tension running through all of them is the map's own rule from
[ticket 07](07-pi-dependency.md): **wrap pi's interfaces in our own rather than
implementing them directly**, because upstream ships a breaking change every couple of
days. Every export adopted widens the surface that breaks on upgrade. "It already exists"
argues for adopting; it is not the whole argument. `parseCommandArgs` is a pure
`string → string[]` with no pi types in its signature and costs nothing to drop later;
`JsonlSessionRepo` returns pi's `SessionTreeEntry` shapes throughout and is the deepest
coupling on offer. **They must not be decided as one block.**

Settle:

- **The standing rule.** Grep `dist/index.d.ts` before planning any slice. Three
  consecutive plans on this map proposed building something core already exports. Decide
  whether that becomes written policy in `context.md`, or a line in the ticket template,
  or stays a habit.

- **Which of groups A–E are in, and in what order**, each weighed separately against the
  wrapping rule.

- **The prerequisite nobody wrote down.** `src/agent/provider.ts` constructs a new
  `AgentHarness` and a new `Session` inside `start()`, so **every turn is a fresh
  conversation with no memory of the last.** `/compact` has nothing to compact, `setModel`
  would forget itself, and `compacted` has never fired because it is *unreachable*, not
  untested — `docs/DEVLOG.md` currently describes it as the latter and should be
  corrected. Decide whether the persistent harness is its own slice or arrives with
  `JsonlSessionRepo`; the two edits touch the same lines.

- **Catalog: machinery yes, entries how?** Given `deepseek-reasoner`'s absence, decide
  between catalog-as-default-with-user-override, `fetchModels` against a live endpoint, or
  keeping hand-written entries and taking only `calculateCost` /
  `getSupportedThinkingLevels` / `clampThinkingLevel`. This is a profile question as much
  as a catalog one — it interacts with [ticket 04](04-profile-data-model.md)'s `model` and
  `thinkingLevel` fields.

- **Whether the command system is a ticket at all**, or falls out of the slices it depends
  on. Its builtin half is a lookup table; its user half is `promptFromTemplate`. Neither
  looks like a decision once the harness outlives the turn.

- **Whether adopting core's compaction closes the map's fog entry** "Whether pi's
  compaction defaults need touching."

- **Whether session forking gets a UI at all in v1.** The data model is free; a branch
  view, a session picker and a fork affordance are not. Core hands over storage and a tree;
  nobody hands over React.

## Out of scope

- Adopting pi's *model entries* as authoritative — ruled out by Fact 4, though the
  machinery is in.
- `pi-protocol` / `pi-client` / `pi-server` / `pi-tui` / `sqlite-node` — Fact 1.
- Tools beyond read/write/edit/bash. Core ships four; grep/ls/find are Node-bound in
  `pi-coding-agent`. Building more belongs to
  [user-authored tools](13-user-authored-tools.md), not here.

---

## Resolution

**Three of the five groups are in — two of them already shipped while this ticket was
open. Two queued items are deleted rather than built. The catalog gives up its entries and
keeps its machinery.**

### 1. The standing rule becomes policy, not habit

`context.md` gains one line: **grep
`node_modules/@earendil-works/pi-agent-core/dist/index.d.ts` before planning any slice.**

It is written down rather than remembered because it has already failed three times as a
habit — three consecutive plans on this map proposed building something core exports. A
habit with that record is not a habit.

### 2. Groups A–E, weighed separately

The wrapping rule from [ticket 07](07-pi-dependency.md) applies per group, as the ticket
demanded. It produced different answers, which is the evidence it was worth applying.

| Group | Decision | Coupling taken |
|---|---|---|
| **A. Session + forking** | **In — shipped**, slice 16 | Deepest on the map, unwrapped |
| **B. Commands** | **In, but not as a ticket** | None yet |
| **C. bash** | **In — shipped**, slice 17 | None; `ExecutionEnv` is the wrapper |
| **D. Compaction + context meter** | **In — next slice** | Moderate |
| **E. Skills** | **Deferred** | — |

**A is recorded honestly rather than favourably.** `JsonlSessionRepo` went into
`src/agent/provider.ts` directly, returning pi's `SessionTreeEntry` shapes, with no
adapter between. That is the deepest coupling this map has taken and it violates the
letter of the wrapping rule. It was still right — reimplementing JSONL session
persistence, listing, resume, delete and fork to avoid a type import would have been the
exact mistake this ticket exists to name — but **the upgrade risk is real and it is
concentrated in one file**, and pretending otherwise would leave the next upgrade
surprising.

**C is the case where wrapping cost nothing**, and it is worth naming as the contrast.
`createBashTool` runs on `ExecutionEnv.exec`; our `exec` is the adapter, so pi never sees
Rust, Windows job objects, or the deny list. Same rule, opposite outcome, because the
seam already existed.

**E is deferred, not rejected.** `loadSkills` works and is cheap. But skills compose with
*profiles*, and profiles do not exist yet — adopting the loader now widens the upgrade
surface for a feature with no consumer. It comes back with profiles.

### 3. The prerequisite — resolved, as its own slice

Settled while this ticket was open. The persistent harness shipped as **slice 16**, ahead
of `JsonlSessionRepo` rather than with it. Splitting them was the right call for a reason
that only showed up afterwards: when `Stop` turned out to be broken — `rustFetch` ignored
`AbortSignal`, so `harness.abort()` never settled — it broke in a slice small enough to
find it in. Landed together with session persistence, that bug would have had two
plausible homes.

The `compacted` claim in `docs/DEVLOG.md` was corrected in place, with a
`> **Corrected later.**` block rather than an edit, per this map's habit of leaving wrong
answers visible.

### 4. Catalog — machinery in, entries out

Take **`calculateCost`, `getSupportedThinkingLevels`, `clampThinkingLevel`**. Keep
hand-written model entries.

The two alternatives are both refused:

- **`fetchModels` against a live endpoint** — a network call at startup, and a startup
  failure mode, for data that moves monthly.
- **Catalog-as-default-with-user-override** — refused because `deepseek-reasoner` is
  absent from 0.83.0's catalog entirely, and `thinkingLevel: "medium"` maps to `null` for
  the deepseek models it *does* ship. The default is wrong for the model actually in use.
  A default that is wrong for the primary case is a bug with a fallback attached.

This removes the one genuine duplication the survey found: `SHAPES` and `modelFor()` in
`src/agent/provider.ts` hand-write pricing and thinking-level logic that `pi-ai` already
has. The *entries* stay ours; the arithmetic over them does not.

### 5. The command system is not a ticket — deleted from the queue

Its builtin half is a lookup table over `compact()` / `setModel` / `setThinkingLevel`,
all of which now exist on a harness that outlives the turn. Its user half is one call to
`promptFromTemplate`. Nothing in either half is a decision, so there is nothing to grill.
It falls out of group D and ships alongside it.

This is the ticket answering the question that created it. The slash-command plan that
prompted *"shouldn't the pi agent package we use have these features?"* is now a lookup
table, and the four sessions between the question and this line were spent discovering
that.

### 6. The compaction fog entry closes provisionally

`DEFAULT_COMPACTION_SETTINGS` ships untouched. The map's fog entry *"whether pi's
compaction defaults need touching"* closes on the answer **no, not yet** — and reopens the
first time a real session compacts badly. Tuning defaults that have not been observed
failing is guessing with extra steps.

### 7. No forking UI in v1

The data model is in and costs nothing to carry. A branch view, a session picker and a
fork affordance are three UI surfaces, and core hands over storage and a tree but nobody
hands over React. Storage sits there until someone asks for the feature twice.

### What this closes and what it opens

Deleted from the queue: **the command system**, **forking UI**.
Opened: **[ticket 16 — compaction and the context meter](16-compaction.md)**.
Deferred with a named trigger: **skills** (returns with profiles), **compaction defaults**
(returns on first bad summary).
