# 28 — Undo a turn

**Blocked by:** none — can start immediately.
**Status:** **landed.** See [What was built, and why](#what-was-built-and-why).

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

- [x] A turn can be undone from the transcript, and it is obvious which turn.
- [x] After an undo the working tree matches the checkpoint taken before that turn.
- [x] The transcript cannot end in a state where the model believes an edit survives that
      does not. Whichever option is chosen, this is the criterion it must meet.
- [x] Undo is refused, with a reason, while a turn is running.
- [x] Uncommitted work the user did by hand between turns is not silently destroyed —
      state what happens to it, and confirm before discarding.
- [x] The choice and its reason are recorded in this ticket.

## What was built, and why

**pi offers both options.** `Session.moveTo(entryId)` really does rewind the
conversation — the ticket was right to insist on checking — and
`appendCustomMessageEntry(type, content, display)` puts a message into the
model's context without pretending a person said it.

**Chosen: rewind the tree, and tell the model.** `moveTo` throws away the
reasoning that produced the edits, which is usually the part worth keeping and
rephrasing, and it addresses pi entry ids where our `Turn` ids are our own — so
taking it means building a mapping in order to lose something. The note is the
whole answer to the desync: after an undo the last thing in the model's context
says the edits are gone and that files must be re-read. `undoNote` is one
function used by both the session write and the transcript, so the two cannot
come to say different things.

**What the restore actually does.** `git restore --source=<checkpoint>
--worktree -- .`, after taking a fresh checkpoint of the current tree. So:

- Modified and deleted tracked files come back.
- Tracked files the checkpoint did not have are removed — recoverable, because
  the backup stash captures the index.
- **Untracked files are never touched.** `git stash create` does not capture
  them, so deleting one would be the single thing here that no checkpoint could
  undo. The note says so, and the confirmation says so before it runs.
- The index is left alone. `checkout <sha> -- .` would have worked too and would
  have silently staged everything it restored, changing what the next commit
  contains.

`--worktree` restoring a deletion and removing a since-added file was verified
in a throwaway repository before the command was written, not assumed.

**Refusal while a turn runs** is two guards on purpose: `canUndo` hides the
button, and `createRunner.undo` counts live turns and throws. The first is the
affordance; the second is what makes the first not a security claim about the
UI. `undo` also goes through the same queue every harness operation uses, so it
can never land inside a turn.

**Deliberately not done:** removing the change event from the transcript, which
is what the Shell Guide's Undo says it does. The session is append-only and the
transcript is what the user reads back — a turn that vanished would be a
transcript that disagrees with the context it produced.

### The gap the spec review found

The restore and the session note are two operations and cannot be made one — by
the time the note is attempted the tree is already back. The first cut threw on
a failed note, which left the files gone, the model's context untouched, and the
transcript recording *neither*: exactly the state this ticket's third criterion
forbids, reached by the error path rather than the happy one.

Fixed by carrying the failure out instead of throwing it. `UndoOutcome.told` is
set by the provider, and a `false` makes `undoNote` say plainly that the agent's
context still describes the edits and that the user must say so in their next
message. The transcript therefore records the undo in both cases, the button
does not come back, and the one thing that cannot be recovered — a silent
divergence — is not reachable. Asserted in `undo.check.ts`.
