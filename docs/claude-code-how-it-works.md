# How Claude Code Works, Internally

Source of truth: the vendored Claude Code CLI source under `claude-code/src/`
(~200K lines of TypeScript). **Note on provenance**: this is a much newer build
than the classic "46K-line QueryEngine.ts" leak — here `src/QueryEngine.ts` is
only 1,297 lines and the agent loop has been split into `src/query.ts`,
`src/query/deps.ts`, `src/services/api/claude.ts`, and `src/services/tools/`.
All claims below were verified against the source; line numbers refer to this
tree.

---

## 1. Entrypoint & startup

**Bootstrap layer — `src/entrypoints/cli.tsx`.** The real entrypoint is a
single `main()` that scans `process.argv` for special flags before loading
anything heavy (all imports are dynamic "fast paths"). `--version` prints an
inlined build-time constant and exits with zero imports (cli.tsx:26-30).
Other fast paths: `--dump-system-prompt` (cli.tsx:44-62), `--claude-in-chrome-mcp`
/ `--chrome-native-host` (cli.tsx:64-75), `--daemon-worker=<kind>` (cli.tsx:89-95),
`remote-control|rc|sync|bridge` (cli.tsx:100-135), `daemon` (cli.tsx:141-149),
`ps|logs|attach|kill` and `--bg` (cli.tsx:156-180), template jobs (cli.tsx:184-190),
`environment-runner` (cli.tsx:194-200), `self-hosted-runner` (cli.tsx:204-210),
and `--worktree --tmux` which `exec`s into tmux (cli.tsx:214-231). `--bare`
sets `CLAUDE_CODE_SIMPLE=1` early (cli.tsx:237-240). Everything else falls
through to `await import('../main.js')` → `main()` (cli.tsx:246-252).

**`src/main.tsx` (4,684 lines) is the CLI proper.** `main()` (main.tsx:585)
sets a Windows PATH-hijack guard (main.tsx:590-592), installs SIGINT handlers
(main.tsx:597-604), rewrites `cc://` deep links and `assistant`/`ssh`
subcommands into the main command (main.tsx:610-780), then computes
interactive-vs-noninteractive from `-p/--print`, `--init-only`, `--sdk-url`,
and `stdout.isTTY` (main.tsx:800-807), and calls `run()` (main.tsx:884).

`run()` builds a **Commander** program with every option: `-p/--print`,
`--output-format`, `--allowedTools/--disallowedTools/--tools`,
`--permission-mode`, `-c/--continue`, `-r/--resume`, `--model`,
`--system-prompt[-file]`, `--mcp-config`, `--agents`, `--settings`, etc.
(main.tsx:975-1005). A `preAction` hook runs `init()`, applies MDM/managed
settings, runs migrations, and attaches analytics sinks before any command
executes (main.tsx:925-975). The default action handler (main.tsx:1005+)
resolves the model, loads commands/skills/agents, calls
`setup()` (main.tsx:1927, defined in `src/setup.ts` — session memory,
worktree chdir, file watchers, hooks config snapshot), then branches:
headless `-p` goes to `src/cli/print.ts`'s `runHeadless()` (print.ts:455);
interactive mounts the Ink TUI via `launchRepl()` (main.tsx:3134, 3176, 3242,
3338, 3487, 3733, 3798).

**`src/replLauncher.tsx` (23 lines)** is the mount point: it renders
`<App><REPL {...props}/></App>` into the Ink root (replLauncher.tsx:10-22).
`renderAndRun` (interactiveHelpers.tsx:98-103) does `root.render(element)`,
fires deferred prefetches, then `await root.waitUntilExit()` — the process
lives until the React tree unmounts.

---

## 2. The REPL loop — input to query

`src/screens/REPL.tsx` (5,006 lines) is the interactive session. Key flow:

1. The prompt input component captures keystrokes; `onSubmit` (REPL.tsx:~3100)
   routes *everything* through `processUserInput()`.
