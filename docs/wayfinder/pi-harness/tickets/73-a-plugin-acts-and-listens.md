# 73 — A plugin acts, and listens without lifting a block

**Blocked by:** [72](72-a-plugin-loads-and-adds-a-command.md).
**Status:** ready-for-agent

## What to build

Two of the six messages, merged into one slice because neither is a demo on its own and
both are the plugin reaching the running ADE:

- **`invoke(command, args)`** — the plugin's claimed command actually does something.
- **`on(event, handler)`** — the plugin sees the 22 harness events, and can **add** a block
  to a tool call but can never **lift** one.

Plus the failure behaviour that both need: a per-call deadline, and a plugin that breaches
it being disabled for the session with one line in Problems.

## Why

A plugin that can only add a menu entry is a menu. `invoke` is what makes it a plugin, and
it is one entry that exposes every Rust command we have — which is how the supported list
stays at six messages instead of growing one per capability.

`on` is the half that needs care, and it is why these two are merged rather than shipped
separately: reviewing them together is reviewing the trust model once.

## What is there now

- `pi-agent-core` ships the hook system in the browser-safe core —
  `AgentHarnessEventResultMap` at `harness/types.d.ts:550`, 22 events, eight returning a
  value that changes behaviour, including `tool_call -> { block?, reason? }`.
- **Core's `emitHook` keeps only the last handler's result.** So a plugin that installs a
  `tool_call` handler and returns an object **silently replaces the gate's
  `{ block: true }`**. Nothing fails; the gate is simply gone.
- `systemPrompt.ts` already runs `before_agent_start` through our own chaining runner, for
  exactly this reason. The shape exists; this ticket generalises it.
- `browser_eval` in `src-tauri/src/browser.rs` already carries a 15-second deadline, and
  the reasoning there — a caller inside a model's turn cannot wait forever — applies here.

## The shape of it

**`invoke` is a pass-through with a deadline.** The plugin names a Rust command and its
arguments; the ADE calls it and returns the result. Root-confinement, the gate and every
other rule apply because the plugin is just another caller — nothing about `invoke` is a
privileged path.

**Hooks run through a chaining runner with deny precedence.** Every plugin handler for an
event runs; results combine rather than overwrite; **the gate runs last and
unconditionally**. A plugin may return a block. A plugin returning no block cannot turn a
block into an allow. This is the single most important paragraph in the plugin system, and
it exists because the obvious simplification — handing plugin handlers straight to
`harness.on` — deletes the permission gate with no test failing.

Write the check that fails if someone does that simplification.

**Events are ours-shaped, not pi's passed through raw.** `api` covers our surface; a pi
upgrade can change an event's payload underneath a plugin, and a thin mapping is what keeps
that our problem instead of the plugin author's. Keep the mapping boring.

**Failure.** A call that misses its deadline, or a handler that throws, disables the plugin
for the session and writes one line to Problems naming it. Never silent, never retried,
never fatal to the ADE.

**The caveat that is not solved here, on purpose.** A plugin's handler runs on our main
thread. A *synchronous* loop freezes the window and no timer interrupts it. The deadline is
best effort against slow async work, not a guarantee. The ADR records this as the trigger
for moving to a sandbox, and this ticket must not pretend otherwise.

## Not in scope

Tools, panels, relay, themes, layout — tickets 74 to 76. No sandbox. No new Rust commands
invented for plugins to call; `invoke` exposes what already exists.

## Acceptance criteria

- [ ] A plugin's claimed command calls `invoke` and something observable happens.
- [x] A plugin handler on `tool_call` that returns a block **blocks** a call the gate would
      have allowed.
- [x] A plugin handler that returns nothing, or returns an allow, **cannot** run a call the
      gate blocked — driven, not reasoned about.
- [x] Two plugins with handlers on the same event both run, and a block from either wins.
- [x] There is a check that fails if plugin handlers are ever registered straight on the
      harness instead of through the chaining runner.
- [x] Hook payloads handed to plugins are our own shapes, not pi's types re-exported.
- [x] A call that exceeds the deadline, and a handler that throws, each disable that plugin
      for the session — driven in `hooks.check.ts`, and the run continues either way. The
      **Problems line** itself is wired but has not been watched; it goes with the native
      box below.
- [x] The synchronous-loop gap is recorded in the dev log as a caveat, not omitted.
- [x] `npm run check` and `cargo test` pass.
- [ ] Driven in the **native** window, against a real model for the `tool_call` path.
