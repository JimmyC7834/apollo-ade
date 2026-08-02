---
label: wayfinder:grilling
title: How `exec` runs a command without becoming the terminal
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# How `exec` runs a command without becoming the terminal

## Question

> **⚠ Read before starting.** Two findings from
> [How this repo depends on pi](07-pi-dependency.md) change what this ticket is looking
> at. (1) pi **0.82.0** replaced `AgentHarness`'s `ExecutionEnv` dependency with
> application-defined `toolContext` values and context-aware `AgentHarnessTool`
> definitions — so `ExecutionEnv` may not be the seam in the 0.83.0 we are pinning.
> (2) The `pi/` clone (`aa0ec808b`) is **ahead of published 0.83.0**, so every line
> number cited below may point at unreleased API. Verify against the pinned tarball
> first. The *shape* of the work is unchanged: Rust holds the authority, TypeScript
> adapts to whatever the current seam is.

The `Shell` half of `ExecutionEnv`, split from
[the filesystem half](01-execution-env-surface.md) because it is a different mechanism
and the entire security surface.

pi's contract (`types.ts`, `ShellExecOptions` / `Shell`):

```
exec(command, { cwd, env, inheritEnv, timeout, abortSignal, onStdout, onStderr })
  -> Result<{ stdout, stderr, exitCode }, ExecutionError>
```

**This is not the existing PTY.** `src-tauri/terminal.rs` is interactive, id-addressed,
event-streamed, merges the two output streams, and has no exit-code path. pi wants
one-shot capture with stdout and stderr **separated**, an exit code, a timeout, and
abort. That is a new Rust command over `std::process::Command`, not an adaptation.
The PTY keeps its job — the terminal panel.

Settle:

- **The security question, which is the real one.** `exec` runs arbitrary commands.
  `cd /` and twelve slices of root confinement are gone. `context.md` says Rust is the
  only process authority and stays root-confined; a general `exec` is in tension with
  that sentence, and this ticket is where the tension gets resolved out loud rather
  than quietly. Options run from "confine cwd only, accept that the command can leave"
  through "allowlist" to "always gated" — and the gate is
  [its own ticket](03-permission-gate.md), so decide here what `exec` *can* do, there
  what stops it.
- **Which shell, and how the command reaches it.** pi's Node env carries a
  `commandTransport: "argv" | "stdin"` distinction — worth understanding before
  reimplementing it. On Windows this is the difference between `cmd`, PowerShell, and
  Git Bash, and this repo's own tooling assumes Git Bash in places.
- **Abort.** `abortSignal` must kill a running child, and on Windows killing a process
  *tree* is its own problem — pi's Node env shells out to `taskkill /F /T /PID`. Decide
  what the Rust side does, because a half-killed tree leaks processes.
- **Streaming.** `onStdout` / `onStderr` are per-chunk callbacks in TypeScript; the
  data originates in Rust. Decide the transport (Tauri events? channel?) and whether
  v1 streams at all or only returns the final capture — the model rarely needs live
  output, but the *user* watching a long build does.
- **Timeout semantics.** pi's `timeout` is in seconds and expects a timeout-flavored
  error, distinct from a non-zero exit.
- **Output size.** Nothing in the contract caps it. A command emitting 200MB will go
  into a `Result<String>`, across the IPC, into a context window. Decide the cap and
  what truncation looks like — pi ships `truncateHead` and it is in the browser-safe
  export.

---

## Resolution

**A new one-shot Rust command over `std::process::Command`, cwd-confined but not
command-confined, running Git Bash where available.** The PTY in
`src-tauri/terminal.rs` keeps its job and is not touched.

### What pi already does, so `exec` does not have to

Established from the published 0.83.0 tarball. `createBashTool` calls
`executeShellWithCapture(env, command, { cwd, env, inheritEnv, timeout, abortSignal,
returnExecutionErrors, onChunk })`, and **pi owns capture, truncation, throttled
progress updates and overflow** on top of `env.exec`. Our implementation only has to run
a command and stream chunks.

Two corrections to what the map previously recorded:

