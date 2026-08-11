# 0001 — Multi-root confinement

**Status:** accepted, and deliberately unimplemented.
**Date:** 2026-08-10.
**Context:** [ticket 39](../wayfinder/pi-harness/tickets/39-session-navigator.md), which
requires this be written *before* it is needed rather than during.

## Context

`src-tauri/src/workspace.rs` holds **one** canonical root in `WorkspaceState`, and every
path the renderer sends is confined to it by `resolve`, which canonicalises and then checks
`starts_with`. One root is the whole invariant. It is what makes every other rule in that
file — no symlinks, files only, size caps, the ignore list — enforceable rather than
advisory, because there is exactly one prefix to compare against.

The Session Navigator groups sessions by workspace and shows `workspace · branch` in its
headers. Drawn honestly, that implies more than one workspace is *reachable*. Slice 39
answers that with **switching**: one root at a time, changed on demand. The navigator's
additional workspace groups are fixtures and say so.

The question this ADR settles is the one the next slice will ask: what happens when two
workspaces are live at once.

## Decision

**One root at a time remains the confinement boundary. Multi-root is not adopted.**

Switching is safe and is built. `switch_workspace` takes an **index into a recent-roots
list that Rust owns**, never a path, so the renderer gains no authority it did not already
have — every entry on that list is a folder the user handed over through an OS dialog in
`choose_workspace`. `set_workspace`, which does take a path, stays refused outside debug
builds.

## Consequences if multi-root is later wanted

Recorded now, because they are the reason it is not being done incidentally:

- **`WorkspaceState` becomes a map, and `resolve` needs a root argument.** Every command
  that calls `root_of(&state)` — around fifteen of them, including every `agent_*` write —
  gains a parameter that says *which* root. A command that forgets it does not fail to
  compile today; it silently resolves against whichever root is "current". The type has to
  change so that omission is impossible, not merely discouraged.
- **The renderer starts naming roots.** Once more than one is live, a command must be told
  which to act in. That identifier has to be an opaque handle minted by Rust, not a path
  and not an index that renumbers when the recents list moves.
- **`git_checkpoint` is per-tree.** One checkpoint per turn assumes one working tree. Two
  roots means either two checkpoints per turn or a turn that cannot be rolled back
  atomically, and the second is not a checkpoint.
- **The gate's deny list and the exec cwd confinement are both written against "the" root.**
  Both become per-root, and a tool call that crosses roots has to be refused rather than
  resolved against the nearer one.

## Alternatives considered

- **Multi-root now, so the navigator's groups are real.** Rejected: it changes the shape of
  the app's only real security invariant to make a fixture honest. The visible prototype
  marking makes it honest for free.
- **Keep one root but let the renderer name it by path.** Rejected: that is exactly the
  hole `choose_workspace` was built to close, and `set_workspace` already refuses it in
  release builds for the same reason.
