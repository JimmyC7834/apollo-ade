# 53 — Launch reopens the sessions you had

**Blocked by:** [49](49-a-session-in-another-folder.md).
**Status:** landed

## What to build

Closing the app and opening it again puts back the set of sessions that were open, focused
where you left it, each in its own root.

**Nothing resumes.** A turn interrupted by quitting stays interrupted. Restarting model
work unattended at launch spends money on something nobody is watching, and a session that
was mid-turn simply comes back with that turn recorded as it was written — which
[the history replay](../../../../src/agent/history.ts) already handles, closing an
unanswered tool call rather than leaving a spinner running for a run that ended yesterday.

**`sessionRequest.ts` finishes its second job here.** It was written to carry one session
choice across a reload; when [ticket 47](47-two-sessions-in-one-window.md) retired the
reload it stopped being how switching works. This is what it becomes: the record of which
sessions were open and which was focused, read once at start-up.

Restoring a root that has since been deleted or unmounted drops that session with a message
and keeps the rest. Same rule as everywhere else here — a convenience must not be able to
break the window.

## Acceptance criteria

- [x] The set of open sessions comes back after a restart, with focus where it was.
- [x] Each restored session is in its own root, with its transcript.
- [x] No turn starts on its own at launch.
- [x] A session whose root is gone is dropped with a message; the others still open.
- [x] A session whose file is damaged or unreadable is dropped the same way, reusing the
      existing candidate-and-fallback rule rather than a second one.
- [x] First launch, with nothing recorded, opens one session exactly as it does today.
- [x] Driven in the native window across a real restart.