2. `processUserInput` (`src/utils/processUserInput/processUserInput.ts:85`)
   immediately echoes the user's text, then calls `processUserInputBase`
   (line 281), which dispatches on input shape:
   - input starting with `/` → `processSlashCommand`
     (`src/utils/processUserInput/processSlashCommand.tsx:309`) — parses
     `/command args`, checks `hasCommand()`, and for unknown "skills" falls
     back to treating it as a normal prompt (line 373-388);
   - otherwise → `processTextPrompt` (processUserInput.ts:578;
     `src/utils/processUserInput/processTextPrompt.ts:19`) — expands pasted
     content, images, `@file` references, and CLAUDE.md context.
3. The result is a `UserMessage` + attachments. UserPromptSubmit hooks run,
   then the REPL calls the query engine (REPL.tsx:2793):
   ```ts
   for await (const event of query({ messages, systemPrompt, userContext,
     systemContext, canUseTool, toolUseContext, querySource })) { onQueryEvent(event) }
   ```
4. `onQueryEvent` (REPL.tsx:2584) funnels every yielded event through
   `handleMessageFromStream` (`src/utils/messages.ts:2930`), which converts
   raw API `stream_event` deltas into React state: streaming text/thinking
   buffers, `progress` messages, tool-use blocks, and final assistant
   messages. Compaction boundary messages *replace* the message list
   (REPL.tsx:2586-2607).

Message identity: every message has a `uuid`; children derive UUIDs via
`deriveUUID(parentUUID, index)` (messages.ts:725).

---

## 3. The agent loop (`src/query.ts` + deps)

`query()` (query.ts:219) is an async generator that yields stream events and
messages, and returns a `Terminal` reason. The real loop is `queryLoop()`
(query.ts:241) — a `while (true)` (query.ts:307) over mutable `State`
(messages, toolUseContext, compaction tracking, turnCount, transition reason).

Per iteration, in order:

1. **Context pre-processing**: project context (`.claude/` files), memory
   prefetch, skill-discovery prefetch (query.ts:310-350); then
   **snip compaction** (query.ts:396), **microcompact** (query.ts:414), and
   **autocompact** (query.ts:454, via `deps.autocompact` →
   `autoCompactIfNeeded` in `src/services/compact/autoCompact.ts`) each may
   rewrite `messages` before the API call.
2. **Blocking-limit check**: if context is at the hard limit and auto-compact
   is off, it yields a synthetic error and returns `blocking_limit`
   (query.ts:600-637).
3. **API call**: `deps.callModel(...)` — `queryModelWithStreaming`
   (`src/query/deps.ts:26-34`, production wiring at deps.ts:36-43). The stream
   is consumed with `for await` (query.ts:659). `StreamEvent` deltas are
   forwarded; tool_use blocks are collected; a **streaming fallback** (model
   overload) discards the attempt, tombstones orphaned messages, and retries
   on the fallback model (query.ts:704-740).
4. **Abort handling**: on user interrupt, the loop synthesizes
   `tool_result` blocks ("Interrupted by user") for any tool_use lacking
   results and returns `aborted_streaming` (query.ts:1013-1053).
5. **No-follow-up path**: if the model produced no tool calls, the loop runs
   Stop hooks (query.ts:1270-1330), handles prompt-too-long recovery via
   reactive compact / context-collapse drain (query.ts:1074-1200), and
   `max_output_tokens` escalation (retry at 64K, then an injected recovery
   message, query.ts:1195-1268), then returns `completed`.
6. **Tool execution**: `runTools()` (`src/services/tools/toolOrchestration.ts:19`)
   or the newer `StreamingToolExecutor` (query.ts:1378-1382; class at
   `src/services/tools/StreamingToolExecutor.ts:40`, which starts tools while
   the model is still streaming). Tool-result messages are appended to
   `messages`.
7. **Continue**: state is rebuilt as
   `[...messagesForQuery, ...assistantMessages, ...toolResults]` and the loop
   `continue`s (query.ts:1714-1726), unless `maxTurns` was hit
   (query.ts:1706-1712).

