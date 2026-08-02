# Research: Zed's agent harness

Date: 2026-08-01. Subject repo: `zed` at commit `f86d8985121d1b9bdb871df25fa4436463bcbbd4` (2026-07-29), checked out at `C:\Users\c7834\Documents\git-repos\zed`.

This is a companion to `docs/RESEARCH-agent-harnesses.md` and follows its conventions: every structural claim carries a `crates/path/file.rs:LINE` citation, and §12 lists what I inferred rather than read.

---

## 1. Scope note

**Everything below is read from Zed's Rust source.** No blog post, changelog, or third-party write-up was consulted. Zed's published docs at <https://zed.dev/docs/ai/> were *not* fetched either — the primary source was sufficient and unambiguous for every question asked, so this note is 100% source-derived rather than source-plus-confirmation. Where I could not determine something from source, §12 says so rather than filling the gap from docs.

Paths are relative to the zed checkout root (`crates/...`).

Two caveats about the evidence:

- Zed's Rust files carry their unit tests inline (`#[cfg(test)] mod tests` at the bottom of the same file). The line counts in §2 are therefore **source + tests**, not source alone. This inflates the agent crate substantially — `thread.rs` is 8284 lines of which roughly the last 2000 are tests (`crates/agent/src/thread.rs:7609` onward is test scaffolding). Compare with care against the pi figures in the sibling doc, which excluded tests.
- I read `thread.rs`, `agent_profile.rs`, `db.rs`, `connection.rs`, `native_agent_server.rs`, and the settings-content definitions closely. `agent.rs` (6929 lines), `acp.rs` (5020 lines), and `agent_ui/*` I sampled by targeted grep and read only the regions cited.

---

## 2. Crate layout and size

The harness is not one crate. It is a stack of about eight, with a deliberate dependency ordering.

| Crate | Lines (`.rs`, incl. tests) | Role |
|---|---:|---|
| `agent` | 85,010 | **The harness core.** The thread/turn loop, the tool trait, all built-in tools, permissions, sandboxing glue, SQLite persistence. |
| `agent_ui` | 83,514 | GPUI views: the agent panel, conversation view, profile selector, model selector, diff review. |
| `language_models` | 21,143 | Concrete provider implementations (19 of them). |
| `acp_thread` | 13,954 | The **client-side** conversation model and the `AgentConnection` trait. UI-facing, agent-agnostic. |
| `settings_content` | 10,906 | Serde/JsonSchema definitions for every setting, including `AgentProfileContent`. |
| `extension_host` | 10,339 | WASM extension host. |
| `settings` | 8,302 | The settings store and its merge order. |
| `sandbox` | 8,228 | OS sandbox integrations (Seatbelt / Bubblewrap). |
| `context_server` | 6,174 | MCP client (protocol, transport, OAuth). |
| `agent_servers` | 6,086 | External ACP agent processes (stdio child processes). |
| `language_model_core` | 3,070 | Tool-schema generation, shared model types. |
| `anthropic` | 2,589 | Anthropic wire client. |
| `agent_settings` | 2,426 | `AgentSettings`, **`AgentProfile`**, `AGENTS.md` loading. |
| `agent_skills` | 2,187 | `SKILL.md` discovery and the skill catalog. |
| `language_model` | 2,149 | **The provider seam:** the `LanguageModel` trait and the registry. |
| `acp_tools` | 842 | ACP protocol-log debug view. |

Within `crates/agent/src`, the modules that matter:

```
thread.rs             8284   the turn loop, AgentTool trait, ToolCallEventStream, compaction
agent.rs              6929   NativeAgent + NativeAgentConnection (the ACP adapter), skills catalog
tool_permissions.rs   2417   permission decision engine (regex rules)
db.rs                 1236   SQLite thread store
sandboxing.rs         1152   policy glue to the `sandbox` crate
tools/                ~22k   29 tool modules (edit_file_tool.rs alone is 3031, terminal_tool.rs 3548)
templates/             —     Handlebars system prompt (system_prompt.hbs, 19.4 KB)
```

The dependency edge that defines the architecture: `agent` depends on `acp_thread` and `agent_servers` (`crates/agent/Cargo.toml:20-23`), **not the other way round**. `acp_thread` knows nothing about `agent`. That is what makes the built-in agent swappable — see §10.

---

## 3. Profiles

### 3.1 The definition

Two types, one for the on-disk shape and one for the in-memory shape.

On disk (`crates/settings_content/src/agent.rs:509-519`):

```rust
pub struct AgentProfileContent {
    pub name: Arc<str>,
    #[serde(default)]
    pub tools: IndexMap<Arc<str>, bool>,
    /// Whether all context servers are enabled by default.
    pub enable_all_context_servers: Option<bool>,
    #[serde(default)]
    pub context_servers: IndexMap<Arc<str>, ContextServerPresetContent>,
    /// The default language model selected when using this profile.
    pub default_model: Option<LanguageModelSelection>,
}
```

with `ContextServerPresetContent { tools: IndexMap<Arc<str>, bool> }` (`crates/settings_content/src/agent.rs:523-524`).

In memory (`crates/agent_settings/src/agent_profile.rs:104-112`) it is the same five fields with the options resolved:

```rust
pub struct AgentProfileSettings {
    pub name: SharedString,
    pub tools: IndexMap<Arc<str>, bool>,
    pub enable_all_context_servers: bool,
    pub context_servers: IndexMap<Arc<str>, ContextServerPreset>,
    pub default_model: Option<LanguageModelSelection>,
}
```

`AgentProfileId` is a newtype over `Arc<str>` (`crates/agent_settings/src/agent_settings.rs:390`). The `AgentProfile` struct itself (`agent_profile.rs:28-31`) holds *only* an id — it is a handle, not the data; the data lives in `AgentSettings.profiles: IndexMap<AgentProfileId, AgentProfileSettings>` (`agent_settings.rs:224-225`).

**That is the whole feature.** Five fields.

### 3.2 What a profile can and cannot configure

| Thing | In a profile? |
|---|---|
| Which built-in tools are exposed | **Yes** — `tools: IndexMap<name, bool>` |
| Which MCP (context-server) tools are exposed | **Yes** — `enable_all_context_servers` + per-server `context_servers[server].tools` |
| Default model | **Yes** — `default_model: Option<LanguageModelSelection>` |
| System prompt | **No** — not a field. (But see below: the prompt is *indirectly* affected.) |
| Permission rules (allow/deny/confirm) | **No** — those live in `agent.tool_permissions`, globally |
| Sandbox policy | **No** — `agent.sandbox_permissions`, globally |
| Skills | **No** — a profile can only enable/disable the `skill` tool itself |
| Temperature / thinking / effort | **No** — `agent.model_parameters`, globally |
| Subagent behaviour | **No** — but subagents inherit the parent's profile, see §3.7 |

The "no system prompt" answer needs a footnote. The system prompt is a Handlebars template rendered per request with `available_tools` passed in (`crates/agent/src/thread.rs:4217-4232`), and `system_prompt.hbs` branches on it: `{{#if (gt (len available_tools) 0)}}` at `crates/agent/src/templates/system_prompt.hbs:34`, `{{#if (contains available_tools 'grep')}}` at `:60`, `{{#if (contains available_tools 'spawn_agent')}}` at `:114`. So changing the profile changes the tool list, which changes the rendered system prompt. There is no profile field that sets prompt text.

### 3.3 Tools: full-set toggle, not allowlist or denylist

The shape is `IndexMap<Arc<str>, bool>` and the read is:

```rust
pub fn is_tool_enabled(&self, tool_name: &str) -> bool {
    self.tools.get(tool_name) == Some(&true)
}
```

— `crates/agent_settings/src/agent_profile.rs:115-117`.

Note `== Some(&true)`: **absent means disabled**. So it behaves as an allowlist in effect (a tool must be explicitly `true`), but it is *stored* as a full-set toggle map, because the merge semantics need the explicit `false` (see §3.5). This is why the `minimal` built-in ships `"tools": {}` and gets zero tools.

MCP tools invert the default:

```rust
pub fn is_context_server_tool_enabled(&self, server_id: &str, tool_name: &str) -> bool {
    self.context_servers
        .get(server_id)
        .and_then(|preset| preset.tools.get(tool_name).copied())
        .unwrap_or(self.enable_all_context_servers)
}
```

— `agent_profile.rs:145-150`. Unlisted MCP tool → falls back to `enable_all_context_servers`. The two tests at `agent_profile.rs:255-275` pin exactly this: explicit `false` disables under `enable_all = true`, explicit `true` enables under `enable_all = false`.

The consumption point is `Thread::enabled_tools` (`crates/agent/src/thread.rs:4030-4122`). It filters the thread's registered tools by `profile.is_tool_enabled(...)` at `:4064` and the context-server tools by `is_context_server_tool_enabled` at `:4088`. There are three *additional* filters stacked on top of the profile, in the same function:

