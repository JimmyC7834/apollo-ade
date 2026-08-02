# Research: agent harness architectures — `pi` vs. Claude Code

Date: 2026-08-01. Subject repo: `pi/` at monorepo version `0.83.0` (all packages lockstep; `pi/package.json`).

---

## 1. Scope note

**`claude-code/` was excluded from this research entirely.** No file under that directory was opened, grepped, or cited. It is a third-party republication of leaked proprietary Anthropic source, self-described as such and licensed `UNLICENSED`. Analysing it would mean deriving conclusions from material we have no licence to read, and any architectural claim sourced from it would be unusable.

Consequently the two halves of this note are **not symmetric in evidence quality**:

- The **pi** section is grounded in primary source. Every structural claim carries a `pi/path/file.ts:LINE` citation, and where I am inferring rather than reading I say "inferred".
- The **Claude Code** section is grounded **only in Anthropic's public documentation** (`code.claude.com/docs`, which `docs.claude.com/en/docs/claude-code/*` now 301-redirects to). It therefore describes the **documented surface** — the contract Anthropic publishes — not internals. Where the docs are silent, this note says so rather than guessing.

A comparison between "read the code" and "read the docs" is inherently lopsided. I have tried to compare like with like by restricting the pi side of the comparison table to things that have a documented counterpart.

---

## 2. pi: how it works

### 2.1 Package layout

`pi` is an npm workspace monorepo, MIT licensed (`pi/README.md:107`), with nine packages under `packages/`. All ship at one lockstep version (`pi/AGENTS.md:122`).

| Package | npm name | Role | Deps on siblings |
|---|---|---|---|
| `ai` | `@earendil-works/pi-ai` | Multi-provider LLM API. Also ships a `pi-ai` CLI. | none |
| `agent` | `@earendil-works/pi-agent-core` | Agent runtime: the loop, tool contract, state. | `pi-ai` |
| `tui` | `@earendil-works/pi-tui` | Terminal UI framework, differential rendering. | none |
| `protocol` | `@earendil-works/pi-protocol` | CBOR codec + length-prefixed framing + schemas. | none |
| `client` | `@earendil-works/pi-client` | Transport-neutral client for remote pi sessions. | `pi-protocol` |
| `server` | `@earendil-works/pi-server` | Session server (explicitly **experimental**). | `pi-ai`, `pi-coding-agent`, `pi-protocol` |
| `coding-agent` | `@earendil-works/pi-coding-agent` | **The CLI.** `bin: { pi: dist/cli.js }`. | all of the above |
| `evals` | `@earendil-works/pi-evals` | Eval harness (`vitest-evals`), devDeps only. | — |
| `storage` | (no package.json; only `sqlite-node/`) | Storage backend scaffolding for the v2 harness. | — |

Dependency direction is strictly acyclic and bottom-up: `ai` and `tui` are leaves; `agent` sits on `ai`; `coding-agent` sits on everything. Package manifests: `pi/packages/*/package.json`.

Rough size (source lines, excluding tests): `coding-agent` ~56.7k, `ai` ~21.4k, `tui` ~14.2k, `agent` ~10.4k, `server` ~4.3k, `client`/`protocol` ~1.2k each. The CLI is by far the largest thing in the repo — the harness core is small and the *product* is big.

```
                 ┌───────────┐
                 │  pi-tui   │ (leaf, no agent knowledge)
                 └─────┬─────┘
 ┌────────┐            │
 │ pi-ai  │────┐       │
 └────────┘    ▼       │
          ┌──────────┐ │      ┌─────────────┐
          │pi-agent- │ │      │ pi-protocol │
          │  core    │ │      └──────┬──────┘
          └────┬─────┘ │             │
               ▼       ▼             ▼
          ┌─────────────────────────────────┐
          │      pi-coding-agent  (CLI)     │◄── pi-client / pi-server
          └─────────────────────────────────┘
```

Entrypoint: `pi/packages/coding-agent/src/cli.ts:20` calls `main(process.argv.slice(2))` from `main.ts` after configuring an undici dispatcher (`cli.ts:18`).

### 2.2 Two generations of harness live side by side

This is the single most important structural fact about the repo, and it is easy to miss.

- **Shipping path (v1):** `Agent` class at `pi/packages/agent/src/agent.ts:1`, driven by `runAgentLoop` in `agent-loop.ts`. `coding-agent` constructs it directly at `pi/packages/coding-agent/src/core/sdk.ts:294` (`agent = new Agent({...})`) and wraps it in `AgentSession` (`core/agent-session.ts`, 3332 lines). Session persistence, compaction, and extensions are all `coding-agent`-owned in this path — note `coding-agent` has its **own** copy of compaction at `core/compaction/compaction.ts` separate from the one in `packages/agent`.
- **In-progress path (v2):** `AgentHarness` class at `pi/packages/agent/src/harness/agent-harness.ts:173`, a durable, session-owning harness with its own tools, session store (JSONL / memory / SQLite), compaction, and hook bus. Design doc: `pi/packages/agent/docs/harness-v2.md`. **Nothing in `coding-agent/src` imports `AgentHarness`** — the only sibling imports from `pi-agent-core` into the CLI are `Agent`, `AgentMessage`, `AgentTool`, `ThinkingLevel`, etc. (`sdk.ts:2`, and the import list across `coding-agent/src/core/*`).

So the code you read in `packages/agent/src/harness/` describes where pi is going, not what `pi` the CLI does today. The rest of this section is explicit about which path each claim belongs to.

### 2.3 The agent loop (v1, the shipping one)

Lives entirely in `pi/packages/agent/src/agent-loop.ts` (793 lines). It is provider-agnostic — it never imports a provider SDK; the LLM call is a injected `StreamFn` (`pi/packages/agent/src/types.ts:28`).

**Entry points.** `agentLoop()` (`agent-loop.ts:31`) starts a run with new prompt messages; `agentLoopContinue()` (`agent-loop.ts:64`) resumes from existing context for retries and refuses to continue from an `assistant` message (`agent-loop.ts:74`). Both return an `EventStream<AgentEvent, AgentMessage[]>` that terminates on the `agent_end` event (`agent-loop.ts:145-150`).

**Loop shape.** `runLoop()` (`agent-loop.ts:155`) is a nested double loop:

- Inner loop (`agent-loop.ts:174`) runs while `hasMoreToolCalls || pendingMessages.length > 0`. Each iteration: emit `turn_start`, inject any pending **steering** messages (`agent-loop.ts:182-190`), stream one assistant response, execute its tool calls, emit `turn_end`, then call `prepareNextTurn` and `shouldStopAfterTurn` hooks (`agent-loop.ts:232`, `:248`).
- Outer loop (`agent-loop.ts:170`) catches the case where the agent would stop: it polls `getFollowUpMessages()` (`agent-loop.ts:263`) and restarts the inner loop if the user queued something.

**Termination** happens in exactly three ways:
1. `stopReason === "error" | "aborted"` on the assistant message → emit `turn_end`, `agent_end`, return (`agent-loop.ts:196-200`).
2. `shouldStopAfterTurn` returns true (`agent-loop.ts:247`).
3. No tool calls, no steering messages, no follow-up messages → break out of the outer loop (`agent-loop.ts:271`).

There is **no max-turns and no cost/budget cap in the loop.** I grepped: `AgentLoopConfig` (`types.ts:144-287`) has no such field. Runaway control is the caller's job via `shouldStopAfterTurn`.