Dependencies are injectable (`QueryDeps` in query/deps.ts) so tests can fake
`callModel`/`autocompact` without module-spying. The classic "QueryEngine"
name now lives in `src/QueryEngine.ts:184`: a class wrapping the same `query()`
for headless/SDK use, with `submitMessage()` (QueryEngine.ts:~240, calls
`query()` at line 675) persisting messages/file-cache/usage across turns; the
legacy `ask()` entrypoint is QueryEngine.ts:1186.

**Thinking mode**: `ThinkingConfig = { type: 'adaptive' | 'enabled', budgetTokens } | { type: 'disabled' }`
(`src/utils/thinking.ts:14-18`); `shouldEnableThinkingByDefault()`
(thinking.ts:146) gates adaptive thinking. **Token counting**: client-side
`countTokensWithAnthropic/Bedrock/Vertex` in `src/services/tokenEstimation.ts`
(small 1,024/2,048-token requests to the count_tokens endpoint; thinking blocks
are stripped/included as appropriate). **Cost tracking**: `src/cost-tracker.ts`
computes USD from `calculateUSDCost` per model, persisted to session state
(cost-tracker.ts:87-143).

---

## 4. Tool system

**Declaration** — `src/Tool.ts`. A `Tool` (Tool.ts:390-550) is a plain object:
`name`, optional `aliases`, a Zod `inputSchema`, `call()`, `description()`,
`prompt()` (the schema text shown to the model), plus capability flags and
optional hooks: `validateInput` (pre-permission semantic checks, Tool.ts:497),
`checkPermissions` (tool-specific permission logic, Tool.ts:506),
`isConcurrencySafe`, `isReadOnly`, `isDestructive`, `interruptBehavior`
(`'cancel' | 'block'`, Tool.ts:456), `renderToolUseRejectedMessage` /
`renderToolUseErrorMessage` / `renderGroupedToolUse` (React renderers,
Tool.ts:640-670), `maxResultSizeChars` (tool results above this size are
persisted to disk and replaced by a preview, Tool.ts:480). Tools are built
with `buildTool()` (Tool.ts:780-794), which fills fail-closed defaults:
not concurrency-safe, not read-only, permissions delegate to the general
system (Tool.ts:768-786). `Tools` = readonly array; lookup is
`findToolByName` with alias support (Tool.ts:331-336).

**Registry** — `src/tools.ts` `getAllBaseTools()` (tools.ts:190-220):
Agent, TaskOutput, Bash, Glob/Grep, ExitPlanMode, FileRead/Edit/Write,
NotebookEdit, WebFetch, TodoWrite, WebSearch, Skill, MCP, plus LSP/REPL/etc.
`getTools(permissionContext)` (tools.ts:271) filters by `isEnabled()` and
permission mode.

**Execution pipeline** — `runToolUse` (`src/services/tools/toolExecution.ts:337`):
1. resolve tool by name (with deprecated-alias fallback, line 344-358);
   unknown tool → `<tool_use_error>` result message (line 382-412);
2. **Zod validation** of the model's JSON input:
   `tool.inputSchema.safeParse(input)` (line 601-604) — failures produce
   `InputValidationError` tool_results (with a hint when the schema was never
   sent because of deferred tool loading, `buildSchemaNotSentHint` line 578);
3. `tool.validateInput` (line 703);
4. **PreToolUse hooks** (`runPreToolUseHooks`, line 767+) — may mutate input,
   deny, or stop execution;
5. **Permission check** — `canUseTool` (see §7);
6. `tool.call(input, context, canUseTool, parentMessage, onProgress)` (line
   ~1130) — `onProgress` yields `ProgressMessage`s into the UI stream;
7. result mapped to `tool_result` blocks via
   `mapToolResultToToolResultBlockParam`; oversized results are persisted via
   `processToolResultBlock` (toolResultStorage.ts).