1. `tool.supports_provider(&model.provider_id())` (`:4063`) — some tools are provider-gated for billing reasons.
2. `!is_restricted || tool.allow_in_restricted_mode()` (`:4051`) — an untrusted-worktree gate that overrides the profile entirely; the comment at `:4042-4044` says so explicitly ("must never be provided to the model … regardless of what the active profile enables").
3. `crate::tools::tool_feature_flag_enabled(tool_name, cx)` (`:4080`).

And a fourth wrinkle: `terminal` and `sandboxed_terminal` are two registered tools that the user configures under the single name `terminal`; `enabled_tools` picks whichever matches the current sandbox state and presents it to the model as `terminal` (`:4037-4070`).

### 3.4 Built-in profiles

Shipped in `assets/settings/default.json:1170-1226`, with `"default_profile": "write"` at `:1169`.

- **`write`** — `enable_all_context_servers: true`, and 22 tools all `true`: `copy_path`, `create_directory`, `create_thread`, `delete_path`, `diagnostics`, `apply_code_action`, `edit_file`, `write_file`, `fetch`, `find_path`, `find_references`, `get_code_actions`, `go_to_definition`, `list_agents_and_models`, `list_directory`, `move_path`, `rename_symbol`, `read_file`, `grep`, `skill`, `spawn_agent`, `terminal`, `search_web`.
- **`ask`** — 13 tools, the read-only subset (drops `copy_path`, `create_directory`, `delete_path`, `edit_file`, `write_file`, `move_path`, `rename_symbol`, `apply_code_action`, `terminal`). `enable_all_context_servers` is **commented out** in the default file with the reason inline (`default.json:1202-1203`): *"We don't know which of the context server tools are safe for the 'Ask' profile"*.
- **`minimal`** — `enable_all_context_servers: false`, `"tools": {}`. No tools at all.

The IDs are hard-coded constants with an `is_builtin` predicate (`crates/agent_settings/src/agent_profile.rs:16-26`). UI descriptions live separately in `crates/agent_ui/src/profile_selector.rs:389-396`.

### 3.5 Composition, inheritance, precedence

**Profiles do not inherit from each other at runtime.** There is exactly one composition mechanism and it is a one-time copy at creation:

`AgentProfile::create(name, base_profile_id, fs, cx)` (`crates/agent_settings/src/agent_profile.rs:45-90`) reads the base profile out of settings, **clones** `tools`, `enable_all_context_servers`, `context_servers`, and `default_model` into a fresh `AgentProfileSettings`, kebab-cases the name into an id (`:51`), and writes it to the settings file. After that the two profiles are unrelated — editing the base does not affect the derived profile.

What *does* compose is the **settings layers**, and this is where the `bool` in the tools map earns its keep. Each `AgentProfileContent` derives `MergeFrom` (`crates/settings_content/src/agent.rs:508`), and the settings store merges in this order (`crates/settings/src/settings_store.rs:1330-1351`):

```
default.json  →  global_settings.json  →  extension settings  →  user settings.json
              →  release-channel overrides  →  OS overrides  →  active settings-profile  →  server settings
```

So a user profile keyed `"write"` merges *into* the shipped `write`, key by key. Setting `"tools": { "fetch": false }` in user settings turns off exactly `fetch` and leaves the other 21 alone — this is precisely the scenario in the test at `agent_profile.rs:297-306`. A denylist-style edit is expressible only because absent ≠ false in the merge, even though absent == false at read time.

**Project-level profiles do not exist.** `local_settings` (i.e. `.zed/settings.json` in a worktree) are stored separately from `merged_settings` (`settings_store.rs:156`, `:160`), and the only field local settings contribute to the merged global content is `project.disable_ai` (`settings_store.rs:1356-1361`). `AgentSettings::from_settings` reads `content.agent` off the merged content (`crates/agent_settings/src/agent_settings.rs:744-746`, profiles at `:775-781`), and every consumer uses `AgentSettings::get_global(cx)` (e.g. `thread.rs:4034`). So **profiles are user-level only**. On disk that is `paths::config_dir().join("settings.json")` (`crates/paths/src/paths.rs:278-280`) — `%APPDATA%\Zed\settings.json` on Windows (`paths.rs:126-129`), `~/.config/zed/settings.json` on Linux, JSONC format (the default file is full of comments).

Confusing terminology alert: Zed has a *second, unrelated* "profiles" feature — `UserSettingsContent.profiles: IndexMap<String, SettingsProfile>` (`crates/settings_content/src/settings_content.rs:453`), documented at `default.json:2764-2793` as "settings profiles that are temporarily applied". That is the `active_profile` merged at `settings_store.rs:1346-1348`, and it has nothing to do with agent profiles. When a doc comment in the agent settings says patterns "accumulate across settings layers (user, project, profile)" (`crates/settings_content/src/agent.rs:854-855`), it means *that* profile.

### 3.6 Restricted-workspace downgrade

There is one automatic profile override, and it happens only at thread construction.

`Thread::profile_for_restricted_workspace` (`crates/agent/src/thread.rs:2197-2214`) downgrades `write`/`ask` to `minimal` when the workspace has restricted (untrusted) worktrees — but **only if both the chosen profile and `minimal` are unmodified shipped defaults**, so a user's customisations are never silently overridden. "Unmodified" is decided by comparing the profile in `store.merged_settings()` against `store.raw_default_settings()` (`crates/agent_settings/src/agent_profile.rs:123-143`). The thread records that this happened in a `profile_downgraded_for_restricted_workspace: bool` field (`thread.rs:1250`) so the UI can explain itself (`crates/agent_ui/src/profile_selector.rs:375-387` lists which of the profile's tools are forbidden).

### 3.7 Switching mid-conversation

**Yes, and it is cheap.** The code path is short enough to quote in full (`crates/agent/src/thread.rs:2216-2237`):

```rust
pub fn set_profile(&mut self, profile_id: AgentProfileId, cx: &mut Context<Self>) {
    // An explicit selection means any earlier automatic downgrade no longer applies,
    // even if the user re-selects the same profile.
    self.profile_downgraded_for_restricted_workspace = false;
    if self.profile_id == profile_id { return; }
    self.profile_id = profile_id.clone();
    // Swap to the profile's preferred model when available.
    if let Some(model) = Self::resolve_profile_model(&self.profile_id, cx) {
        self.set_model(model, cx);
    }
    for subagent in &self.running_subagents {
        subagent.update(cx, |thread, cx| thread.set_profile(profile_id.clone(), cx)).ok();
    }
}
```

Called from the UI through a `ProfileProvider` trait implemented for `Entity<agent::Thread>` (`crates/agent_ui/src/conversation_view.rs:231-241`), driven either by the picker or by `cycle_profile` (`crates/agent_ui/src/profile_selector.rs:95-122`).

Answering the specific questions:

- **Is anything rewritten?** No. `set_profile` touches three fields and, if the profile has a `default_model`, the model. The message history is not read, not filtered, not rewritten. There is no "profile changed" marker inserted into the transcript — `Message` has only four variants: `User`, `Agent`, `Resume`, `Compaction` (`thread.rs:182-187`).
- **When does it take effect?** Between tool-call rounds, including mid-turn. Each iteration of the turn loop calls `this.refresh_turn_tools(cx)` before building the request (`thread.rs:2797`), and the comment above it says exactly this: *"Re-read the model and refresh tools on each iteration so that mid-turn changes (e.g. the user switches model, toggles tools, or changes profile) take effect between tool-call rounds"* (`thread.rs:2788-2790`). `refresh_turn_tools` recomputes `enabled_tools` and swaps `turn.tools` wholesale (`thread.rs:4124-4129`). Tool calls already in flight are unaffected — they hold their own `Arc<dyn AnyAgentTool>`.
- **Is the switch recorded in persisted state?** Only as the *current* value. `DbThread` has `profile: Option<AgentProfileId>` (`crates/agent/src/db.rs:70-71`), written from `to_db` as `profile: Some(self.profile_id.clone())` (`thread.rs:1875`). There is no history of profile changes, and no per-message profile attribution. On load, `profile_id = db_thread.profile.unwrap_or_else(|| settings.default_profile.clone())` (`thread.rs:1708-1710`).
- **What happens to tool calls in history for tools the new profile does not have?** Nothing — they stay verbatim. `extend_request_history_until` (`thread.rs:4731-4757`) replays messages with no reference to the tool set; `build_completion_request` passes `available_tools` only into the *system prompt* (`thread.rs:4005`, `:4219`) and the tool *declarations* (`:3978-3993`). So the model sees a transcript containing `terminal` tool calls and results while `terminal` is no longer a declared tool. Zed does not scrub, rename, or convert them. (Whether providers tolerate this is a provider question; nothing in Zed guards it.)
- **Subagents**: running subagents are switched too, recursively (`thread.rs:2232-2236`).

One loose end: `set_profile` does not call `cx.notify()`. Thread persistence is driven by `cx.observe(&thread_handle, |this, thread, cx| this.save_thread(thread, cx))` (`crates/agent/src/agent.rs:820-821`), which fires on notify. `set_model` emits `ModelChanged` but I did not find a `notify` in it either (`thread.rs:1976-1996`). So a bare profile switch appears to persist lazily, on the next change that does notify. Flagged in §12.