**Streaming.** `streamAssistantResponse()` (`agent-loop.ts:281`) applies `transformContext` (AgentMessage → AgentMessage), then `convertToLlm` (AgentMessage → provider `Message[]`) (`agent-loop.ts:288-295`), resolves the API key *per call* so expiring OAuth tokens work (`agent-loop.ts:305`), then iterates provider events. The partial assistant message is pushed into `context.messages` on `start` and **replaced in place** on every delta (`agent-loop.ts:321`, `:337`), so the transcript array always holds the current partial. Event types forwarded: `text_*`, `thinking_*`, `toolcall_*` as `message_update` (`agent-loop.ts:326-344`).

**The truncation guard is a nice detail.** If `stopReason === "length"`, *every* tool call in that message is failed without executing, because the streamed tool-call arguments are finalized by a best-effort JSON salvage parser and can validate while being silently incomplete (`agent-loop.ts:211-213`, implemented at `:381-406`). The model is told to re-issue.

**Two-phase message representation.** The loop works in `AgentMessage` throughout and only converts to provider `Message[]` at the LLM boundary (`agent-loop.ts:1-4`, `types.ts:319`). `AgentMessage` is `Message | CustomAgentMessages[keyof CustomAgentMessages]`, where apps add custom message kinds by TypeScript declaration merging (`types.ts:310-319`). That is how `coding-agent` gets UI-only entries (bash executions, compaction summaries) into the transcript without them reaching the provider.

### 2.4 Tool system

**Definition.** `AgentTool` (`pi/packages/agent/src/types.ts:380-403`) extends `pi-ai`'s `Tool<TParameters>` with a `label`, an `execute(toolCallId, params, signal, onUpdate)`, an optional `prepareArguments` compat shim, and an optional per-tool `executionMode: "sequential" | "parallel"`. Schemas are **TypeBox** (`typebox` is a direct dep of `agent`, `ai`, `protocol`, and `coding-agent`). Example: the read tool's schema is a plain `Type.Object({ path, offset?, limit? })` at `pi/packages/coding-agent/src/core/tools/read.ts:20-24`.

**Validation.** Arguments go through `validateToolArguments(tool, toolCall)` (`pi/packages/ai/src/utils/validation.ts:278`), which structured-clones the args, runs TypeBox `Value.Convert` coercion, falls back to a JSON-Schema coercion path for non-TypeBox schemas (`validation.ts:283-295`), and on failure returns a formatted per-path error list plus the received arguments (`validation.ts:301-307`). That error string becomes the tool result the model sees.

**Dispatch.** `prepareToolCall()` (`agent-loop.ts:600`) resolves the tool by name from `context.tools` (unknown name → immediate error result, `:607-614`), applies `prepareArguments`, validates, then calls the `beforeToolCall` hook. Execution is **parallel by default** (`types.ts:261`), but `executeToolCalls()` (`agent-loop.ts:411`) downgrades the whole batch to sequential if *any* called tool declares `executionMode: "sequential"` (`agent-loop.ts:419-424`). In parallel mode, preparation is still sequential and only execution is concurrent; `tool_execution_end` fires in completion order while the tool-result *messages* are emitted in assistant source order (`agent-loop.ts:540-548`, documented at `types.ts:36-41`).

**Results.** `AgentToolResult<T>` (`types.ts:355-369`) carries `content` (text/image blocks for the model), `details` (arbitrary structured payload for logs/UI), optional `usage`, `addedToolNames` (tools that become available from this transcript point onward), and `terminate`. A batch only ends the run early when **every** finalized result sets `terminate` (`agent-loop.ts:582-584`). Tools throw on failure rather than encoding errors in content (`types.ts:388`); the loop catches and converts (`agent-loop.ts:697-706`). `onUpdate` streams partial results as `tool_execution_update` events and is fenced off once the tool promise settles (`agent-loop.ts:671-695`).

**Built-in tool set (coding-agent).** Seven tools, defined in `pi/packages/coding-agent/src/core/tools/index.ts:83-84`:

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

Curated bundles: `createCodingTools` = read/bash/edit/write (`index.ts:168-175`), `createReadOnlyTools` = read/grep/find/ls (`index.ts:177-184`). **The default active set is only four**: `["read", "bash", "edit", "write"]` (`pi/packages/coding-agent/src/core/sdk.ts:245`); grep/find/ls exist but are off by default. Each tool also has a "definition" form (`createXToolDefinition`) used by the extension system. `packages/agent` ships its own leaner tool set (bash/edit/read/write only, `pi/packages/agent/src/harness/tools/index.ts`) for the v2 harness.

Notably absent from the built-in set: any web fetch/search tool, any todo/task tool, any subagent-spawning tool.

### 2.5 Model / provider abstraction

This is the deepest part of pi and the most obviously a first-class product in its own right (`packages/ai` also ships a standalone `pi-ai` CLI).