**Concurrency** — `runTools` partitions the batch: consecutive
concurrency-safe (read-only) calls run in parallel (up to
`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, default 10,
toolOrchestration.ts:8-11); anything else runs serially
(toolOrchestration.ts:79-115). `isConcurrencySafe` for Bash = `isReadOnly`
(BashTool.tsx:437-441), decided by `checkReadOnlyConstraints` over a
shell-command parser (`src/utils/bash/`).

**Rendering** — each tool's result message renders through
`src/components/Message/`; Bash output uses live progress ticks
(`bash_progress`, BashTool.tsx:1110) and, during execution, the terminal is
handed to the tool via `setToolJSX` (BashTool.tsx:634-652, 722): the Ink tree
swaps the prompt for a full-screen command view, and `setToolJSX(null)`
restores it (BashTool.tsx:722) — that is the suspend/resume mechanism.

---

## 5. UI layer (React + vendored Ink)

The repo vendors **Ink** itself under `src/ink/` (~13K lines: reconciler,
`root.ts`, `render-to-screen.ts`, focus manager, DOM, termio). `src/ink.ts`
re-exports it, wrapping every render in a `ThemeProvider` (ink.ts:14-31) and
adding a design system: `ThemedBox`/`ThemedText` (`src/components/design-system/`),
`Ansi`, `useInput`, `useTerminalFocus`, etc.

Component tree: `App` (`src/components/App.tsx:19`) = `AppStateProvider` +
`StatsProvider` + `FpsMetricsProvider`; the child is `REPL`
(`src/screens/REPL.tsx:572`). REPL renders `Messages` (memoized via
`areMessagePropsEqual`, `src/components/Message.tsx:604-626`), the
`PromptInput` (`src/components/PromptInput/PromptInput.tsx`, 2,339 lines —
text editing, suggestions, pills), `StatusLine`, `Spinner`, permission
dialogs (`src/components/permissions/`), and task panels
(`src/tasks/LocalShellTask/LocalShellTask.tsx`).

**State**: a zustand-like store in `src/state/AppState.tsx` /
`AppStateStore.ts` / `selectors.ts`; `setAppState` is threaded through
`ToolUseContext` so tools mutate UI state (e.g. `mcp.clients`, `tasks`).
Streaming text is rendered from `deferredMessages` (in-progress deltas) and
swapped to final messages atomically (messages.ts:2976).

---

## 6. REPL ↔ tool ↔ Ink coordination

- **Render loop**: Ink's reconciler diffs the React tree and writes the
  terminal; the REPL is a normal React component, so every stream event that
  becomes a message triggers a re-render. `useLogMessages` in the REPL writes
  each new message to the transcript (sessionStorage) as it lands.
- **Suspend/resume**: long-running tools (Bash) swap the Ink tree's prompt
  for a full-screen JSX view via `setToolJSX` (BashTool.tsx:634-652) and
  restore with `setToolJSX(null)` (BashTool.tsx:722). `setHasInterruptibleToolInProgress`
  (Tool.ts:231) drives the "interrupt tool" affordance.
- **Streaming tool execution**: `StreamingToolExecutor` (StreamingToolExecutor.ts:40)
  starts concurrency-safe tools as tool_use blocks arrive mid-stream, then
  `getRemainingResults()` (used in query.ts:1382-1398) drains queued results
  after the model finishes; aborts generate synthetic results so every
  tool_use gets a tool_result.
- **Headless mode** (`src/cli/print.ts`) has no Ink tree: `runHeadless`
  (print.ts:455) drives the same `ask()`/QueryEngine generator and prints
  formatted output (`--output-format text|json|stream-json`), with a
  permission-prompt MCP tool option for non-interactive approval
  (print.ts:4149).
- **stdout hygiene**: Ink's `patchConsole` option (ink/root.ts, RenderOptions)
  keeps userland `console` output from corrupting frames; SIGINT is handled
  at main.tsx:597 so print mode's own handler wins.

---

## 7. Auth / API layer

**Client factory** — `getAnthropicClient` (`src/services/api/client.ts:88`):
builds one of four SDKs from env flags — direct `@anthropic-ai/sdk`
(default), `AnthropicBedrock` (`CLAUDE_CODE_USE_BEDROCK`, client.ts:148-178),
`AnthropicFoundry` (client.ts:180-208), or `AnthropicVertex`
(client.ts:210+). Headers include `x-app: cli`, `User-Agent`,
`X-Claude-Code-Session-Id`, and custom headers (client.ts:99-115). Timeout
default 600s (`API_TIMEOUT_MS`), `dangerouslyAllowBrowser: true`, proxy
support (client.ts:141-147).

**Auth precedence** — `getAnthropicApiKeyWithSource` (`src/utils/auth.ts:226`):
`ANTHROPIC_API_KEY` env (approved via `customApiKeyResponses`),
file-descriptor-injected keys, `apiKeyHelper` command, then config or macOS
keychain (`getApiKeyFromConfigOrMacOSKeychain`, auth.ts:338-350). OAuth for
Claude.ai subscriptions: tokens live in secure storage
(`src/utils/secureStorage/index.ts` — macOS keychain with plaintext
fallback, Linux currently plaintext) and are refreshed lazily:
`checkAndRefreshOAuthTokenIfNeeded` runs before client creation
(client.ts:128-132). OAuth flow itself is in `src/services/oauth/client.ts`
(PKCE authorization-code exchange ~line 100-140; `refreshOAuthToken` at
line 146; `getOauthProfile` fetches user/subscription info). `saveApiKey`
(auth.ts:1094) persists API keys to the keychain.

**API calls** — `queryModel` (`src/services/api/claude.ts:1017`) builds
`betas` headers (line 1060-1090), tool schemas (with deferred tool loading
via ToolSearch), thinking config, prompt-cache breakpoints, and streams via
`anthropic.beta.messages.create({ stream: true })` with a raw
`withResponse()` stream to avoid partial-JSON re-parsing (claude.ts:1820-1826;
non-streaming fallback at 864, small-fast-model call at 555). There is also
`queryHaiku` (claude.ts:3241)
for cheap side-queries (tool summaries, memory extraction), VCR record/replay
(`withStreamingVCR`), retry-with-fallback, and rate-limit error
classification (`src/services/api/errors.ts`, `withRetry.ts`).

**Permission model** — `CanUseToolFn` (`src/hooks/useCanUseTool.tsx:27`) →
`hasPermissionsToUseTool` (`src/utils/permissions/permissions.ts:473`):
always-allow/always-deny/always-ask rule matching (incl. `Bash(git *)`
patterns via `preparePermissionMatcher`, BashTool.tsx:449-476), auto-mode
classifier, then mode-specific handlers:
`interactiveHandler.ts` (shows the dialog queue → `PermissionRequest`
components), `coordinatorHandler.ts`, `swarmWorkerHandler.ts`
(useCanUseTool.tsx:60-64). Denials are reported back to the model as
`tool_result` errors; the REPL shows a rejection message.

---

## 8. Session / state persistence

- **Transcripts**: JSONL files under `~/.claude/projects/<project>/<sessionId>.jsonl`
  (`getTranscriptPath`, `src/utils/sessionStorage.ts:202`; project dir at
  line 198). `recordTranscript` (sessionStorage.ts:1408) dedupes by UUID and
  appends new chains; subagent transcripts go to
  `<session>/subagents/agent-<id>.jsonl` (line 247); flush on exit
  (`flushSessionStorage`, line 1583). Reads are capped at 50MB
  (line 229).
- **Resume**: `-c/--continue` and `-r/--resume` load the JSONL, rebuild
  messages, file-history snapshots, and content-replacement state
  (`processResumedConversation`, main.tsx:3118+). `--fork-session` copies
  under a new session ID.
- **Cost/usage**: per-session token/cost counters in `src/bootstrap/state.ts`
  (getSessionId:431, switchSession:468), persisted by `src/cost-tracker.ts`.
- **Session metadata**: `~/.claude/projects` also holds `.meta.json` files
  (sessionStorage.ts:260-292) and `--name` titles.
- **Remote session history**: `src/assistant/sessionHistory.ts` is *not*
  local persistence — it pages SDK messages from the hosted
  `/v1/sessions/{id}/events` API (sessionHistory.ts:31-71) for remote/CCR
  sessions.

---

## 9. MCP integration (`src/services/mcp/`)

- **Config**: `getMcpConfigsByScope` (`src/services/mcp/config.ts:888`) merges
  scopes `enterprise → user → project → local → dynamic`; transports:
  stdio, sse, http, ws, sdk (types.ts:23-30). Config lives in
  `.mcp.json` / `.claude.json` / settings.
- **Connection**: `src/services/mcp/client.ts` spawns `StdioClientTransport`
  (client.ts:950), creates a protocol `Client` (client.ts:985), and
  `client.connect()` (client.ts:1048); `ensureConnectedClient`
  (client.ts:1688) and `reconnectMcpServerImpl` (client.ts:2137) manage
  lifecycle. `getMcpToolsCommandsAndResources` (client.ts:2226) turns MCP
  server tools into CC `Tool` objects (`isMcp: true`, name normalized to
  `mcp__server__tool`), and resources into `ServerResource`s. OAuth for
  protected servers: `src/services/mcp/auth.ts` (2,466 lines) + `McpAuthTool`.
- **In-session**: `AppState.mcp` holds `{ clients, configs, tools, resources }`
  (types.ts:231-245); query.ts passes `mcpTools` and `hasPendingMcpServers`
  into each API call (query.ts:695-699) so tools appear/disappear as servers
  connect mid-turn (`refreshTools`, query.ts:1660-1675). MCP tool results are
  processed through `processMCPResult` (client.ts:2720) with schema
  inference for compaction (client.ts:2644).

---

## 10. Distinctive features

- **Vim mode**: a real mini-vim — `src/vim/` (motions.ts, operators.ts,
  textObjects.ts, transitions.ts, types.ts) driven by `useVimInput`
  (`src/hooks/useVimInput.ts`) with INSERT/NORMAL modes; REPL holds
  `vimMode` state (REPL.tsx:1507). Also a full custom **keybinding** system:
  `src/keybindings/` (parser, resolver, `useKeybinding`, user-editable
  bindings).
- **Slash commands & skills**: `/command` dispatch in
  processSlashCommand.tsx; commands/skills load from `.claude/commands`,
  `.claude/skills`, plugins, and bundled sets (`getCommands`,
  `src/commands.ts:478`; `src/skills/loadSkillsDir.ts`). Skills can be
  dynamically discovered during file operations (`getDynamicSkills`).
- **Plugins**: `src/plugins/builtinPlugins.ts` + `src/utils/plugins/pluginLoader.ts`
  (3,303 lines) — npm/git installs, versioned caching, manifest loading,
  marketplace (`marketplaceManager.ts`).
- **Agents/subagents**: `AgentTool` (`src/tools/AgentTool/AgentTool.tsx:196`)
  spawns subagents via `runAgent` (`src/tools/AgentTool/runAgent.ts:248`),
  which forks context (`forkSubagent.ts`, `createSubagentContext` in
  `src/utils/forkedAgent.ts`), builds an agent system prompt, and recursively
  runs `query()` (runAgent.ts:748) with its own transcript sidechain
  (runAgent.ts:733-745). Custom agents load from `.claude/agents/`
  (`loadAgentsDir.ts`); `--agent` sets the main-thread persona.
- **Background tasks & async agents**: `src/tasks/` — `LocalShellTask`
  (background `Bash`), `LocalAgentTask`, `RemoteAgentTask`,
  `InProcessTeammateTask`; registered via `registerTask`
  (`src/utils/task/framework.ts:77`), polled by `pollTasks` (line 255),
  listed in the UI; `claude ps`/`--bg` manage them from a separate process
  against the sessions registry (cli.tsx:156-180).
- **Hooks**: `src/utils/hooks.ts` (5,023 lines) — config-driven lifecycle
  scripts (PreToolUse/PostToolUse/Stop/UserPromptSubmit/Notification/SessionStart…)
  matched by `getMatchingHooks` (hooks.ts:1603) with `if:` matchers; executed
  via `executeHooks` (hooks.ts:1952), gated on workspace trust (hooks.ts:2018);
  `executePreToolHooks` (hooks.ts:3394), `executeStopHooks` (hooks.ts:3639).
- **Compaction family**: proactive auto-compact (`src/services/compact/autoCompact.ts`),
  reactive compact on 413 (reactiveCompact.ts), snip (partial truncation),
  microcompact (tool-result trimming), and context-collapse (staged
  summarization with background agents).
- **Misc**: proactive mode (Sleep tool + ticks), brief/assistant mode,
  background memory extraction (`src/services/extractMemories`), session
  memory (`src/services/SessionMemory/`), voice mode, rate-limit mocking,
  VCR test fixtures, `--debug` filters, and a built-in daemon/bridge for
  remote control.

---

## Key files map

| File | Role (one line) |
|---|---|
| `src/entrypoints/cli.tsx` | Fast-path arg dispatcher; loads `main.tsx` only when needed |
| `src/main.tsx` | Full CLI: Commander options, init/setup, REPL-vs-print branch |
| `src/replLauncher.tsx` | Mounts `<App><REPL/></App>` into the Ink root |
| `src/setup.ts` | Session bootstrapping: cwd/worktree, memory, hooks snapshot |
| `src/screens/REPL.tsx` | The interactive TUI: input handling, message state, query driver |
| `src/query.ts` | The agent loop (async generator): API call, tools, compaction, continue |
| `src/query/deps.ts` | Injectable I/O deps for `query()` (model, compactions, uuid) |
| `src/QueryEngine.ts` | Headless/SDK query lifecycle class (`submitMessage`, legacy `ask`) |
| `src/services/api/claude.ts` | Streaming Anthropic API calls, betas, cache breakpoints |
| `src/services/api/client.ts` | SDK client factory: direct / Bedrock / Foundry / Vertex + headers |
| `src/utils/auth.ts` | API-key & OAuth token resolution, keychain helpers |
| `src/services/oauth/client.ts` | PKCE login, token refresh, profile fetch |
| `src/Tool.ts` | The `Tool` type, defaults, `buildTool` |
| `src/tools.ts` | Tool registry (`getAllBaseTools`, `getTools`) |
| `src/services/tools/toolExecution.ts` | Per-tool pipeline: zod, hooks, permissions, call, result mapping |
| `src/services/tools/toolOrchestration.ts` | Batch partitioning, serial vs concurrent tool runs |
| `src/services/tools/StreamingToolExecutor.ts` | Start tools mid-stream; drain results after stream ends |
| `src/hooks/useCanUseTool.tsx` | `canUseTool` closure: permission resolution + dialog queue |
| `src/utils/permissions/permissions.ts` | Permission rules engine (allow/deny/ask, classifier) |
| `src/ink.ts`, `src/ink/` | Vendored Ink renderer + theme wrapper (13K lines) |
| `src/utils/messages.ts` | Message factories, stream-event → message handling |
| `src/utils/sessionStorage.ts` | JSONL transcript persistence + resume plumbing |
| `src/services/mcp/client.ts` | MCP connect/transport/tool conversion (3,349 lines) |
| `src/services/mcp/config.ts`, `types.ts` | MCP config scopes, schemas, connection states |
| `src/utils/hooks.ts` | Hook engine: matching, execution, security gating |
| `src/tools/AgentTool/runAgent.ts` | Subagent runner: fork context, recursive `query()` |
| `src/cli/print.ts` | Headless mode: `runHeadless`, structured output |
| `src/cost-tracker.ts` | USD cost & usage accounting |
| `src/vim/`, `src/hooks/useVimInput.ts` | Built-in vim mode |
| `src/keybindings/` | Custom keybinding parser/resolver |
| `src/tasks/`, `src/utils/task/framework.ts` | Background tasks & async agents |