### 3.8 Profiles are Zed-agent-only

`ProfileProvider` is implemented for exactly one type: `Entity<agent::Thread>` (`crates/agent_ui/src/conversation_view.rs:231`, and a test double at `profile_selector.rs:959-973`). External ACP agents get a different, protocol-level concept — **session modes** (`AgentSessionModes` with `current_mode`/`all_modes`/`set_mode`, `crates/acp_thread/src/connection.rs:303-309`) and **session config options** (`:311-326`), plus `AgentServer::default_mode` / `set_default_mode` (`crates/agent_servers/src/agent_servers.rs:62-72`). Profiles are not exposed over ACP.

---

## 4. The agent loop

### 4.1 Shape

`Thread::run_turn` (`crates/agent/src/thread.rs:2638-2700`) sets up an `mpsc::UnboundedReceiver<Result<ThreadEvent>>`, snapshots `enabled_tools`, creates a `watch::channel(false)` for cancellation, and spawns `run_turn_internal` on the GPUI foreground executor. The handle is stored as `self.running_turn = Some(RunningTurn { ... })` (`:2698`); starting a new turn cancels any previous one (`:2646`).

`run_turn_internal` (`:2702-3050`) is a single `loop` with, per iteration:

1. `perform_compaction_if_needed` (`:2713`) — see §6.
2. Re-read model, `refresh_turn_tools`, `build_completion_request` (`:2792-2801`).
3. `model.stream_completion(request, cx).await` (`:2817`).
4. An inner `loop` (`:2826`) that `futures::select!`s over three things: the next completion event, a completed tool result, and the cancellation watch (`:2828-2860`). Events are drained in batches — the first event plus everything already available via `now_or_never()` (`:2866-2869`) — and dispatched to `handle_completion_event` inside a single `this.update(cx, ...)`, which is a real optimisation given GPUI's borrow model.
5. After the stream ends, drain remaining tool results (`:2998-3000`).

### 4.2 Continue vs stop

`let end_turn = tool_results.is_empty() && early_tool_results.is_empty();` (`:2993`). That is the whole rule: **the turn ends when the model's response contained no tool calls.** Exits, in order of check:

- Cancelled → return `Ok(())` (`:3009-3012`).
- Completion error → `retry_completion_error` (`:3016`); on `ControlFlow::Break` return, otherwise loop again, pushing a `Message::Resume` if the last agent message had no tool results (`:3029-3036`).
- `end_turn` → return (`:3037-3038`).
- `end_turn_at_next_boundary()` (`:3040-3045`) — a steering flag: if the user queued a message, stop at the message boundary rather than continuing the tool loop.
- Otherwise `intent = CompletionIntent::ToolResults; attempt = 0;` and loop.

There is also a **refusal fallback**: if the model refuses, Zed looks up `refusal_fallback_model_id()` on the current model, finds it in the registry, switches to it, emits a synthetic retry status, and re-runs the iteration (`:2940-2991`).

### 4.3 Turn caps and budget caps

**There are none.** No `max_turns`, no token budget, no cost cap in the loop. Grepping `crates/agent/src/*.rs` for `max_turns|MAX_TURNS|turn_limit|budget` returns only skill-catalog *description size* budgets (`agent.rs:3476-3509`, `MAX_SKILL_DESCRIPTIONS_SIZE`). The only counters are:

- `MAX_RETRY_ATTEMPTS: u8 = 4` with `BASE_RETRY_DELAY: Duration = 5s` (`thread.rs:166-167`) — retries on completion *errors*, not turns.
- `MAX_SUBAGENT_DEPTH: u8 = 1` (`thread.rs:74`) — subagents cannot spawn subagents.
- `MIN_COMPACTION_CONTEXT_WINDOW: u64 = 80_000` (`thread.rs:121`).

Runaway control is the user pressing cancel, plus per-tool permission prompts.

### 4.4 Tool dispatch: concurrent

Tool tasks accumulate in a `FuturesUnordered<Task<LanguageModelToolResult>>` (`thread.rs:2821`) and are polled concurrently with the still-arriving completion stream (`:2830`). A tool starts the moment its `ToolUse` event is fully parsed — `handle_tool_use_event` returns a `Task` that `run_tool` has already spawned (`:3525-3533`, `:3579-3580`) — so **the first tool call of a response begins executing while the model is still streaming later tool calls in the same response**.

There is no per-tool `sequential` opt-out equivalent to pi's `executionMode`. Serialisation, where it matters, is pushed into the tools themselves (e.g. `tools/edit_session.rs`, 1269 lines).

Streaming tool inputs are supported: a tool opts in via `supports_input_streaming()` (`thread.rs:5016-5018`), gets a `ToolInput<T>` channel that receives `Partial(serde_json::Value)` snapshots and finally `Full(T)` (`:4934-4938`), and starts running before the arguments are complete (`:3483-3507`). `edit_file` uses this. There's a deadlock guard: if the stream ends while partial inputs are outstanding, the senders are dropped so the tools' `recv()` fails (`:2930-2938`).

One detail worth stealing: after the stream ends, `drop(events)` is called explicitly *before* awaiting tool results, with the comment that the stream holds a rate-limit semaphore permit and holding it during tool execution deadlocks when a tool spawns a subagent needing its own permit (`:2920-2925`).

---

## 5. Tool definition and validation

### 5.1 The trait

`pub trait AgentTool` (`crates/agent/src/thread.rs:4982-5062`), with associated types:

```rust
type Input:  for<'de> Deserialize<'de> + Serialize + JsonSchema;
type Output: for<'de> Deserialize<'de> + Serialize + Into<LanguageModelToolResultContent>;
const NAME: &'static str;
fn kind() -> acp::ToolKind;
fn initial_title(&self, input: Result<Self::Input, serde_json::Value>, cx: &mut App) -> SharedString;
fn input_schema(format: LanguageModelToolSchemaFormat) -> Schema;
fn supports_input_streaming() -> bool { false }
fn supports_provider(_: &LanguageModelProviderId) -> bool { true }
fn allow_in_restricted_mode() -> bool { true }
fn run(self: Arc<Self>, input: ToolInput<Self::Input>, event_stream: ToolCallEventStream, cx: &mut App)
    -> Task<Result<Self::Output, Self::Output>>;
fn replay(&self, input: Self::Input, output: Self::Output, event_stream: ToolCallEventStream, cx: &mut App) -> Result<()>;
fn erase(self) -> Arc<dyn AnyAgentTool>;
```

Three things stand out.

**`Result<Self::Output, Self::Output>`.** Both arms are the same type. The doc comment (`:5036-5040`) explains: tool errors are sent to the model as tool results, so the error must be *structured and model-readable*, not an `anyhow::Error`. The `Err` arm only sets `is_error: true` on the wire.

**`replay`.** Tools can re-emit their UI events for a previously-executed call. This is how reopening a persisted thread reconstructs rich tool cards (diffs, terminal output) without re-running anything.

**The erasure pattern.** `AgentTool` is `Sized` and generic; `Erased<Arc<T>>` implements the object-safe `AnyAgentTool` (`:5085-5114`, impl at `:5116-5190`), doing the JSON ⇄ typed conversions at the boundary. `Thread` stores `BTreeMap<SharedString, Arc<dyn AnyAgentTool>>`.

### 5.2 Schema generation

**`schemars`.** `schemars` is a direct dependency of `agent` (`crates/agent/Cargo.toml`, `schemars.workspace = true`). Default `description()` pulls the tool description out of the generated schema's top-level `description` (`thread.rs:4991-4999`) — i.e. **the tool's doc comment on its `Input` struct becomes the tool description sent to the model**. `input_schema` delegates to `language_model::tool_schema::root_schema_for::<Self::Input>(format)` (`:5011-5013`, module at `crates/language_model_core/src/tool_schema.rs`), and the erased impl additionally runs `adapt_schema_to_format(&mut json, format)` (`:5141-5145`) to downgrade the schema for providers with restricted JSON-Schema support (`LanguageModelToolSchemaFormat`, chosen per model via `LanguageModel::tool_input_format()`, `crates/language_model/src/language_model.rs:154-156`).

There is a hard limit: `MAX_TOOL_NAME_LENGTH: usize = 64` (`thread.rs:73`), with sanitisation at `:79` and MCP-name disambiguation logic at `:4099-4119`.

### 5.3 Malformed tool calls

Every failure mode becomes a tool result fed back to the model. Nothing hard-fails the turn.