- **`commandPrefix` is a preamble line**, not a command wrapper: the tool builds
  `` `${commandPrefix}\n${command}` ``. It is for shell setup (`export PATH=…`), not for
  wrapping a command. The rewrite seam is **`prepare(execution, context, signal)`** —
  awaited, and free to mutate `{ command, cwd, env, inheritEnv }` before execution.
  [rtk](11-rtk-in-profile.md) should be built on `prepare`.
- **Overflow uses `createTempFile` + `appendFile`.** When output exceeds the line or
  byte cap, pi streams the full text to a temp file and appends
  `[… Full output: <path>]` to what the model sees. See the *Temp file* decision below.

**Error codes are fixed by contract** and Rust must map onto them:
`aborted | timeout | shell_unavailable | spawn_error | callback_error | unknown`.
Timeout is in **seconds**, has no default, and pi caps it at its own
`MAX_TIMEOUT_SECONDS`.

### Decisions

1. **Confine the cwd; do not pretend to confine the command.** Rust refuses a `cwd`
   outside the workspace root and sets the child's working directory inside it. It does
   **not** police what the command then does — `cd /` works, absolute paths work.
   Containment for `exec` is the [permission gate](03-permission-gate.md)'s job, not
   `exec`'s.

   **This is a deviation from `context.md`** — "Rust is the only filesystem/process
   authority; it stays root-confined" — and is recorded here rather than taken quietly,
   as that file requires. The reasoning: a shell can always reach the filesystem, and
   pi's own `docs/security.md:35` argues a partial in-process sandbox *"would be easy to
   misunderstand as a security boundary."* A boundary that is honest about its limits is
   worth more than one that reads as absolute and is not. **This deviation must be
   repeated in `docs/DEVLOG.md` when the slice lands**, not left only here.

2. **Detect the shell, prefer Git Bash, tell the model which it got.** pi's tool is named
   `bash` and described as *"Execute a bash command"*, so models emit POSIX syntax at it;
   Git Bash is the only option that does not fight the prompt. Fall back to PowerShell or
   `cmd` when absent. Two consequences to carry: `shell_unavailable` becomes a real
   runtime state rather than a theoretical code, and **agent behaviour varies by
   machine**, so the resolved shell must be stated in the system prompt rather than
   assumed.

3. **Streaming uses a Tauri v2 `Channel`, not events.** The repo is on `tauri = "2"`
   (`src-tauri/Cargo.toml:16`), and `Channel<T>` exists precisely for ordered
   high-rate producer streams; events are a broadcast bus and the wrong instrument.
   This also sidesteps the hazard in `docs/OPEN-ISSUES.md` — a hand-rolled
   `plugin:event|listen` payload wedges the IPC and every later `invoke` hangs.
   **v1 streams**: `onStdout`/`onStderr` feed pi's `onChunk`, which is what drives live
   output for a user watching a long build. pi already throttles the UI side
   (`BASH_UPDATE_THROTTLE_MS`), so Rust should not throttle again.

4. **Abort kills the process tree.** `abortSignal` must terminate a running child, and on
   Windows killing only the direct child leaks its descendants — pi's own Node
   environment shells out to `taskkill /F /T /PID`. `terminal.rs:173` currently calls a
   plain `child.kill()`, which is *not* sufficient here and should not be copied.
   Abort maps to the `aborted` code, distinct from `timeout`.

5. **Temp file for overflow lives in a confined scratch directory inside the workspace**,
   not the OS temp dir. The model is handed that path and will try to `read` it, so it
   has to be reachable under the same containment rules the `read` tool obeys —
   an OS temp path would be refused by the resolver from
   [ticket 01](01-execution-env-surface.md). Implies a gitignored scratch location and a
   cleanup policy; the file is written by `createTempFile` + `appendFile`, both of which
   are therefore **not** stubs.

6. **Cap the total capture in Rust as well.** pi truncates what the *model* sees, but the
   raw bytes still cross the IPC first. A command emitting hundreds of megabytes should
   be cut off at the source, with the cut reported rather than silently swallowed.

### Not settled here

Cancellation *semantics* above this layer — what `AgentRun.cancel()` promises when a tool
has already started — stays in the map's fog and belongs with
[the event contract](05-event-contract.md).
