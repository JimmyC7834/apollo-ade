# 52 — Undo says whose work it will also revert

**Blocked by:** [48](48-sessions-run-in-the-background.md).
**Status:** landed

The other half of making concurrent turns honest, and the one no warning to an agent can
cover — because the person pressing Undo is the user.

## What to build

Undoing a turn in a root where another session has been working says what else goes back,
before it does it.

**The problem is not the button, it is the snapshot.** `git_checkpoint` captures the whole
working tree before a turn. With two sessions in one root, the checkpoint taken for session
A already contains part of session B's work — so restoring it reverts B's changes too, and
puts the tree into a state neither conversation was ever in.

Three options were weighed. Disabling undo in a contended root removes a feature that
works. Leaving it silent is the only genuinely bad one, and it is what happens if nothing
is built. **Offering it with the consequence stated** is the choice: it matches the
instinct behind ticket 51 — surface the collision, leave the decision with whoever has the
context.

So an undo whose checkpoint spans another session's turns confirms first, naming the other
session and what it did in that span. The note written into the transcript afterwards says
the same thing, because the transcript is the record and *"undone"* alone would not be
true.

Undo in an uncontended root is untouched, including its wording.

**A per-session git worktree would make this problem not exist**, and is the direction the
other harnesses took. It is a much larger change — checkouts, disk, and what "the
workspace" means — and belongs in its own ticket rather than being smuggled in here.

## Acceptance criteria

- [x] Undo in a root where no other session ran behaves exactly as it does today.
- [x] Undo whose checkpoint span overlaps another session's turns confirms first, naming
      that session.
- [x] Declining the confirmation changes nothing.
- [x] The note appended to the session records that another session's work was reverted.
- [x] A session whose work was reverted by someone else's undo is not silently left
      claiming those edits in its transcript.
- [x] Driven in the native window with two sessions editing one tree.