| Failure | Handling | Cite |
|---|---|---|
| Unknown tool name | `is_error: true`, content `"No tool named {name} exists"` | `thread.rs:3455-3464` |
| Non-JSON tool-use payload | `is_error: true`, content is the conversion error | `:3468-3481` |
| Provider reports a JSON parse error mid-stream | `ToolInput::invalid_json(msg)`, tool is still *run* and its `recv()` returns `Err("Error parsing input JSON: …")` | `:3634-3696`, `:4877-4886`, `:4900-4902` |
| Args parse but don't match `Input` | `serde_json::from_value` fails inside `ToolInput::next` (`:4918`), surfaces as `Err` from `recv()`; the tool returns its `Output` error arm | `:4914-4924` |
| Tool returns image, model can't do images | Replaced with a text placeholder, or errored if image-only | `:3583-3619` |

**Coercion exists, and it is narrow and pragmatic.** `deserialize_maybe_stringified` (`crates/agent/src/tools.rs:44-63`) is a serde helper accepting either the structured value or a JSON-encoded *string* of it, with the comment *"Some models occasionally stringify nested arguments"*. That is the only type coercion I found. There is no equivalent of TypeBox `Value.Convert`: a string where a number was expected is a plain deserialization error.

### 5.4 The built-in set

29 tool modules (`crates/agent/src/tools.rs:1-29`), registered in `Thread::add_default_tools` (`thread.rs:2091-2163`): `copy_path`, `create_directory`, `delete_path`, `edit_file`, `write_file`, `fetch`, `find_path`, `grep`, `list_directory`, `move_path`, `read_file`, `terminal` + `sandboxed_terminal`, `search_web`, `diagnostics`, `find_references`, `get_code_actions`, `apply_code_action`, `go_to_definition`, `rename_symbol`, `spawn_agent`, `create_thread`, `list_agents_and_models`, `skill`. Several are behind feature flags (`CreateThreadToolFeatureFlag`, `LspToolFeatureFlag`, `RenameToolFeatureFlag` — `tools.rs:32-35`).

The LSP-backed tools (`go_to_definition`, `find_references`, `get_code_actions`, `apply_code_action`, `rename_symbol`, `diagnostics`) are the differentiator versus a terminal-hosted agent: they exist because the harness lives inside the editor and can reach the language servers directly.

---

## 6. Context management

**Compaction exists, is on by default, and runs at the top of every loop iteration.**

- **Setting** (`crates/settings_content/src/agent.rs:175-189`, defaults at `assets/settings/default.json:1154-1166`): `auto_compact: { enabled: true, threshold: "90%" }`. The threshold is a small DSL — a percentage string of the input window, a positive integer (absolute token count), or a negative integer (headroom remaining). `0` is invalid.
- **Trigger** — `compaction_message_target_ix` (`crates/agent/src/thread.rs:4299-4355`):
  1. Bail if disabled (`:4301`).
  2. Compute `max_input_tokens = max_token_count − max_output_tokens`; bail if under `MIN_COMPACTION_CONTEXT_WINDOW = 80_000` because there isn't room for a compaction pass (`:4307-4313`).
  3. Anchor on **real reported usage**, not an estimate: walk messages in reverse for the most recent `User` message with a recorded `request_token_usage` (`:4314-4329`). If nothing has usage, no compaction.
  4. **Anti-double-compaction guard**: if the latest `Compaction` message is *after* the usage-bearing message, that usage number is stale and pre-compaction, so bail (`:4330-4334`). Structurally the same guard pi implements at `agent-session.ts:2022-2032`.
  5. Compare `total_input_tokens(usage) + usage.output_tokens` against the threshold (`:4336-4341`).
  6. Insert *before* a trailing not-yet-sent user message if there is one, else at the end (`:4343-4353`).