**Three layers.**
1. **API** (`pi/packages/ai/src/api/*.ts`) — wire-protocol implementations. Ten known APIs (`pi/packages/ai/src/types.ts:16-26`): `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, `pi-messages`. Each module exports exactly `stream` and `streamSimple` and therefore structurally satisfies `ProviderStreams` (`types.ts:236-239`, with the contract spelled out at `:230-235`). `Api` is `KnownApi | (string & {})` so custom APIs are representable (`types.ts:28`). Each has a `.lazy.ts` wrapper so provider SDKs are not loaded until used.
2. **Provider** (`pi/packages/ai/src/providers/*.ts`) — ~45 providers, each a small file binding an id/baseUrl/auth/model-list to an API. Anthropic is 47 lines (`providers/anthropic.ts`): it declares an API-key auth strategy resolving from stored credential → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` (`anthropic.ts:18-32`), plus a lazily-loaded OAuth strategy for Claude Pro/Max (`anthropic.ts:44`). Registered in `providers/all.ts`. There is also a `faux` provider (`providers/faux.ts`, 16 KB) used as the test double.
3. **Models** (`pi/packages/ai/src/models.ts`) — `Models.streamSimple(model, context, options)` (`models.ts:185`, dispatch at `:512-516`) picks the provider and forwards. `Model<TApi>` (`types.ts:761-787`) carries `contextWindow`, `maxTokens`, `cost` (with tiered pricing), `thinkingLevelMap`, `input: ("text"|"image")[]`, and API-specific `compat` overrides. Model metadata is code-generated into `models.generated.ts` (never hand-edited — `pi/AGENTS.md:24`).

**The seam.** The agent core touches none of this. `StreamFn` (`agent/src/types.ts:28-32`) is the only contract, and its documented invariant is that it must **never throw**: failures must come back inside the stream as an assistant message with `stopReason: "error" | "aborted"` (`types.ts:23-27`). `packages/agent` does not depend on `pi-ai/compat`; `coding-agent` injects `streamSimple` as the default at `sdk.ts:36` purely as a back-compat shim for extensions that build `Agent` instances without one.

**Auth/config resolution** is `coding-agent`'s job: a `ModelRuntime` reads `~/.pi/agent/auth.json` and `models.json` (`sdk.ts:174-176`), then model selection falls back through session-restored model → settings default → provider default (`sdk.ts:192-222`). Because the key is resolved per request (`agent-loop.ts:305`), expiring tokens survive long tool phases.

### 2.6 Permissions and safety — pi has no permission system

This is a deliberate, documented design position, and the code matches it.

`pi/README.md:39`: *"Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it."*

`pi/SECURITY.md:50` lists *"Local code execution or sandboxing behavior (the Pi coding agent intentionally does not have a sandbox)"* as **out of scope** for security reports, alongside prompt injection (`SECURITY.md:56`), extension/skill behavior (`SECURITY.md:51`), and untrusted repositories (`SECURITY.md:52`). `pi/packages/coding-agent/docs/security.md:35` gives the reasoning: *a partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code.*

**What actually exists in the code:**

1. **A generic pre-execution hook, not a permission gate.** `beforeToolCall` on `AgentLoopConfig` (`agent/src/types.ts:271`) can return `{ block: true, reason }`, and the loop converts that into an error tool result (`agent-loop.ts:619-642`). `coding-agent` wires it to the extension bus: `this.agent.beforeToolCall = ... runner.emitToolCall({...})` at `pi/packages/coding-agent/src/core/agent-session.ts:469-476`. **Out of the box no extension is registered, so nothing blocks anything.** The mechanism is there; the policy is not. A confirmation flow is explicitly listed as something you build yourself (`packages/coding-agent/README.md:499`).
2. **Project trust — an input-loading guard, not an execution guard.** `resolveProjectTrusted()` (`pi/packages/coding-agent/src/core/project-trust.ts:46`) decides whether to load `.pi/settings.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md`, and project `.agents/skills` (list at `docs/security.md:9-14`). Decision order: `--approve/--no-approve` override → does the project even have trust-requiring resources → an extension's `project_trust` handler (first yes/no wins, `project-trust.ts:54-70`) → saved decision in `~/.pi/agent/trust.json` → `defaultProjectTrust` setting (`"ask"` default) → interactive prompt (`project-trust.ts:72-95`). No UI available and no saved decision → `false` (`project-trust.ts:86-88`). `docs/security.md:7` states plainly: *"It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory."* `AGENTS.md`/`CLAUDE.md` context files load **regardless** of trust (`docs/security.md:27`).
3. **Containment is delegated to the OS.** `README.md:41-45` documents three patterns: a Gondolin micro-VM extension that routes built-in tools and `!` commands into a Linux micro-VM while keeping `pi` and provider auth on the host; plain Docker; and OpenShell. Details in `packages/coding-agent/docs/containerization.md`.

Where pi *does* invest in security is **supply chain**, and heavily: exact-pinned direct deps, `save-exact=true` + `min-release-age=2` in `.npmrc`, a generated `npm-shrinkwrap.json` for the published CLI, `--ignore-scripts` everywhere including self-update, an explicit allowlist for dependency lifecycle scripts, and scheduled `npm audit` (`README.md:75-87`). That is a coherent stance: guard what gets *installed*, not what the model does once running.

### 2.7 Context management

Present, and reasonably sophisticated. Two implementations (see §2.2); the shipping one is `pi/packages/coding-agent/src/core/compaction/`.

**Budgeting.** `estimateContextTokens(messages)` (`pi/packages/agent/src/harness/compaction/compaction.ts:230`) prefers ground truth over estimation: it finds the most recent assistant message with non-zero, non-error usage and adds character-based estimates only for messages *after* it (`compaction.ts:246-258`). Images are charged a flat `ESTIMATED_IMAGE_CHARS = 4800` (`compaction.ts:265`).

**Trigger.** `shouldCompact(contextTokens, contextWindow, settings)` returns `contextTokens > contextWindow - settings.reserveTokens` (`compaction.ts:263-266`). Defaults: `reserveTokens: 16384`, `keepRecentTokens: 20000`, `enabled: true` (`compaction.ts:174-178`). The CLI checks this after each turn inside `prepareNextTurnWithContext` (`agent-session.ts:526`), with two paths: an **overflow** path when the provider itself reported context overflow (`agent-session.ts:2010`) and a **threshold** path (`agent-session.ts:2038`). The threshold path has a guard against re-compacting immediately after a compaction: if the usage-bearing message predates the last compaction entry, its usage is stale and reflects the old larger context, so it is ignored (`agent-session.ts:2022-2032`).

**Mechanism.** `prepareCompaction()` selects what to summarize and computes `tokensBefore` (`compaction.ts:640-708`); `compact()` calls the model for a summary (`compaction.ts:733`) with retry policy and retry callbacks. Compaction extracts **file operations** — which files were read, which modified — from the compacted span and carries them forward across successive compactions (`compaction.ts:47-68`), so the summary keeps a durable file-touch ledger rather than losing it. The result is appended as a `compaction` session entry with `summary`, `firstKeptEntryId`, `tokensBefore`, `details`, and `retainedTail` (`agent-harness.ts:820-828` for the v2 shape).

**Extension override.** The `session_before_compact` hook can cancel compaction or supply its own summary wholesale (`agent-harness.ts:796-806`); the entry records `fromHook` so downstream file-list accumulation skips hook-provided summaries (`compaction.ts:56`).

**Branch summarization.** Separate from compaction: `navigateTree()` (`agent-harness.ts:842`) walks the session tree to another node, optionally generating a summary of the abandoned branch via `generateBranchSummary` (`compaction/branch-summarization.ts`), and appends it as a `branch_summary` entry.

### 2.8 Sub-agents, hooks/extensions, MCP

**Sub-agents: absent from core.** `packages/coding-agent/README.md:497`: *"**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way."* Also `docs/usage.md:301`. There is a worked **example** extension at `pi/packages/coding-agent/examples/extensions/subagent/` (with `agents/worker.md` and prompt templates), which is a demonstration, not a shipped feature.

**MCP: absent, deliberately.** `packages/coding-agent/README.md:495`: *"**No MCP.** Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."* Grepping the whole `packages/` tree for `mcp` returns only `README.md`, `docs/usage.md`, and one unrelated settings test — **no MCP implementation exists**. `docs/usage.md:301` groups it with the other omissions: *"It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash."*

**Extensions: the one extension point, and it is very wide.** This is where pi puts everything the other tools bake in.

- Extensions are **TypeScript modules loaded in-process** and run with the same permissions as pi (`docs/security.md:33`). Loading uses `jiti` (a direct dep of `coding-agent`).
- Discovery order (`pi/packages/coding-agent/src/core/extensions/loader.ts:665-705`): project-local `<cwd>/.pi/extensions/` → global `~/.pi/agent/extensions/` → explicitly configured paths (`-e` flags / settings), each deduped by resolved path.
- The event surface is large. `ExtensionEvent` is a 25-member union (`pi/packages/coding-agent/src/core/extensions/types.ts:1034-1059`): `project_trust`, `resources_discover`, `session`, `context`, `before_provider_request`, `before_provider_headers`, `after_provider_response`, `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start/update/end`, `model_select`, `thinking_level_select`, `user_bash`, `input`, `tool_call`, `tool_result`.
- Handlers can **change behaviour, not just observe**: `ContextEventResult` rewrites the message list (`types.ts:1065-1067`), `ToolCallEventResult` blocks a tool (`types.ts:1071-1075`), `ToolResultEventResult` rewrites content/details/isError/usage (`types.ts:1085-1090`), `MessageEndEventResult` replaces a finalized message (`types.ts:1092-1094`), `UserBashEventResult` can substitute the bash implementation or the whole result (`types.ts:1078-1083`) — that last one is how the Gondolin micro-VM extension redirects execution.
- Extensions also register tools (`defineTool`, `types.ts:509-513`; `RegisteredTool`, `wrapRegisteredTools` in `extensions/wrapper.ts`), slash commands, autocomplete providers, custom editors, keybindings, entry/message renderers, markdown transformers, widgets, and **entire LLM providers** (`ProviderConfig`, `ProviderModelConfig` in the export list at `extensions/index.ts:113-115`).

**Skills** are the lightweight, non-code extension mechanism: `SKILL.md` files discovered by directory scan (`pi/packages/coding-agent/src/core/skills.ts:161-220`, recursing until a `SKILL.md` is found, then stopping), formatted into the system prompt via `formatSkillsForPrompt` (`skills.ts:335`) and only when the `read` tool is available (`core/system-prompt.ts:64`, `:155`). The format follows the agentskills.io convention (`skills.ts:330`). Skills honour `disableModelInvocation` to stay out of context (`skills.ts:336`).

**Prompt templates** are the slash-command analogue: markdown files invoked via `formatPromptTemplateInvocation` (`agent/src/harness/prompt-templates.ts`, used at `agent-harness.ts:739`). The pi repo dogfoods this — `pi/.pi/prompts/` holds `cl.md`, `is.md`, `pr.md`, `sa.md`, `wr.md`, and `pi/.pi/skills/add-llm-provider.md` is a skill for adding a provider.

**Pi packages** are the distribution unit that bundles extensions/skills/prompts/themes for sharing (`README.md:396`, `docs/packages.md`).

### 2.9 UI layer

`packages/tui` is a **standalone terminal UI framework with zero agent knowledge** — its only runtime deps are `get-east-asian-width` and `marked` (`packages/tui/package.json`). It provides two interchangeable renderers behind one `TUI` interface: `TuiMainScreen` (terminal scrollback) and `TuiAltScreen` (application-owned viewport with mouse/keyboard scrolling), plus differential rendering, CSI 2026 synchronized output, bracketed paste, and a component set (Text, Editor, Markdown, SelectList, ScrollView, Image, VStack/HStack, …) — `packages/tui/README.md:1-20`, sources under `packages/tui/src/components/`.

The agent side consumes it in `pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts` — 6125 lines, which instantiates `ProcessTerminal` and picks a renderer at `interactive-mode.ts:341-345`. That file is by far the biggest in the repo and is where the separation gets muddier: the `read` tool imports TUI `Text` and the interactive theme directly (`core/tools/read.ts:4`, `:10`), so tool *rendering* is not fully decoupled from tool *logic*. `pi/tui-plan.md` (35 KB) is the design handoff for the alt-screen constrained layout system that keeps the transcript scrollable while pinning the editor/footer.

Three other run modes exist alongside interactive: `print-mode.ts` (159 lines, `-p`), `rpc/rpc-mode.ts` (816 lines, JSONL RPC), and a `json` mode — enumerated as `AppMode = "interactive" | "print" | "json" | "rpc"` at `core/project-trust.ts:12`.

### 2.10 Persistence

Sessions are **append-only JSONL trees**, format version 3 (`pi/packages/coding-agent/src/core/session-manager.ts:30`).

- Location: `~/.pi/agent/sessions/<encoded-cwd>/`, where the cwd is encoded into a safe directory name (`session-manager.ts:474-480`).
- File header: `{ type: "session", version, id, timestamp, cwd, parentSession? }` (`session-manager.ts:32-39`).
- Every entry carries `{ type, id, parentId, timestamp }` (`SessionEntryBase`, `session-manager.ts:46-51`) — **`parentId` is what makes it a tree rather than a log**, which is what enables branching, rewind, and fork.
- Entry types (`session-manager.ts:144-155`): `message`, `thinking_level_change`, `model_change`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`.
- Resume rebuilds state by replaying the branch: `buildSessionContext()` yields messages plus the last model and thinking level, and `sdk.ts:187-190` uses that to decide whether a session is being continued, restoring the model if its auth is still configured (`sdk.ts:196-204`) and otherwise emitting a fallback message.

Writes are ordered carefully against the loop: the harness/session defers mutations that arrive mid-turn into a `pendingSessionWrites` queue and flushes at turn boundaries (`agent-harness.ts:554-578`, drained on `turn_end` at `:594` and `agent_end` at `:600`) so a model change made while streaming doesn't interleave into the transcript at the wrong point.

The v2 path generalises this behind a `SessionStore` interface with JSONL, in-memory, and SQLite backends (`pi/packages/agent/src/harness/session/jsonl-store.ts`, `memory-store.ts`, and `packages/storage/sqlite-node/`), with a `KeyedOperationQueue` bounding concurrency to 4 operations by default (`jsonl-store.ts:20`, `:38`). The stated compatibility policy is that only v3 JSONL sessions must keep opening; everything else in the v2 harness may break without migrations (`packages/agent/docs/harness-v2.md:3`).

Session export to HTML exists (`core/export-html/`), and `pi-share-hf` publishes sessions to Hugging Face (`README.md:97`).

### 2.11 Testing

Vitest, 389 test files against 642 source files — a high ratio.

Distribution: `coding-agent` 197, `ai` 122, `tui` 30, `agent` 20, `server` 7, `client` 6, `evals` 4, `protocol` 3.

- `pi/vitest.base.ts` aliases every `@earendil-works/*` import to the **package's `src/index.ts`**, so tests run against sources, not built output.
- `pi/test.sh` is the sanctioned runner and is unusually hygienic: it mkstemps an isolated root, starts from `env -i` with a hand-listed allowlist (`HOME`, `TMPDIR`, `XDG_*`, `LANG=C`, `TZ=UTC`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ASKPASS=false`, npm config redirects, `PI_NO_LOCAL_LLM=1`), and refuses to `rm -rf` a directory that doesn't carry its own `.pi-test-owned` marker (`test.sh:20-35`). The point is that tests can't read the developer's real credentials or config, and skip LLM-dependent tests without API keys.
- No live-provider tests in the default path: `AGENTS.md:32` mandates `packages/coding-agent/test/suite/` use `test/suite/harness.ts` plus the **faux provider** (`packages/ai/src/providers/faux.ts`) — "No real provider APIs, keys, or paid tokens."
- Issue regressions get their own convention: `test/suite/regressions/<issue-number>-<slug>.test.ts` (`AGENTS.md:33`).
- `packages/evals` uses `vitest-evals` for behavioural evaluation, kept as devDeps so it doesn't ship.
- Coverage tooling (`@vitest/coverage-v8`) is only wired into `packages/agent`. I did **not** find a coverage threshold gate; `npm run check` is lint/format/typecheck and explicitly does not run tests (`AGENTS.md:28`).

### 2.12 One full turn, end to end (v1 path)

User types "fix the failing test" in interactive mode.

1. `interactive-mode.ts` reads the line through the TUI editor and calls into `AgentSession` (`core/agent-session.ts`).
2. `AgentSession` builds the system prompt via `buildSystemPrompt()` (`core/system-prompt.ts:28`): a fixed preamble naming the available tools with one-line snippets (`system-prompt.ts:121-138`), guidelines, then `<project_context>` blocks for each loaded `AGENTS.md`/`CLAUDE.md` (`system-prompt.ts:145-152`), then the skills section if `read` is active (`:155-157`), then `Current working directory:` (`:159`).
3. It appends the user message to the session JSONL and calls `Agent.prompt()`, which enters `runAgentLoop` (`agent-loop.ts:95`). Events `agent_start`, `turn_start`, `message_start`/`message_end` for the prompt are emitted (`agent-loop.ts:109-114`).
4. `streamAssistantResponse` (`agent-loop.ts:281`) runs `transformContext` → the extension `context` hook (`sdk.ts:350-354`), then `convertToLlm`, which also strips images to a placeholder if `blockImages` is set (`sdk.ts:256-290`).
5. The injected `streamFn` (`sdk.ts:302-330`) resolves retry/timeout settings, merges provider attribution headers, gives extensions a shot at the outgoing headers and payload (`sdk.ts:318-337`), and calls `ModelRuntime.streamSimple` → `Models.streamSimple` (`ai/src/models.ts:512`) → the provider's API module.
6. Deltas arrive; the partial assistant message is replaced in place and `message_update` events drive the TUI's differential render (`agent-loop.ts:326-344`).
7. Model returns a `bash` tool call. `executeToolCalls` (`agent-loop.ts:411`) sees `bash` and — because file-mutating tools are wrapped by `withFileMutationQueue` and the bash tool declares its execution mode — runs the batch sequentially or in parallel accordingly (`agent-loop.ts:419-425`).
8. `prepareToolCall` (`agent-loop.ts:600`) validates arguments against the TypeBox schema and fires `beforeToolCall` → `runner.emitToolCall` (`agent-session.ts:469`). **With no extension installed this returns undefined and the command runs.**
9. The tool executes with the abort signal, streaming partials through `onUpdate` (`agent-loop.ts:675-693`). `afterToolCall` → `runner.emitToolResult` can rewrite the result (`agent-session.ts:490-496`).
10. A `toolResult` message is constructed (`agent-loop.ts:773-787`), pushed into context and into the session JSONL on `message_end` (`agent-harness.ts:581-584` for the v2 equivalent; v1 does it in `AgentSession`'s event subscription).
11. `turn_end` fires. `prepareNextTurnWithContext` (`agent-session.ts:526`) runs the auto-compaction check (`:2038`). If the context is over `contextWindow - 16384`, compaction runs now and the returned context for the next turn is the compacted one.
12. `hasMoreToolCalls` is true, so the inner loop iterates: `turn_start`, next assistant response. Steering messages the user typed while waiting are drained and injected before that response (`agent-loop.ts:182-190`).
13. Eventually the model returns text with no tool calls. `hasMoreToolCalls` is false, the queues are empty, the outer loop breaks, `agent_end` fires (`agent-loop.ts:274`), pending session writes flush, and the TUI returns to idle.

---

## 3. Claude Code: how it works (from public docs only)

Everything below is sourced from Anthropic's published documentation. It is the **documented contract**, not an internals description; where the docs describe *what* without *how*, this note stops there.

### 3.1 Positioning and surfaces

Claude Code is described as "an agentic coding tool that reads your codebase, edits files, runs commands, and integrates with your development tools", available in terminal, IDE extensions (VS Code, JetBrains), a desktop app, and the browser — <https://code.claude.com/docs/en/overview>. Anthropic's framing of the architecture: "Claude Code serves as the **agentic harness** around Claude: it provides the tools, context management, and execution environment that turn a language model into a capable coding agent" — <https://code.claude.com/docs/en/how-claude-code-works>.

Execution environments are documented as three: local (your machine), cloud (Anthropic-managed VMs), and Remote Control (executes locally, driven from a browser) — <https://code.claude.com/docs/en/how-claude-code-works>. All surfaces are documented as sharing one engine, so CLAUDE.md, settings, and MCP servers carry across — <https://code.claude.com/docs/en/overview>.

### 3.2 The agent loop

Conceptually documented as three blended phases — gather context, take action, verify results — repeating until the task is done, interruptible at any point — <https://code.claude.com/docs/en/how-claude-code-works>.

Mechanically, the Agent SDK docs give the precise cycle, and state it is "the same execution loop that powers Claude Code" — <https://code.claude.com/docs/en/agent-sdk/agent-loop>:

1. Receive prompt (plus system prompt, tool definitions, history); emit `SystemMessage` subtype `"init"`.
2. Claude evaluates; emits `AssistantMessage` with text and/or tool calls.
3. SDK executes the requested tools, collects results, feeds them back; emits `UserMessage` with tool results.
4. Steps 2–3 repeat. **"Each full cycle is one turn."**
5. **Termination: "Claude continues calling tools and processing results until it produces a response with no tool calls."** Then a final `AssistantMessage` and a `ResultMessage`.

Explicit run caps are documented: `maxTurns` (counts tool-use turns only) and `maxBudgetUsd`, surfacing as `ResultMessage` subtypes `error_max_turns` / `error_max_budget_usd`, with subagent spend counting toward the budget — same page. Streaming is opt-in via `includePartialMessages`, yielding `StreamEvent` messages with raw API deltas.

Parallelism is documented as **tool-kind-dependent**: read-only tools (`Read`, `Glob`, `Grep`, and MCP tools marked read-only) may run concurrently; state-modifying tools (`Edit`, `Write`, `Bash`) run sequentially; custom tools default to sequential and opt in via `readOnlyHint` — same page.

### 3.3 Tool set

The canonical list is <https://code.claude.com/docs/en/tools-reference>, which notes the tool names are the exact strings used in permission rules, subagent tool lists, and hook matchers. It is a large surface — well beyond a coding core. Documented entries include:

- **Files/search/exec:** `Read`, `Edit`, `Write`, `NotebookEdit`, `Glob`, `Grep`, `Bash`, `PowerShell`, `Monitor` (background command whose output lines feed back to Claude), `LSP` (language-server code intelligence).
- **Web:** `WebFetch`, `WebSearch`.
- **Orchestration:** `Agent` (spawns a subagent with its own context window), `Skill`, `AskUserQuestion`, `EnterPlanMode`/`ExitPlanMode`, `SendMessage` (agent-team teammate or resume a subagent), `TaskStop`, `EndConversation`.
- **Task tracking:** `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskOutput`, `TodoWrite` (documented as disabled by default as of v2.1.142).
- **Scheduling:** `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`, `RemoteTrigger`.
- **Worktrees:** `EnterWorktree`, `ExitWorktree`.
- **MCP plumbing:** `ListMcpResourcesTool`, `ReadMcpResourceTool`, `WaitForMcpServers`, `ToolSearch`.
- **Output/notification:** `Artifact`, `PushNotification`, `SendUserFile`, `ReportFindings`.

Custom tools are added by connecting an MCP server; skills run through the existing `Skill` tool rather than adding tool entries — same page.

### 3.4 Permissions

Documented at <https://code.claude.com/docs/en/permissions>. This is the part with no counterpart in pi at all.

**Tiered defaults:** read-only tools need no approval inside the working directory; Bash needs approval except a built-in non-configurable read-only command set (`ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `diff`, `stat`, `du`, `cd`, read-only `git`); file modification always needs approval, and "yes, don't ask again" for edits only lasts until session end while Bash approvals persist per repository.

**Rules** are `allow` / `ask` / `deny`, evaluated **deny → ask → allow, first match wins, specificity does not reorder**. A bare tool name in `deny` removes the tool from Claude's context entirely; a scoped rule like `Bash(rm *)` leaves the tool present and blocks matching calls.

**Modes** (`defaultMode` in settings, `Shift+Tab` to cycle in the CLI): `default`/`manual`, `acceptEdits`, `plan`, `auto` (model-classifier approval), `dontAsk` (deny anything not pre-approved), `bypassPermissions`. `bypassPermissions` still prompts for explicit `ask` rules and keeps a circuit breaker on root/home removals such as `rm -rf /`. `permissions.disableBypassPermissionsMode` and `permissions.disableAutoMode` can turn those off, intended for managed settings.

**Syntax:** `Tool` or `Tool(specifier)`; Bash glob wildcards at any position with word-boundary semantics for `ls *` vs `ls*`; `WebFetch(domain:example.com)`; parameter matching `Tool(param:value)` for deny/ask (e.g. `Agent(model:opus)`), explicitly not allowed on a tool's primary content field because `Bash(command:rm *)` would be bypassable by a compound command. Compound commands are decomposed — a rule must match each subcommand independently, and approving a compound saves a rule per subcommand. A fixed, non-configurable wrapper-stripping list (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, bare `xargs`) is applied before matching, and the docs are explicit that env-runner wrappers like `devbox run` and `docker exec` are *not* stripped and therefore dangerous to allow with a prefix rule.

**The enforcement point is named:** "Permission rules are enforced by Claude Code, not by the model. Instructions in your prompt or `CLAUDE.md` shape what Claude tries to do, but they don't change what Claude Code allows."

**Sandboxing is a separate, complementary layer** — OS-level enforcement restricting the Bash tool's filesystem and network access, applying to Bash commands and their child processes; `sandbox.filesystem` settings merge with Read/Edit deny rules, and network restrictions merge WebFetch rules with `allowedDomains`/`deniedDomains` (<https://code.claude.com/docs/en/permissions> §"How permissions interact with sandboxing", detail at <https://code.claude.com/docs/en/sandboxing>). The docs are candid about the permission layer's limit: Read/Edit deny rules "don't apply to arbitrary subprocesses that read or write files indirectly, like a Python or Node script that opens files itself" — for that you need the sandbox.

**Checkpoints** are the complementary undo mechanism: file contents are snapshotted before edits, `Esc Esc` rewinds, separate from git, and explicitly do **not** cover remote side effects — <https://code.claude.com/docs/en/how-claude-code-works>.

### 3.5 Settings hierarchy

Four scopes — managed (server/plist/registry/`managed-settings.json`), user (`~/.claude/settings.json`), project (`.claude/settings.json`), local (`.claude/settings.local.json`) — with precedence managed > CLI args > local > project > user, and managed explicitly non-overridable — <https://code.claude.com/docs/en/settings>. Managed-only settings exist for locking down permissions, hooks, and MCP servers (`allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `allowManagedMcpServersOnly`, `sandbox.*.allowManaged*Only`). Most settings hot-reload; `model` and `outputStyle` are startup-only.

### 3.6 Hooks

<https://code.claude.com/docs/en/hooks>. Configured as `hooks.<EventName>[].matcher` + a list of handlers, from any settings scope plus plugin `hooks/hooks.json` and skill/agent frontmatter.

Documented events span session lifecycle (`SessionStart`, `Setup`, `SessionEnd`), per-turn (`UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`), the agentic loop (`PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`), subagents (`SubagentStart`, `SubagentStop`, `TeammateIdle`), tasks/context (`TaskCreated`, `TaskCompleted`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`), and worktrees (`WorktreeCreate`, `WorktreeRemove`).

Five handler types are documented — `command` (shell, JSON on stdin, decisions via exit code and stdout JSON), `http` (POST to a URL), `mcp_tool` (call a tool on a connected MCP server), `prompt` (ask a model for a yes/no), `agent` (spawn a subagent to verify, experimental).

Control semantics: exit 2 is a blocking error with stderr shown to Claude; `PreToolUse` returns `permissionDecision: allow|deny|ask`; `PermissionRequest` can return `updatedInput`; `PostToolUse` can return `updatedToolOutput` or `additionalContext`; a top-level `continue: false` stops the loop. `disableAllHooks` exists, and cannot disable managed hooks unless set at the managed level.

Critically for the comparison: hooks are **out-of-process** — command hooks are shell subprocesses, HTTP hooks are network calls. The SDK docs note hooks "run in your application process, not inside the agent's context window, so they don't consume context" — <https://code.claude.com/docs/en/agent-sdk/agent-loop>.

### 3.7 Sub-agents

<https://code.claude.com/docs/en/sub-agents>. Each subagent runs "in its own context window with a custom system prompt, specific tool access, and independent permissions", and only its final response returns to the parent as a tool result.

Definition format: Markdown files with YAML frontmatter (`name`, `description`, `tools`, `model`, plus permission modes, hooks, skills) in `.claude/agents/` (project) or `~/.claude/agents/` (user). Claude selects a subagent by matching its `description`.

Built-ins documented: `Explore` (read-only; Write/Edit denied; inherits the main model, capped at Opus on the Claude API; takes a thoroughness level of quick/medium/very thorough), `Plan` (read-only, used in plan mode), `general-purpose` (all subagent-available tools), plus `statusline-setup` and `claude-code-guide`. `Explore` and `Plan` skip CLAUDE.md and parent git status to stay cheap; every other subagent loads both.

They can be restricted through the same permission system — deny a specific type, or deny the `Agent` tool entirely — and disabled wholesale via `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` / `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`.

### 3.8 MCP

<https://code.claude.com/docs/en/mcp>. Four transports: HTTP, SSE, stdio (local subprocess), and WebSocket. Three configuration scopes with documented precedence local > project > user > plugin-provided > claude.ai connectors: **local** (`~/.claude.json`, keyed by project path, private), **project** (`.mcp.json` at repo root, committed and shared, with an explicit approval prompt before use and `claude mcp reset-project-choices` to reset), **user** (`~/.claude.json`, all projects). `.mcp.json` supports environment variable expansion. Tools are namespaced `mcp__<server>__<tool>`, which is also the form used by permission rules and hook matchers.

Context cost is addressed by **tool search**: MCP tool schemas are deferred by default and loaded on demand, so only names consume context until a tool is used — <https://code.claude.com/docs/en/how-claude-code-works> and the SDK context section.

### 3.9 Context management

<https://code.claude.com/docs/en/how-claude-code-works> and <https://code.claude.com/docs/en/agent-sdk/agent-loop>. Documented behaviour when the window fills: **clear older tool outputs first, then summarize the conversation**. Compaction emits a `compact_boundary` system message. `PreCompact`/`PostCompact` hooks bracket it. `/compact` triggers it manually, optionally with a focus. A "Compact Instructions" section in CLAUDE.md steers what is preserved (the header is matched on intent, not as a magic string). There is anti-thrashing behaviour: if a single huge file or output refills the context immediately after each summary, auto-compaction stops after a few attempts and errors rather than looping. Stable prefixes (system prompt, tool definitions, CLAUDE.md) are prompt-cached. Subagents and on-demand skill loading are documented as the *architectural* answer to context pressure, with compaction as the fallback.

### 3.10 Sessions

Conversations are written to plaintext JSONL under `~/.claude/projects/`, tied to the current directory; `--continue`/`--resume` reopen the same session ID and append, while `--fork-session`/`/branch` copy history into a new ID. Sessions are otherwise independent — each new session starts with a fresh context window, with `CLAUDE.md` and auto memory as the cross-session carriers — <https://code.claude.com/docs/en/how-claude-code-works>.

### 3.11 Agent SDK

<https://code.claude.com/docs/en/agent-sdk/overview>. Python and TypeScript libraries exposing "the same tools, agent loop, and context management that power Claude Code", running the loop in your own process. Documented capability parity covers built-in tools, hooks, subagents, MCP, permissions, sessions, skills/commands/memory loading from `.claude/` and `~/.claude/`, and plugins. Other languages are told to shell out to the CLI with `-p --output-format json`. Use is governed by Anthropic's Commercial Terms, and there are branding restrictions on SDK-built products.

### 3.12 What the docs deliberately don't say

The docs describe the harness as a black box with a rich configuration surface. They do not publish: the internal module layout, how tools are registered or schema-validated internally, the concrete permission-check call site, the compaction prompt, or the provider abstraction (multi-provider support is documented only as *which* backends are supported — Claude API, Bedrock, Vertex/Google Cloud Agent Platform, Microsoft Foundry, gateways — never as an extension seam). Any claim about those internals would have to come from the excluded directory, so this note makes none.

---

## 4. Differences

### 4.1 Comparison table

| Dimension | pi | Claude Code (documented) |
|---|---|---|
| **Licence / source** | MIT, full source public (`pi/README.md:107`) | Proprietary; docs public, source not |
| **Distribution** | npm `@earendil-works/pi-coding-agent`, plus standalone Bun binaries built from a signed release source archive (`README.md:62-73`) | Native installer, Homebrew, WinGet, apt/dnf/apk; auto-updating; also IDE/desktop/web surfaces |
| **Provider coupling** | Provider-agnostic by construction. ~45 providers, 10 wire APIs, one `StreamFn` seam (`agent/src/types.ts:28`) | Anthropic models only; "provider" choice means *hosting* (Claude API, Bedrock, Vertex, Foundry, gateway) |
| **Loop termination** | No tool calls + empty queues, or `shouldStopAfterTurn`, or error/abort (`agent-loop.ts:196-271`) | No tool calls; plus `maxTurns` / `maxBudgetUsd` caps (agent-sdk/agent-loop) |
| **Run caps** | **None in core.** No max turns, no budget | `maxTurns`, `maxBudgetUsd`, subagent spend counted |
| **Tool schemas** | TypeBox, validated + coerced in-process (`ai/src/utils/validation.ts:278`) | Not documented; tool *names* are the public contract (tools-reference) |
| **Built-in tools** | 7 (`read bash edit write grep find ls`), 4 active by default (`core/tools/index.ts:83`, `sdk.ts:245`) | ~40 documented, spanning files, web, LSP, tasks, cron, worktrees, artifacts, notifications, orchestration |
| **Permission gate** | **Absent.** A `beforeToolCall` hook exists (`agent-loop.ts:619`); no policy ships | First-class: allow/ask/deny rules, 6 modes, deny→ask→allow precedence, enforced by the harness not the model |
| **Sandbox** | **Absent, by design** (`SECURITY.md:50`); delegate to container/VM | OS-level sandbox for Bash and children, merged with permission rules |
| **Trust model** | Project trust gates *loading project config*, not execution (`core/project-trust.ts:46`, `docs/security.md:7`) | `.mcp.json` approval prompt, workspace trust, managed policy that users can't override |
| **Policy management** | None. Settings are user/project files | Managed settings via MDM/registry/server, `allowManaged*Only` locks |
| **Extensibility** | One mechanism: in-process TypeScript extensions, 25 events, can rewrite context/tools/results/providers/UI (`extensions/types.ts:1034`) | Many narrow mechanisms: hooks (out-of-process), MCP servers, skills, subagent files, plugins, settings |
| **MCP** | **Absent, deliberate** (`coding-agent/README.md:495`) | Core: 4 transports, 3 scopes, `mcp__server__tool` namespacing, tool search deferral |
| **Sub-agents** | **Absent, deliberate** (`coding-agent/README.md:497`); example extension only | Core: `Agent` tool, markdown-defined, own context window and permissions, built-in Explore/Plan/general-purpose |
| **Context handling** | Usage-anchored token estimate; compact when `tokens > window − 16384`; keep ~20k recent; carries a read/modified file ledger across compactions (`compaction.ts:174-178`, `:47-68`) | Clear old tool outputs first, then summarize; `compact_boundary` event; anti-thrash cutoff; CLAUDE.md "Compact Instructions"; subagents/skills as the primary lever |
| **Persistence** | Append-only JSONL **tree** (`parentId` per entry), v3, under `~/.pi/agent/sessions/<encoded-cwd>/`; branch summarization on tree navigation (`session-manager.ts:46-51`, `:474-480`) | JSONL under `~/.claude/projects/`; resume same ID, fork to new ID; checkpoints snapshot files before edits |
| **UI** | Own TUI framework as a dependency-free package (`packages/tui`) | Terminal, VS Code, JetBrains, desktop, web — one engine behind all |
| **Embeddable** | Yes: `createAgentSession()` SDK (`core/sdk.ts:169`), plus RPC/JSON/print modes | Yes: Agent SDK (Python/TS), headless `-p --output-format json`, Managed Agents |

### 4.2 Extensibility model — one wide seam vs. many narrow ones

pi has **one** extension mechanism and it is nearly unbounded: a TypeScript module loaded in-process with `jiti` that can subscribe to 25 events, rewrite the message list before every request (`ContextEventResult`), block or rewrite any tool call and result, replace the bash implementation entirely (`UserBashEventResult`), register tools, slash commands, editors, keybindings, renderers, widgets, **and whole LLM providers** (`extensions/index.ts:113-115`). MCP, sub-agents, permission popups, and plan mode are all documented as things you build with it (`coding-agent/README.md:495-501`).

Claude Code has **many** mechanisms, each narrower and each with a defined blast radius: hooks are out-of-process (shell, HTTP, MCP tool, prompt, or subagent) and can only return a fixed decision shape; MCP servers add tools over a standard protocol; skills add prompt-level workflows; subagents are markdown files; plugins bundle the above. None of them can replace the provider or rewrite the harness.

The trade is legible. pi's model is more powerful per unit of effort and gives you a genuine escape hatch — the Gondolin micro-VM extension redirecting all tool execution into a VM is something you simply cannot express as a Claude Code hook. It is also unbounded: an extension is arbitrary code in the agent's process with the agent's credentials, which is precisely why `SECURITY.md:51` puts extension behaviour out of scope. Claude Code's model constrains what an extension can do so that a policy administrator can reason about it — which is why `allowManagedHooksOnly` and `disableAllHooks` can exist at all.

### 4.3 Permission and trust model — the sharpest divergence

pi's position, stated plainly (`docs/security.md:35`): a partial in-process sandbox "would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary." So pi ships **no** permission prompts, **no** allowlists, **no** sandbox, and pushes containment entirely to Docker/micro-VM/OpenShell. What it ships instead is a `beforeToolCall` seam with nothing plugged into it and a project-trust gate that only controls *config loading*.

Claude Code takes the opposite bet: a defence-in-depth stack where each layer is honest about its limits. Permission rules are enforced by the harness rather than the model, and the docs say so explicitly. But they also concede that Read/Edit deny rules don't stop a Python script from opening a file — that is what the OS sandbox layer is for. And they concede that `Bash(devbox run *)` is a footgun because the wrapper-stripping list is fixed. Then checkpoints catch local file mistakes after the fact, and managed settings let an org lock the whole thing so a developer can't opt out.

Both are internally coherent. pi's is right if your deployment is "one developer, one trusted repo, or else a container". Claude Code's is right if you have a fleet, a compliance function, and no ability to mandate that every developer runs inside a VM. The pi answer scales badly to organisations because there is nothing an administrator can centrally enforce; the Claude Code answer costs a permission-prompt tax that pi users don't pay.

Note also who each project treats as the adversary. pi's `SECURITY.md` puts prompt injection, malicious model output, extensions, and untrusted repos all out of scope — but invests unusually heavily in supply chain (pinned deps, `min-release-age=2`, shrinkwrap, lifecycle-script allowlist, `--ignore-scripts` everywhere, scheduled audits, `README.md:75-87`). pi is defending against a compromised dependency, not a compromised prompt. Claude Code's documented posture defends against both, and adds the org-vs-developer axis that pi has no concept of.

### 4.4 Provider coupling — pi's real differentiator

`packages/ai` is 21.4k lines and a standalone product. Ten wire APIs, ~45 providers, generated model metadata with per-model cost tiers and thinking-level maps, per-request key resolution for expiring OAuth tokens, a faux provider for tests, and provider registration exposed to extensions. The agent core is genuinely decoupled: it imports no provider SDK, and the entire LLM surface is one injected function whose contract is "never throw, encode failures in the stream" (`agent/src/types.ts:23-27`).

Claude Code is Anthropic-model-only. Its documented "providers" are hosting choices for the same models, and the docs describe no seam for adding a different model family. This is not an oversight — a harness tuned for one model family can hard-code assumptions (prompt caching layout, thinking-level semantics, tool-call formats) that pi has to negotiate generically.

The cost of pi's genericity shows up in the code: `compat.ts` is 10 KB, `legacy-api-aliases.ts` is 6 KB, `Model.compat` is a conditional type with per-API override shapes (`ai/src/types.ts:779-787`), and there's a `constrained-sampling.ts` and a `transform-messages.ts` in the API layer. That's the tax for supporting Cerebras and Bedrock and llama.cpp behind one interface.

### 4.5 Context handling

pi's approach is arithmetic and conservative: anchor on the last real provider usage number rather than estimating (`compaction.ts:230-258`), compact when you're within 16k of the window, keep ~20k of recent context, and — the thoughtful bit — carry a ledger of files read and modified forward across every compaction so that information survives summarization (`compaction.ts:47-68`). It also guards against double-compaction by checking whether the usage figure predates the last compaction (`agent-session.ts:2022-2032`).

Claude Code's documented approach is staged and architectural: clear old tool outputs *before* summarizing, so the cheap fix is tried first; then summarize; emit a boundary event; give up rather than thrash if one giant output keeps refilling the window. But the docs consistently point at *avoiding* compaction: send exploration to a subagent with its own window, defer MCP schemas via tool search, load skill bodies only on invocation. pi has none of those levers — no subagents, no MCP, and skills load into the system prompt up front — so compaction is the only tool it has, which is presumably why its compaction is the more carefully engineered of the two.

### 4.6 Distribution and governance

pi publishes to npm plus reproducible Bun binaries from a SHA256-covered source archive (`README.md:62-73`), with npm trusted publishing over GitHub OIDC and no local `npm publish` (`AGENTS.md:156`). Contribution is unusually gated: "New issues and PRs from new contributors are auto-closed by default" (`README.md:11`).

Claude Code ships as a managed product with background auto-update on native installs, and its governance surface points *outward* at enterprise IT — MDM-deployed managed settings, `forceLoginMethod`/`forceLoginOrgUUID` org pinning, compliance API, role-based permissions.

### 4.7 What each optimizes for

**pi optimizes for a small, legible, provider-neutral core that you extend yourself.** The evidence: 7 tools with 4 on by default; no MCP, no subagents, no permission UI, no plan mode, no todos, no background bash — each an explicit "build it or install it" (`coding-agent/README.md:495-501`, `docs/usage.md:301`); the biggest package by far is the *product* (`coding-agent`), while the *harness* (`agent`) is 10k lines; and a whole standalone multi-provider LLM library underneath. The system prompt even tells the model where pi's own docs and examples live so it can extend itself (`core/system-prompt.ts:131-138`) — "self extensible coding agent" is the README's own phrase (`README.md:15`).

**Claude Code optimizes for a capable default experience that an organisation can govern.** The evidence: ~40 built-in tools covering work pi never attempts; five hook handler types including HTTP and MCP so hooks can be centrally hosted; a four-tier settings hierarchy with a non-overridable managed tier; a permission language with wildcard, parameter, and compound-command semantics; a sandbox layer; checkpoints; and subagents/tool-search as first-class context strategy rather than user-built.

Neither is a subset of the other. pi can talk to Cerebras and be routed into a micro-VM by an extension; Claude Code can be locked down by an IT department and delegate research to a fresh context window without anyone writing code.

---

## 5. Open questions / what I could not verify

**About pi:**

1. **When, or whether, `AgentHarness` (v2) replaces `Agent` (v1).** `packages/agent/src/harness/` is complete enough to have compaction, session stores, and a hook bus, and `harness-v2.md` states a compatibility policy — but no CLI code imports it. Whether this is weeks away or an abandoned branch, I can't tell from the tree.
2. **`packages/storage`.** It has no `package.json` and only a `sqlite-node/` directory. I did not read its contents; its relationship to the v2 harness is inferred from `harness-v2.md`'s storage diagram.
3. **`packages/server` and `packages/client`.** Both are CBOR-over-byte-transport remote-session plumbing, and `server/README.md:3` marks it "Experimental… may change or be removed without notice." What the intended product is (remote pi? multi-client attach?) is not documented in-tree.
4. **Real-world extension ecosystem.** I read the extension API, not what people actually ship. Whether MCP/subagent extensions exist and work well in practice is unverified.
5. **Coverage.** 389 test files is a strong signal, but I found no coverage threshold gate and did not run the suite, so "well tested" is an inference from file counts and the faux-provider discipline in `AGENTS.md:32`, not a measurement.
6. **`interactive-mode.ts` at 6125 lines** — I read its TUI wiring but not the whole file. Claims about the interactive layer beyond renderer selection are inferred.
7. **Whether `beforeToolCall` blocking is genuinely unused by default.** I verified no permission policy ships in `coding-agent/src` and that the hook is wired only to the extension bus. I did not audit the bundled example extensions for one that installs a gate.

**About Claude Code:**

8. **Everything about internals.** Module layout, the actual permission-check call site, schema validation, the compaction prompt, and whether the provider layer has any seam at all — all unverifiable from public docs, and the only local source is excluded. Where the docs describe behaviour, I've cited them; where they don't, I have not speculated.
9. **Whether documented behaviour matches shipped behaviour.** The docs carry per-version annotations (`min-version: 2.1.x`) that suggest active churn. I fetched them on 2026-08-01 and did not run Claude Code to confirm any of it.
10. **The `auto` permission mode's classifier.** Documented as "background safety checks" using a model classifier; its actual criteria, failure modes, and false-negative rate are not published.
11. **Sandbox implementation.** I read the permissions page's description of how sandboxing interacts with rules, but did not fetch `/docs/en/sandboxing` itself, so claims about the sandbox's own configuration surface are second-hand from the permissions page.
12. **Comparative performance or quality.** Nothing in this note is a benchmark. `packages/evals` exists in pi and Anthropic publishes none for Claude Code, so a head-to-head would have to be run, not read.
