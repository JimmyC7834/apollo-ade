# 0002 — A root per session

**Status:** accepted, and implemented.
**Supersedes:** [0001 — Multi-root confinement](0001-multi-root-confinement.md).
**Date:** 2026-08-15.
**Context:** [ticket 46](../wayfinder/pi-harness/tickets/46-a-root-per-session.md), which is
the prefactor the concurrent-session sequence rests on.

## Context

0001 settled that one root at a time is the confinement boundary, and it was right for the
app it was written against: one harness, one gate, one conversation. It also wrote down —
in its own consequences section, before anything needed it — exactly what would have to
change if that ever stopped being true. This is that change, and the list held up.

What made it stop being true is [ticket 48](../wayfinder/pi-harness/tickets/48-sessions-run-in-the-background.md):
a turn keeps running while you look at another conversation. The moment two turns can be in
flight, "which root am I confined to" has to have two answers *at the same instant*, and
`WorkspaceState` can only ever hold one.

There is a sharper reason than concurrency, and it is a bug that already happened.
Confinement was **ambient**: a command resolved against whatever `WorkspaceState` held at
the moment it ran. A workspace switch mutated that under whatever was in flight, so a
`Session` opened under one root went on appending under the next. Its parent chain split
across two files and every later turn died on a parent id that existed only in the other
root. That is the corruption fixed on 2026-08-15, and the fix at the time was to *reload the
window* on every switch — which worked, and which is precisely the mechanism ticket 47
retires.

## Decision

**A session's root is fixed when the session is created, and every agent command carries the
session it belongs to.**

Rust keeps a session table. `create_agent_session` resolves a root the two ways a root has
always been resolvable — the current one, or an index into the recents list — mints an
**opaque id**, and remembers the pair. `close_agent_session` forgets it. The agent's
filesystem and exec commands take that id and resolve against that session's root, whatever
the window is showing.

Three properties are load-bearing:

- **The id is minted by Rust and means nothing to the renderer.** It is a counter, and
  *opaque* here means "carries no information", not "unguessable" — guessing one could only
  ever name a root the renderer itself registered, so it grants no authority that asking
  would not. No path crosses this boundary, which is the property `choose_workspace` exists
  to hold and 0001 refused to give up.
- **An unknown or stale id is refused, never resolved against the current root.** A fallback
  would put one session's writes into another session's folder, silently, and only when a
  focus change happened to be in flight — the exact class of bug this replaces.
- **This is strictly stricter than what it replaces.** A root is fixed at birth rather than
  mutable underneath in-flight work. Nothing that was confined before is less confined now.

**The workbench keeps a current root**, and it now means "the focused session's root". The
explorer, search, LSP and terminal go on using it untouched; only agent commands take an id.
Making every command in `workspace.rs` session-keyed is a far larger diff for nothing the
workbench can spend.

**How it moves is the third door into `adopt`**, added by
[ticket 49](../wayfinder/pi-harness/tickets/49-a-session-in-another-folder.md):
`focus_agent_session` takes a session id and nothing else, so it can only ever reach a root
already in the table — one this app was given through a dialog or the recents list. It is
the narrowest of the three, and it deliberately does **not** record the root as a choice:
`remember` reorders the recent list, and the renderer names a root by its index into that
list, so a focus change halfway through reopening a set of sessions moved the folder every
remaining index pointed at. Focusing is not choosing.

The read-only recents-index parameter added by session switching stays as it is. It answers
a different question — *list* another root without entering it — and it is not a session.

## Consequences

0001's four consequences, answered:

- **`WorkspaceState` becomes a map.** It did not, and that is the interesting part.
  `WorkspaceState` stays as the *workbench's* root; a second piece of state, `SessionRoots`,
  holds the agent's. Splitting them by who is asking turned out to be smaller than keying
  one map by everyone.
- **A command that forgets which root it means.** Handled by `agent_root(state, roots,
  session)`: `None` is the workbench and only the workbench. It is not the type-level
  impossibility 0001 asked for — an agent command could still pass `None` — so it is held by
  a single call site per command and by tests that assert the `None` branch follows the
  focused root and the `Some` branch never does.
- **The renderer names roots by an opaque Rust-minted handle.** Done, as above.
- **`git_checkpoint` is per-tree.** Half answered, half still true, and the split is worth
  being exact about. The command itself is no longer ambient: it takes the session id and
  snapshots *that session's* root, so a background turn cannot checkpoint whichever folder
  the window happens to be showing — which is what tickets 49 and 51/52 needed and what
  review found missing after 45–48. What remains true is that a checkpoint is of the whole
  working tree, so two sessions in one root still produce checkpoints neither conversation
  was alone in. A per-root turn queue was considered and **declined** in favour of saying so
  out loud: [ticket 51](../wayfinder/pi-harness/tickets/51-concurrent-write-warning.md)
  warns the agent and
  [ticket 52](../wayfinder/pi-harness/tickets/52-undo-under-contention.md) makes undo name
  whose work it also reverts. Both have landed; a per-session git worktree would make the
  problem not exist and is still not a decision that has been made.
- **The gate's deny list and exec cwd confinement.** `agent_exec` takes the session id and
  confines the cwd to that session's root. The deny list is unchanged and remains what it
  always was: a foot-gun guard, explicitly not a security boundary.

## Alternatives considered

- **Keep one ambient root and serialise sessions onto it.** Rejected: it makes a background
  turn wait on a foreground one for no reason a user could see, and it does not fix the
  corruption — it only narrows the window in which a switch can land mid-turn.
- **A root per *window*, with a second window for a second folder.** Rejected: it is the
  reload under a different name, and the whole of ticket 47 is that moving between
  conversations should cost nothing.
- **Pass the root path with each command instead of an id.** Rejected for 0001's reason,
  unchanged: that is the hole `choose_workspace` was built to close.