- **Mechanism** — `perform_compaction_if_needed` → `build_compaction_request` (`:4369-4392`) rebuilds the request up to the insertion point and appends `COMPACTION_PROMPT` as a user message; `stream_compaction` (`:3116+`) streams the summary, emitting `ContextCompaction` / `ContextCompactionUpdate` events so the UI shows it live. Compaction is cancellable at three points (`:3131-3140`, `:3145-3154`).
- **What survives** — a `Message::Compaction(CompactionInfo::Summary(_))` is inserted into the message list (`:182-194`), and on subsequent request builds `extend_request_history_until` (`:4731-4757`) starts from the latest compaction index but *prepends* `retained_user_request_messages_before` — the user's own messages from before the boundary, newest-first, up to `COMPACTION_RETAINED_USER_MESSAGES_BYTE_BUDGET = 80_000` bytes (`:124`, `:4765-4780`). So user intent survives compaction verbatim; tool traffic does not. This is a different bet from pi's file-ledger approach (pi carries a read/modified file list forward; Zed carries the user's words forward).
- **Provider-native compaction** — `CompactionInfo::ProviderNative { provider, items }` (`:192-194`) plus `LanguageModel::supports_server_side_compaction()` (`crates/language_model/src/language_model.rs:130`) and a `LanguageModelCompletionEvent::Compaction(_)` variant (`:220`). Some providers do the compaction server-side and hand back opaque items.
- **Telemetry** — compaction outcomes are instrumented with trigger/retries/before-after tokens (`thread.rs:2721-2784`, `:4256-4267`).
- Manual compaction: `Thread::compact` (`:2509`) with `forced_compaction_target_ix` (`:4359-4367`).

---

## 7. Thread / session persistence

**SQLite with zstd-compressed JSON blobs**, at `paths::data_dir()/threads/threads.db` (`crates/agent/src/db.rs:434-437`).

Schema (`db.rs:440-475`) — a base table plus idempotent `ALTER TABLE` migrations:

```sql
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL,
    data_type TEXT NOT NULL, data BLOB NOT NULL
)
-- later columns: parent_id, folder_paths, folder_paths_order, created_at
```

- `data_type` is `"json"` or `"zstd"` (`db.rs:362-381`); writes use zstd level 3 (`:172-175`, `:491`, `:523`).
- The blob is a serialized `DbThread` (`db.rs:53-86`): title, `Vec<Arc<Message>>`, timestamps, token usage, model, **`profile`**, subagent context, thinking settings, draft prompt, UI scroll position, sandboxed-terminal temp dir, and `sandbox_grants`. Note the UI state (scroll position, draft) lives in the same blob as the conversation.
- Versioned `DbThread::VERSION = "0.3.0"` with an upgrade path from the pre-ACP format (`db.rs:184-199`, `crates/agent/src/legacy_thread.rs`).
- Saving is observer-driven: `cx.observe(&thread_handle, |this, thread, cx| this.save_thread(thread, cx))` (`crates/agent/src/agent.rs:820-821`), i.e. any `cx.notify()` on the thread schedules a save. There is a shutdown flush path (`agent.rs:1810-1817`).
- `ZED_STATELESS` swaps in an in-memory connection (`db.rs:420-421`).

**The conversation is linear, not a tree.** `messages: Vec<Arc<Message>>` with four variants (`thread.rs:182-187`). There is no `parentId` per entry and no branch structure.

- **Rewind is destructive**: `Thread::truncate(client_user_message_id)` (`thread.rs:2342-2368`) cancels the turn, finds the user message, and `self.messages.drain(position..)` — the tail is gone, along with its token-usage records.
- **`parent_id` on the threads table is not branching** — it is the subagent relationship. `DbThreadMetadata.parent_session_id` (`db.rs:30`) is set from `thread.parent_thread_id()` (`agent.rs:765`); subagents are separate `Thread` entities with their own session ids, spawned by `spawn_agent` and capped at `MAX_SUBAGENT_DEPTH = 1`.
- Compaction is in-band (a `Message::Compaction` in the same `Vec`), not a separate entry type.

**Resume** rebuilds a `Thread` from `DbThread` (`thread.rs:1708-1770`): messages verbatim, `profile` (falling back to `settings.default_profile`), model (falling back to the profile's `default_model` via `resolve_profile_model`, `:1727`), thinking settings, sandbox grants. Tool *cards* in the UI are reconstructed by calling each tool's `replay` (§5.1).

---

## 8. The provider seam

`pub trait LanguageModel: Send + Sync` (`crates/language_model/src/language_model.rs:55`). The core method:

```rust
fn stream_completion(
    &self,
    request: LanguageModelRequest,
    cx: &AsyncApp,
) -> BoxFuture<'static, Result<
        BoxStream<'static, Result<LanguageModelCompletionEvent, LanguageModelCompletionError>>,
        LanguageModelCompletionError>>;
```

— `:163-173`. So: a future yielding a stream of `Result<LanguageModelCompletionEvent, …>`. Unlike pi's `StreamFn` (whose documented invariant is "never throw"), Zed's seam is fallible in **two** places — the connect future and each stream item — and `run_turn_internal` handles both (`thread.rs:2817-2820` for the former, `:2894-2896` for the latter).

The rest of the trait is capability negotiation, and it is large: `supports_thinking`, `supports_disabling_thinking`, `supports_fast_mode`, `supported_effort_levels`, `supports_server_side_compaction`, `supports_images`, `supports_tools`, `supports_tool_choice`, `supports_streaming_tools`, `supports_split_token_display`, `tool_input_format`, `max_token_count`, `max_output_tokens`, `refusal_fallback_model_id`, `model_cost_info`, `requires_data_retention` (`:56-161`). Every one of these is a place where the harness bends to the provider rather than the provider bending to a normalized interface.

`LanguageModelCompletionEvent` variants observed at the consumption sites: `Queued`, `Started`, `StartMessage`, `Text`, `Thinking`, `RedactedThinking`, `ReasoningDetails`, `ToolUse`, `ToolUseJsonParseError`, `Stop`, `Compaction`, `UsageUpdate` (`language_model.rs:208-224`).

**19 providers ship** (`crates/language_models/src/language_models.rs:9-33` plus the `provider/` directory): `anthropic`, `anthropic_compatible`, `api_compatible`, `bedrock`, `cloud` (Zed's own hosted service), `copilot_chat`, `deepseek`, `google`, `llama_cpp`, `lmstudio`, `mistral`, `ollama`, `open_ai`, `open_ai_compatible`, `open_router`, `openai_subscribed`, `opencode`, `vercel_ai_gateway`, `x_ai`. Plus `fake_provider` for tests (`crates/language_model/src/fake_provider.rs`).

Providers register into a `LanguageModelRegistry` GPUI entity (`crates/language_model/src/registry.rs`) — `register_provider` / `unregister_provider` (`language_models.rs:186-239`). **WASM extensions can register providers** through `ExtensionLanguageModelProviderProxy` (`crates/language_models/src/extension.rs:38-53`), and there is a `BUILTIN_TO_EXTENSION_MAP` so an installed `anthropic` extension hides the built-in `anthropic` provider (`extension.rs:11-25`).

---

## 9. The UI boundary

Zed's agent runs in-process with the UI, but the seam is drawn deliberately and it is **not** direct method calls from the harness into views.

**Events flow through a channel, then into a GPUI entity.**

1. `Thread` (in `agent`) emits into `mpsc::UnboundedSender<Result<ThreadEvent>>`, wrapped as `ThreadEventStream` (`thread.rs:2648-2649`). `ThreadEvent` has 12 variants (enumerated by the match at `agent.rs:2176-2277`): `UserMessage`, `AgentText`, `AgentThinking`, `ToolCallAuthorization`, `ToolCallAuthorizationResolved`, `ToolCall`, `ToolCallUpdate`, `SubagentSpawned`, `Retry`, `ContextCompaction`, `ContextCompactionUpdate`, `Stop`.
2. `NativeAgentConnection::handle_thread_events` (`agent.rs:2163-2286`) is a spawned task that drains the receiver and translates each event into a mutation on `Entity<AcpThread>` — `push_assistant_content_block`, `upsert_tool_call`, `update_tool_call`, and so on.
3. `AcpThread` (in `acp_thread`) is the UI-facing conversation model. It is a GPUI entity that `impl EventEmitter<AcpThreadEvent>` (`crates/acp_thread/src/acp_thread.rs:2169`) with variants `StatusChanged`, `PromptUpdated`, `NewEntry`, … (`:2144-2147`). Views subscribe with `cx.subscribe` (e.g. `crates/agent_ui/src/conversation_view.rs:277`).

The important consequence: **the harness never touches a view.** It writes to a channel; a bridge task writes to an entity; views observe the entity. `acp_thread` does not depend on `agent`. This is exactly the seam an external ACP agent plugs into.

**Cancellation** is a `watch::channel(false)` created per turn (`thread.rs:2653`), with the sender held in `RunningTurn`. `Thread::cancel` (`:2239-2258`) cancels running subagents, takes `running_turn`, and awaits `RunningTurn::cancel()`. Every long await in the loop selects on `cancellation_rx.changed()` — the event loop (`:2853`), the retry backoff timer (`:3070-3078`), the compaction request (`:3131`) and its stream (`:3145`). Tools get the same receiver via `ToolCallEventStream` and expose it as `cancelled_by_user()` (a future) and `was_cancelled_by_user()` (a poll) — `:5474-5494`.

**Tool approval — how the harness blocks on a human.** This is the cleanest part of the design.

`ToolCallEventStream::authorize(title, context, cx) -> Task<Result<()>>` (`thread.rs:5613-5634`). A tool simply awaits it; `Err` means denied and the tool returns its error output. Underneath, `run_authorization_loop` (`:6173-6291`):

1. Evaluate settings first. `ToolPermissionDecision::Allow` → `Task::ready(Ok(()))`, no UI at all. `Deny(reason)` → `Task::ready(Err(...))`. Only `Confirm` proceeds (`:6181-6190`).
2. Create a `oneshot::channel`, send a `ThreadEvent::ToolCallAuthorization { tool_call, options, response: response_tx, kind }` down the event stream (`:6207-6225`), and await the receiver.
3. The bridge task turns that into `acp_thread.request_tool_call_authorization(...)`, awaits the user's choice on a background task, and sends the outcome back through the oneshot (`agent.rs:2198-2223`).
4. While waiting, the loop **also** watches `SettingsStore` via `cx.observe_global` and re-evaluates the settings check on every change (`:6238-6288`). So when the user clicks "Always allow" on one pending tool call, every *other* pending prompt — including ones in subagent turns — auto-resolves. The prompt UI is dismissed by resolving the tool call's `WaitingForConfirmation` status with a synthetic outcome, and `response_rx` is dropped so the synthetic answer can't re-enter the loop.
5. `persist_permission_outcome` (`:6295+`) writes "always" decisions back to `settings.json` via the `Fs` handle.

No blocking, no locks: it's an async task awaiting a oneshot, racing a settings watch.

---

## 10. ACP and `agent_servers` — is the harness swappable?

**Yes. Zed's own agent is not privileged; it implements the same trait as external agents.**

The two traits:

- `AgentServer` (`crates/agent_servers/src/agent_servers.rs:50-104`) — a *factory*: `agent_id`, `logo`, `connect(delegate, project, cx) -> Task<Result<Rc<dyn AgentConnection>>>`, plus default-mode and config-option accessors.
- `AgentConnection` (`crates/acp_thread/src/connection.rs:91-260`) — the *session interface*: `new_session`, `load_session`, `resume_session`, `close_session`, `prompt`, `cancel`, `truncate`, `set_title`, `authenticate`/`auth_methods`/`logout`, `model_selector`, `session_modes`, `session_config_options`, `session_list`, `request_elicitations`, `telemetry`. Most have `supports_*` default-false companions so partial implementations are legal.

Zed's built-in agent implements both, in about a hundred lines of adapter:

```rust
impl AgentServer for NativeAgentServer {
    fn agent_id(&self) -> AgentId { crate::ZED_AGENT_ID.clone() }
    fn connect(&self, _delegate, _project, cx) -> Task<Result<Rc<dyn acp_thread::AgentConnection>>> {
        cx.spawn(async move |cx| {
            let agent = cx.update(|cx| NativeAgent::new(thread_store, templates, fs, cx));
            Ok(Rc::new(NativeAgentConnection(agent)) as Rc<dyn acp_thread::AgentConnection>)
        })
    }
}
```

— `crates/agent/src/native_agent_server.rs:23-59`. Note it ignores the `delegate` (which is about spawning/updating a child process) and constructs an in-process entity instead. `NativeAgentConnection` then implements `AgentConnection` (`agent.rs:2637` for `prompt`, `:2661` for `cancel`, `:2673` for `truncate`).

External agents take the other route: `AcpConnection::stdio(...)` (`crates/agent_servers/src/acp.rs:642`, `:796`) spawns a child process with piped stdin/stdout/stderr (`:850`) and speaks the Agent Client Protocol (the external `agent-client-protocol` crate, imported as `agent_client_protocol::schema::v1 as acp`) over it, with a dispatch task (`:963`), a stderr drain (`:902`), and a wait task (`:1008`). `CustomAgentServer` (`crates/agent_servers/src/custom.rs:23-31`) is the generic user-configured variant; the named ones are `gemini`, `claude-acp`, `codex-acp`, `cursor` (`custom.rs:17-20`).

The strongest evidence that the seam is real: **the built-in agent runs the same e2e test suite as external agents.** `agent_servers::e2e_tests::common_e2e_tests!` is invoked against `NativeAgentServer` (`native_agent_server.rs:67-101`) using the same macro external agents use.

Where the built-in agent *is* privileged:

- Profiles (§3.8) — only `agent::Thread` gets them; external agents get session modes.
- `acp_thread::AcpThread` and its mention/terminal/diff machinery are shared, but the tool *cards* rendered for built-in tools have bespoke UI in `agent_ui`.
- Zed's agent participates in editor internals (LSP tools, buffer diffs, the action log) that ACP does not expose.

So: the harness is a swappable component *at the session-interface level*. You can drop in a different agent implementation and the whole UI works. You cannot swap the *loop* underneath Zed's own agent — `Thread` is concrete.

---

## 11. Extensions

Zed extensions are WASM components with a WIT-defined host surface (`crates/extension_api/wit/since_v0.8.0/`).

**Extensions cannot register agent tools.** The v0.8.0 WIT world exports `language-servers`, `slash-commands`, `dap`, `context-server-command`, `context-server-configuration`, `github`, etc. Grepping `extension.wit` for tool/agent-related exports yields only:

```
export context-server-command: func(context-server-id: string, project: borrow<project>) -> result<command, string>;      // :157
export context-server-configuration: func(...) -> result<option<context-server-configuration>, string>;                    // :160
```

So an extension's route to adding a tool is: **ship an MCP server**. The extension supplies the command line and configuration; `context_server` (6,174 lines) runs the client; `tools/context_server_registry.rs` (658 lines) surfaces the server's tools to the thread; and the profile decides whether they are exposed (`thread.rs:4086-4097`).

The two things extensions *can* do to the agent directly:

1. **Register a language model provider** — `ExtensionLanguageModelProviderProxy::register_language_model_provider` (`crates/language_models/src/extension.rs:38-53`). This is a native-Rust proxy path, not a WIT export, and I did not trace how a WASM extension reaches it (§12).
2. **Register an agent server** — `AgentServer`/`agent_servers` are referenced from `crates/extension/src/extension_manifest.rs`, so the manifest can declare one. I did not read that path in detail (§12).

Skills are the non-code extension surface: `SKILL.md` files under `.agents/skills` (`crates/agent_skills/agent_skills.rs:13-17`, `SKILL_FILE_NAME` at `:53`), discovered at global (`~/.agents/skills`) and project (`{project}/.agents/skills`) scope with explicit precedence (`:99-121`), size-capped at 100 KB per file (`:46`), and surfaced to the model through the `skill` tool (`crates/agent/src/tools/skill_tool.rs`, 815 lines) with a catalog-description budget enforced in `agent.rs:3476-3509`. Built-in skills are compiled into the binary (`crates/agent_skills/builtin/`).

---

## 12. Permissions and sandboxing

Two independent layers, both **global settings, not per-profile**.

### 12.1 Tool permissions

`agent.tool_permissions` (`crates/settings_content/src/agent.rs:349`, `:827-888`):

```rust
pub struct ToolPermissionsContent {
    pub default: Option<ToolPermissionMode>,               // allow | deny | confirm (default: confirm)
    pub tools: HashMap<Arc<str>, ToolRulesContent>,        // keyed by tool name, incl. "mcp:server:tool"
}
pub struct ToolRulesContent {
    pub default: Option<ToolPermissionMode>,
    pub always_allow:   Option<ExtendingVec<ToolRegexRule>>,
    pub always_deny:    Option<ExtendingVec<ToolRegexRule>>,
    pub always_confirm: Option<ExtendingVec<ToolRegexRule>>,
}
pub struct ToolRegexRule { pub pattern: String, pub case_sensitive: Option<bool> }
```

Rules are **regexes matched against the tool's meaningful input text** — the command for `terminal`, the path for file tools, the URL for `fetch`; for `copy_path`/`move_path` each path is matched independently (`agent.rs:850-853`). Precedence, per the doc comments: `always_deny` > `always_confirm` > `always_allow` > per-tool `default` > global `default` (`:859-875`). Two properties are called out in the source:

- `ExtendingVec` means patterns **accumulate across settings layers and cannot be removed by a higher-priority layer** — only added (`:854-855`, `:863-864`, `:872-873`).
- `always_deny` is marked `**SECURITY**: These take precedence over ALL other rules, across ALL settings layers` (`:860`).

The engine is `crates/agent/src/tool_permissions.rs` (2417 lines): `ToolPermissionDecision::{Allow, Deny(reason), Confirm}` (`:208`), `decide_permission_from_settings(tool_name, inputs, settings)` (`:467-478`) which passes `ShellKind::system()` so terminal commands are decomposed shell-aware, and `decide_permission_for_paths` which evaluates both the raw and the `..`-normalised path and takes the **most restrictive** result (`:514-534`). There is a `HardcodedSecurityRules` struct at `:21` that settings cannot disable.

Default in `assets/settings/default.json:1124`: `"default": "confirm"` — Zed prompts for everything by default, with commented-out examples showing `git reset --hard` / `git push --force` under `always_confirm` and `.env`/`secrets/`/`*.pem`/`*.key` under `always_deny` (`:1129-1146`).

### 12.2 Sandboxing

Real OS sandboxing, not a policy layer. `crates/agent/src/sandboxing.rs:19-21`: *"macOS (Seatbelt), Linux (Bubblewrap), and Windows (Bubblewrap via WSL) have real sandbox integrations; on platforms without one the per-command wrap is a no-op."* Implementation in the `sandbox` crate (8,228 lines).

Policy is `agent.sandbox_permissions` (`crates/settings_content/src/agent.rs:785-823`): `allow_all_hosts`, `network_hosts` (exact or `*.` wildcard), `allow_fs_write_all`, `allow_unsandboxed`, `write_paths`, `warn_confusable_unicode`. The sandbox always grants write to the project's worktree roots (`sandboxing.rs:39-44`) and always *protects* `.git` directories, including ones that don't exist yet so a command can't `git init` its way in (`sandboxing.rs:46-61`).

Escalation is a three-lifetime prompt — "once" / "for the rest of this thread" / "always" — via `ToolCallEventStream::authorize_sandbox` (`thread.rs:5660-5700`). Thread grants live in `ThreadSandboxGrants` and are **persisted with the thread** (`DbSandboxGrants`, `crates/agent/src/db.rs:88-118`) so reopening a thread keeps them. "Always" grants go to settings.

`allow_unsandboxed` is described as the model-facing off switch: it changes which terminal tool is registered *and* removes the sandbox section from the system prompt (`sandboxing.rs:9-17`, prompt flag at `thread.rs:4223-4226`).

### 12.3 Restricted worktrees

A third gate, orthogonal to both. `TrustedWorktrees::has_restricted_worktrees` (used at `thread.rs:2206`, `:4046`, `:3550`) enforces at three points: it downgrades the *profile* at thread start (§3.6), it filters tools out of `enabled_tools` (`:4051`), and it re-checks inside `run_tool` because a workspace can become restricted mid-thread (`:3546-3564`).

---

## 13. Comparison: Zed vs pi vs Claude Code

pi and Claude Code rows are carried over from `docs/RESEARCH-agent-harnesses.md` (pi from source, Claude Code from public docs only). Evidence quality differs by column — Zed and pi are read from source; Claude Code is documented surface.

| Dimension | Zed | pi | Claude Code (documented) |
|---|---|---|---|
| **Language / runtime** | Rust, in-process with a GPUI editor | TypeScript / Node | Not published |
| **Licence** | GPL-3.0-or-later (`crates/agent/Cargo.toml:6`) | MIT | Proprietary |
| **Harness size** | `agent` 85k lines incl. tests; loop itself ~400 lines (`thread.rs:2702-3050`) | `agent` ~10.4k; loop 793 lines | n/a |
| **Provider coupling** | Provider-agnostic; `LanguageModel` trait, 19 providers, extensions can add more | Provider-agnostic; `StreamFn`, ~45 providers / 10 wire APIs | Anthropic models only; "provider" = hosting choice |
| **Streaming type** | `BoxFuture<Result<BoxStream<Result<Event, Error>>, Error>>` — fallible at both levels (`language_model.rs:163`) | `StreamFn` with a documented never-throw invariant | Opt-in `StreamEvent` via `includePartialMessages` |
| **Loop termination** | No tool calls in the response; or steering boundary; or cancel; or unretryable error (`thread.rs:2993-3048`) | No tool calls + empty queues; or `shouldStopAfterTurn`; or error/abort | No tool calls; plus `maxTurns` / `maxBudgetUsd` |
| **Run caps** | **None.** Only `MAX_RETRY_ATTEMPTS = 4`, `MAX_SUBAGENT_DEPTH = 1` | **None** | `maxTurns`, `maxBudgetUsd` |
| **Tool declaration** | Rust trait with associated `Input`/`Output` types; `schemars` derives the schema; doc comment becomes the description (`thread.rs:4982-5013`) | `AgentTool` object, TypeBox schema | Not documented |
| **Schema adaptation per model** | Yes — `LanguageModelToolSchemaFormat` + `adapt_schema_to_format` (`thread.rs:5141-5145`) | Yes — per-API `compat` overrides | Not documented |
| **Bad tool args** | Error string returned as a tool result; turn continues (`thread.rs:3455-3481`, `:3634-3696`) | Formatted validation errors returned as the tool result | Not documented |
| **Arg coercion** | Minimal: `deserialize_maybe_stringified` only (`tools.rs:44-63`) | Broad: TypeBox `Value.Convert` + JSON-Schema fallback | Not documented |
| **Tool dispatch** | Concurrent by default (`FuturesUnordered`), no per-tool opt-out; streaming tool inputs supported | Parallel by default, whole batch downgraded to serial if any tool declares `sequential` | Read-only tools concurrent, mutating tools serial |
| **Built-in tools** | 29 modules incl. 6 LSP-backed; 22 on in `write` | 7, 4 on by default | ~40 documented |
| **Profiles** | **Yes** — 5-field struct, tool toggle map + MCP presets + default model; 3 built-ins | No such concept | No such concept (subagents are the nearest analogue) |
| **Permission gate** | First-class: allow/deny/confirm, per-tool regex rules, accumulate-only across layers, `always_deny` wins globally | **Absent by design**; `beforeToolCall` hook with no policy shipped | First-class: allow/ask/deny, 6 modes, deny→ask→allow |
| **Permission ↔ profile** | **Independent.** Permissions are global; profiles only decide *exposure* | n/a | Subagents can carry their own permissions |
| **Sandbox** | Real: Seatbelt / Bubblewrap / WSL-Bubblewrap, with three-lifetime escalation prompts and per-thread grants | **Absent by design**; delegate to container/VM | OS-level sandbox for Bash and children |
| **Context handling** | Auto-compaction on by default at `"90%"`; usage-anchored; anti-double-compaction guard; retains 80 KB of *user* messages across the boundary; provider-native compaction supported | Compact when `tokens > window − 16384`; keeps ~20k recent; carries a read/modified **file ledger** forward | Clear old tool outputs first, then summarize; anti-thrash cutoff |
| **Persistence** | SQLite (`threads.db`), one zstd-compressed JSON blob per thread, versioned `0.3.0` | Append-only JSONL **tree**, v3, per-cwd directory | JSONL under `~/.claude/projects/` |
| **Conversation shape** | **Linear.** `Vec<Message>`; rewind = `drain(position..)`, destructive | **Tree.** `parentId` per entry; branch + branch-summarization | Linear; `--fork-session` copies to a new id |
| **Sub-agents** | Yes — `spawn_agent` tool, separate `Thread`, depth capped at 1, inherits parent profile | **Absent, deliberate** | Yes — own context window and permissions |
| **MCP** | Yes — `context_server` crate, 4 transports + OAuth; per-profile enable/disable | **Absent, deliberate** | Core |
| **Extensibility** | WASM extensions: MCP servers, LSPs, themes, slash commands, LLM providers. **Cannot register agent tools directly** | One very wide in-process TS extension surface, 25 events, can rewrite almost anything | Hooks (out-of-process), MCP, skills, subagent files, plugins |
| **External agent support** | **Yes, first-class** — ACP over stdio; Gemini/Claude/Codex/Cursor + custom | No | No (it is the agent) |
| **UI seam** | mpsc channel → bridge task → GPUI entity → `EventEmitter` → views. Harness never touches a view | `packages/tui` is agent-agnostic, but tools import TUI components directly | Terminal / IDE / desktop / web on one engine |
| **Cancellation** | `watch::channel(bool)` selected on at every await; propagates to tools and subagents | Abort signal threaded through tools | Interruptible at any point |
| **Approval mechanism** | Tool awaits a `Task<Result<()>>`; oneshot back-channel; racing settings-watch auto-resolves siblings | n/a (no gate) | Permission prompt / hooks |

### 13.1 The three positions in one paragraph each

**pi** treats the harness as a small provider-neutral kernel and pushes everything else — MCP, subagents, permissions, plan mode — into one very wide extension seam. Its distinguishing engineering investment is the multi-provider layer (`packages/ai`, ~21k lines) and the session *tree*.

**Claude Code** treats the harness as a governable product: many narrow extension mechanisms, each with a bounded blast radius, plus a four-tier settings hierarchy with a non-overridable managed tier. Its distinguishing investments are the permission language and org policy.

**Zed** treats the harness as an *editor subsystem*. It gets things neither of the others can have — LSP-backed tools, buffer-level diff review, in-process entity plumbing with no serialization tax — and it pays for them by being inseparable from GPUI. Its two distinguishing investments are (a) the **ACP seam**, which makes competitor agents first-class citizens of its own UI, and (b) real **OS sandboxing** with a three-lifetime escalation model, which neither of the others attempts (pi explicitly declines; Claude Code has a sandbox but its grant model is not documented at this granularity). Profiles, notably, are its *smallest* investment, not its largest.

### 13.2 Where Zed and pi make opposite calls

- **Conversation shape.** pi's tree (`parentId` per entry) buys branching, rewind-without-loss, and branch summarization. Zed's `Vec` + destructive `drain` is far simpler and gives up all three. Zed compensates with subagents (separate threads with `parent_id`) for the "explore without polluting" use case.
- **What survives compaction.** pi carries a *file-operation ledger* forward. Zed carries the *user's own messages* forward (80 KB budget). pi is optimising for "don't forget what you touched"; Zed for "don't forget what I asked". Zed can afford this because it can always re-read a file through the editor.
- **Argument coercion.** pi coerces aggressively (TypeBox `Value.Convert`). Zed coerces almost not at all — one stringified-JSON helper — and relies on returning the serde error to the model.
- **Permission philosophy.** pi ships the hook and no policy. Zed ships a regex policy engine with accumulate-only merge semantics and a hardcoded rule set that settings cannot weaken.

---

## 14. What this means for a Rust harness in Tauri

The reader is building a Rust agent harness inside a Tauri app with a Zed-style profile feature. Concretely:

### 14.1 Transfers directly (pure Rust, no GPUI)

- **The `AgentTool` trait shape.** Associated `Input: JsonSchema` + `Output`, `const NAME`, `schemars` for the schema, doc-comment-as-description, and the `Erased<Arc<T>>` → `dyn AnyAgentTool` pattern (`thread.rs:4982-5190`). This is idiomatic Rust with zero GPUI in it. The `Result<Output, Output>` convention — errors are structured model-readable output, not `anyhow::Error` — is the single best idea in the file and costs nothing to adopt.
- **`ToolInput<T>` as a channel.** Making the tool's argument a stream (`Partial(Value)` … `Full(T)` | `InvalidJson`) rather than a value (`thread.rs:4856-4938`) is what lets `edit_file` start work before the model finishes emitting arguments. Worth copying if you want that; skip it if you don't — the non-streaming case is `ToolInput::ready(value)` and costs one extra `.recv().await`.
- **The turn loop.** `run_turn_internal` (`thread.rs:2702-3050`) uses only `futures` (`select!`, `FuturesUnordered`, `now_or_never`) and a `watch` channel. Nothing GPUI-specific. Port it as-is. The `drop(events)` before awaiting tools (`:2920-2925`) and the "drop orphaned streaming senders" guard (`:2930-2938`) are both bugs someone already found for you.
- **`watch::channel(bool)` cancellation, selected on at every await point.** This is the correct Rust answer and it transfers to Tokio unchanged. Note the discipline: *every* long await in the loop selects on it, including the retry backoff timer and the compaction stream.
- **The permission decision engine.** `tool_permissions.rs` is a pure function over `(tool_name, inputs, settings)` (`:467-478`). No UI, no async. The `decide_permission_for_paths` trick — evaluate raw *and* `..`-normalised, take the most restrictive (`:514-534`) — is a security detail you'd otherwise ship without.
- **Persistence.** SQLite + one zstd JSON blob per thread (`db.rs:440-475`) is about 200 lines of real work, is trivially portable (`rusqlite`), and gets you cheap listing (indexed columns) with cheap loading (one blob). Zed's `data_type` column allowing `"json"` or `"zstd"` is a nice migration hedge. Given the linear message model, you do not need pi's JSONL-tree complexity.
- **The `MergeFrom` settings layering with `IndexMap<String, bool>` toggle maps.** The reason profiles are cheap (see §14.3) is entirely this. It is a derive macro over serde structs, not a GPUI feature.

### 14.2 Depends on GPUI and does not transfer

- **`Entity<T>` / `cx.update` / `cx.observe` / `EventEmitter`.** The entire `AcpThread` layer, `NativeAgentConnection::handle_thread_events`, the observer-driven autosave (`agent.rs:820-821`), and `cx.observe_global::<SettingsStore>` inside the authorization loop (`thread.rs:6239-6243`) are GPUI's reactive object graph. In Tauri you have a WebView on the other side of an IPC boundary, so:
  - The `Thread → mpsc<ThreadEvent> → bridge → Entity<AcpThread> → EventEmitter → views` chain collapses to `Thread → mpsc<ThreadEvent> → serialize → tauri emit → frontend store`. **Your `ThreadEvent` enum must be `Serialize`.** Zed's is not — `ThreadEvent::ToolCallAuthorization` carries a `oneshot::Sender` (`thread.rs:6210-6220`) and `ToolCallUpdateDiff` carries an `Entity<Diff>` (`:5522-5528`). Design your event enum serializable from day one; keep the back-channels in a side table keyed by tool-call id.
  - Zed's UI reads *live* state off the entity (`thread.read(cx).profile()`). You can't. Either mirror state into the frontend on every change, or expose `#[tauri::command]` getters. Mirroring is the one that scales.
- **Single-threaded foreground executor.** `cx.foreground_executor().spawn` (`thread.rs:3580`) and `AsyncApp` mean Zed's tools are `!Send`-friendly: they touch `Entity<Project>`, buffers, and language servers on one thread. In Tauri your harness will almost certainly live on a Tokio multi-threaded runtime, so **your tools must be `Send + 'static`**. That is a real constraint, not a cosmetic one: it rules out the `Rc`/`RefCell` sprinkled through Zed's tool code (e.g. `Rc<RefCell<ThreadSandboxGrants>>`, `thread.rs:5440`) in favour of `Arc<Mutex<…>>`.
- **The synchronous-looking approval flow.** `authorize()` returning a `Task<Result<()>>` that a tool just `.await`s (`thread.rs:5613`) is portable *in shape*, but the plumbing isn't: replace `Task` with `tokio::task::JoinHandle`/plain future, replace the GPUI oneshot round-trip with `tauri emit` + a `#[tauri::command] resolve_permission(tool_call_id, outcome)` that looks the sender up in a `Mutex<HashMap<ToolCallId, oneshot::Sender<Outcome>>>`. **Keep the settings-watch race** (`:6250-6288`) — the "always allow" click resolving sibling prompts is a genuinely good UX property and it's ~30 lines.
- **Everything editor-shaped.** The LSP tools, `buffer_diff`, the action log, mention resolution (`acp_thread/src/mention.rs`, 1773 lines), and the multibuffer diff review have no analogue outside an editor. If your Tauri app isn't an editor, that's ~40% of `crates/agent/src/tools` you neither need nor can build.
- **The `sandbox` crate.** Not GPUI-dependent, but 8,228 lines of platform work (Seatbelt profiles, Bubblewrap argv construction, WSL bootstrapping). Zed only gets real isolation on three platforms and no-ops elsewhere (`sandboxing.rs:19-21`). Treat this as out of scope unless it's your product.

### 14.3 What Zed's profile implementation says about the cost of the feature

This is the decision-relevant finding. **A Zed-style profile feature is remarkably cheap — because Zed deliberately made it do almost nothing.**

The measurement:

- `crates/agent_settings/src/agent_profile.rs` is **309 lines, of which ~80 are tests**. That is the whole model layer.
- The data type is 5 fields (`agent_profile.rs:104-112`), 2 of which are the MCP variant of the 1st.
- The read API is 2 methods, 3 lines each (`is_tool_enabled`, `is_context_server_tool_enabled`, `:115-150`).
- Applying a profile is 1 filter predicate inside one function (`thread.rs:4064`, `:4088`).
- Switching a profile is 12 lines (`thread.rs:2216-2237`).
- The default profiles are **57 lines of JSON** (`assets/settings/default.json:1170-1226`).
- Persisting a profile is **one `Option<AgentProfileId>` field** on the thread blob (`db.rs:70-71`).
- The UI is the expensive part: `profile_selector.rs` is 35.6 KB (~1000 lines), i.e. **3× the model layer**.

The reason it's this cheap is a set of deliberate exclusions, and each one is a choice you should copy or reject knowingly:

1. **A profile configures tool *exposure* and nothing else.** No system prompt, no permissions, no sandbox policy, no temperature. If you add "profile has a system prompt", you've made the system prompt profile-dependent at request-build time — which Zed already tolerates indirectly (`available_tools` feeds the Handlebars template, `thread.rs:4219`) — but you've also created a persistence question Zed doesn't have: which prompt was in force for which message? Zed sidesteps it entirely by storing only the current profile id.
2. **No runtime inheritance.** "Base profile" is a copy-at-creation convenience (`agent_profile.rs:53-72`), not a link. Inheritance would mean a resolution order, cycle detection, and a diff UI. Zed gets 90% of the benefit from the settings-layer merge instead — because the tool map is `name → bool`, a user profile keyed `"write"` merges field-by-field into the shipped `write` (`:508` derives `MergeFrom`), so `{"tools": {"fetch": false}}` is a valid one-key override. **If you want profile composition, get it from your settings merge, not from a profile graph.**
3. **User-level only.** Profiles never come from project settings (`settings_store.rs:1356-1361` — local settings contribute only `disable_ai`). This dodges the entire "untrusted repo ships a profile that enables `terminal`" threat model. Zed's answer to project-specific agent behaviour is `AGENTS.md` + skills + trusted-worktree gating, not project profiles. **Adding project-scoped profiles is not a small change; it is a security design.**
4. **Mid-conversation switching is free because nothing is derived from the profile except the tool list, and the tool list is rebuilt every loop iteration anyway** (`thread.rs:2797`). If you add profile-scoped state that *is* derived — a prompt, a model config, a memory scope — switching stops being a field assignment.
5. **Profiles are not exposed over the external-agent interface** (§3.8). Zed's ACP-facing analogue is session modes. If your harness has a plugin/remote agent story, decide early which side of that line profiles fall on.

Two things Zed's implementation gets right that are worth copying verbatim:

- **`is_unmodified_default`** (`agent_profile.rs:123-143`): compare the profile in merged settings against the profile in *raw default* settings to decide whether the user has customised it. Zed uses this so its automatic restricted-workspace downgrade never overrides a user's own configuration (`thread.rs:2205-2208`). Any "we'll pick a safer profile for you" behaviour needs this predicate or it will silently clobber user intent.
- **Absent ≠ false in storage, absent == false at read time.** `tools.get(name) == Some(&true)` (`agent_profile.rs:115-117`) with a `MergeFrom` map underneath. This one line is what makes both "allowlist" and "denylist-style override" expressible in the same structure. It is the single highest-leverage detail in the whole feature.

And one caution: Zed keeps **permissions orthogonal to profiles**. A profile decides whether the model *sees* `terminal`; `tool_permissions` decides whether a given `terminal` invocation *runs*. Merging the two would look like a simplification and would be a mistake — the tool set changes with the task, the safety rules should not.

---

## 15. Open questions / what I could not verify

Honest accounting. Everything above carries a citation except where noted here.

1. **Profile-switch persistence timing.** `set_profile` (`thread.rs:2216-2237`) contains no `cx.notify()`, and `set_model` (`:1976-1996`) emits `ModelChanged` but I did not find a `notify` in the portion I read. Saving is `cx.observe`-driven (`agent.rs:820-821`), which fires on notify. My conclusion — "a bare profile switch persists lazily, on the next notifying change" — is an **inference**. I did not trace whether `cx.emit` implies a notify in this GPUI version, nor did I read the test at `agent.rs:6507` whose comment mentions "no observe-triggered save has run for this change".
2. **Whether providers tolerate transcripts containing tool calls for undeclared tools.** I verified Zed does not filter history when the profile changes (`thread.rs:4731-4757`). Whether Anthropic/OpenAI/etc. accept that, or whether some provider adapter scrubs it, I did not check — I did not read any of the 19 provider implementations.
3. **How a WASM extension reaches `register_language_model_provider`.** I read the proxy (`crates/language_models/src/extension.rs:38-53`) and confirmed the v0.8.0 WIT world has no tool/model exports. The actual bridge from a WASM extension to that native proxy I did not trace, so "extensions can add providers" is read from the proxy's existence and the `BUILTIN_TO_EXTENSION_MAP`, not from an end-to-end path.
4. **Extensions declaring agent servers.** `crates/extension/src/extension_manifest.rs` matched a grep for `AgentServer`. I did not read it. Whether an extension can ship an ACP agent, and with what manifest keys, is unverified.
5. **`agent.rs` (6929 lines) and `acp.rs` (5020 lines) were sampled, not read.** Claims about `NativeAgent` beyond `handle_thread_events`, session creation, and the skills catalog, and about ACP beyond the stdio spawn shape, are correspondingly thin. In particular I did not read `AcpConnection`'s handling of `session/update` notifications.
6. **`acp_thread.rs` is 10,055 lines and I read only the event-emitter declaration and the call sites the agent crate uses.** The `AcpThread` entry model, mention resolution, and terminal integration are not characterised here.
7. **Compaction prompt content.** `COMPACTION_PROMPT` is imported from `agent_settings` (`thread.rs:21`) and lives under `crates/agent_settings/src/prompts/`. I did not read it.
8. **Tool concurrency limits.** I found no semaphore bounding *tool* concurrency, but I did find a rate-limit semaphore on completion *requests* referenced only in a comment (`thread.rs:2920-2925`). I did not locate where that permit is acquired, so "tool dispatch is unbounded-concurrent" is read from `FuturesUnordered` having no cap, not from an exhaustive search for a limiter.
9. **Line counts include inline tests.** Stated in §1 but worth repeating: the 85,010-line figure for `agent` is not comparable to pi's test-excluded figures without adjustment. I did not compute a test-excluded count.
10. **Zed's official AI docs were not consulted at all.** The task allowed them as secondary confirmation; I did not use them. So where Zed's *intent* differs from what the code does, this note reports the code and would not notice the discrepancy.
11. **Nothing here was executed.** I did not build or run Zed, did not run its tests, and did not observe a real agent turn. Every claim is static reading.
