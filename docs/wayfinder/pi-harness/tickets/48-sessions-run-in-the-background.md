# 48 — A session keeps running while you look at another

**Blocked by:** [47](47-two-sessions-in-one-window.md).
**Status:** **landed, and driven with two real overlapping turns.** Both sessions showed
`running` at once, the unfocused one finished `done, unread` with a notification naming it,
and focusing it cleared the flag with its whole answer intact. Closing a running session
confirms through the app's own `Confirm` and stops the turn.

The point of the whole sequence: leave it working, go do something else, come back.

## What to build

A turn started in one session keeps running after you focus another, and the navigator
says so the whole time.

**The statuses already exist.** `running`, `waiting`, `idle`, `done` and the separate
unread flag were built for this in ticket 39 and have had nothing to describe until now.
A background session drives them for real: running while its turn is in flight, done and
*unread* when it finishes off-screen.

**A background session may block on the gate, and it waits.** An approval or a question
from a session you are not looking at marks it `waiting`, sends a notification, and holds
the run until you go there and answer. It does **not** steal focus and it does **not** get
auto-answered — stealing focus makes a background session worse than no background session,
and answering for the user is not something a gate may do.

**Turns really are concurrent, including in the same folder.** The alternative — a
per-root queue — was considered and declined: the coordination answer is a warning to the
agent ([ticket 51](51-concurrent-write-warning.md)) and an honest undo
([ticket 52](52-undo-under-contention.md)), not a lock. Which means this slice is the one
that makes two agents able to edit one tree at once, and those two tickets are what stop
that being silent.

**Closing a running session confirms first**, and confirming stops the turn.

Cost stays per session. There is no window-wide total, because a total across conversations
is a number nobody acts on.

## Acceptance criteria

- [ ] A turn started in session A continues after focusing session B, and its output is
      all there when you return.
- [ ] The navigator shows A running throughout, then done-and-unread; focusing it clears
      unread.
- [ ] An approval or question raised by an unfocused session marks it `waiting` and holds;
      no focus is stolen and nothing is answered automatically.
- [ ] A notification fires when a background session finishes or starts waiting.
- [ ] Two sessions can be mid-turn simultaneously.
- [ ] Closing a session with a turn in flight asks first, and stops the turn on confirm.
- [ ] Driven in the native window with two real turns overlapping.
