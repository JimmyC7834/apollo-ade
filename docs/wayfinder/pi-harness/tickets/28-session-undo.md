# 28 — Undo a turn

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent.

## Half of this already runs, every turn

`git_checkpoint` is called once per turn and **nothing in the UI has ever exposed it**.
The tree can already be put back. What has never been decided is what happens to the
*conversation* when it is.

## The decision this ticket exists to make

pi's session is append-only JSONL. So a tree rewind that leaves the transcript intact
desynchronises the two: the model's context says it edited a file that no longer shows the
edit, and the next turn reasons from a history that is no longer true. That is worse than
either honest option.

- *Rewind the tree only.* "Undo the changes, keep the conversation." Simple, and the
  desync above is real — the model must be told, in the transcript, that its edits were
  reverted. A visible note is what keeps this honest, and it is the same argument
  `cropNote` makes.
- *Rewind both.* Truncating a session is a different operation from `git reset` and pi may
  not support it on an append-only store; a new session seeded from the kept prefix may be
  the only way. Cleaner state, more machinery, and it throws away work the person may have
  wanted to keep.

**Check what pi actually offers before choosing.** This repo has twice been wrong about
what pi already does — [ticket 15](15-core-already-does-this.md) is entirely about that,
and the rtk amendments are two more. Read `dist` for session truncation and branching
before assuming it must be built. pi's session *branching* is a real feature and is not
this, but it may be the mechanism.

## What to build

A way to undo a turn from the transcript: the tree returns to its checkpoint, and the
conversation ends in a state the model can reason from truthfully.

## Acceptance criteria

- [ ] A turn can be undone from the transcript, and it is obvious which turn.
- [ ] After an undo the working tree matches the checkpoint taken before that turn.
- [ ] The transcript cannot end in a state where the model believes an edit survives that
      does not. Whichever option is chosen, this is the criterion it must meet.
- [ ] Undo is refused, with a reason, while a turn is running.
- [ ] Uncommitted work the user did by hand between turns is not silently destroyed —
      state what happens to it, and confirm before discarding.
- [ ] The choice and its reason are recorded in this ticket.
