# 31 — More than one workspace

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent. Called a **must-have** by the dev.

## A correction this ticket is built on

The dev was cautioned against this on the grounds that `workspace.rs` treats one root as
the confinement boundary and multi-root reopens that decision.

**That caution was about multi-root. He asked for switching.** One root is still the
boundary; it is merely a different root than it was a minute ago. Nothing about
containment is reopened, and `set_workspace` already exists and already does the Rust half.
The objection did not apply to what was asked for.

## What to build

A recent-workspaces list and a way to switch between them without restarting.

## What actually has to be decided

Switching is cheap in Rust and expensive in the workbench, because five things are holding
state that belongs to the old root:

- **Open editors.** Paths from the old root. Close them, or restore that root's set when
  you come back?
- **The terminal.** Its PTY has a cwd inside the old root. A live shell does not follow a
  workspace switch on its own.
- **A running agent turn.** The agent's `ExecutionEnv` is bound to the old root and its
  session is on disk under it. Switching mid-turn is the case that will break.
  **Refusing to switch while a turn is running is a legitimate answer** and is cheaper
  than making it correct.
- **Layout and view state.** `persistence.ts` stores one workspace's worth. Per-root or
  global?
- **Profiles, skills and user tools.** Project-scoped ones are read from the root, so a
  switch has to re-read them — which is `/reload` by another name.

The last one is the one most likely to be missed and the one that fails quietly.

## Acceptance criteria

- [ ] Recent roots are persisted and offered; switching does not require a restart.
- [ ] The agent, terminal, explorer, search and changes views all operate on the new root
      after a switch, with no stale handle to the old one.
- [ ] Project-scoped profiles, skills and user tools are re-read on switch.
- [ ] Switching during a running turn is either handled or refused with a reason — never
      left to race.
- [ ] Unsaved editor changes are not lost without asking.
- [ ] What happens to open editors is decided, recorded here, and consistent.
