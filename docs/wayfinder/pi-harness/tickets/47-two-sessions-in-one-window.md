# 47 — Two sessions in one window

**Blocked by:** [45](45-session-as-an-object.md).
**Status:** ready-for-agent

The first slice anyone can see, and the one that retires the reload.

## What to build

You can have more than one conversation open at once and move between them instantly.

**Born from the Session Navigator.** The navigator already groups sessions under
workspaces, so creating one is a *New session* affordance inside the group it belongs to —
picking where it goes and making it are one gesture. The ADE menu item, currently disabled
with *"one session in this build"*, and a palette command both mean "new session in the
focused root". A new session is an empty chat.

**Switching is focus, not a reload.** Picking a session changes which instance the composer
and transcript are pointed at. Nothing restarts, nothing is re-read from disk, and the
session you left keeps every turn it had.

`sessionRequest.ts` does not disappear — it stops being how switching works and becomes how
a *launch* chooses what to open, which is [ticket 53](53-launch-reopens-sessions.md). The
guards that refuse a switch while a turn is running go away with the reload, because there
is no longer anything to lose by switching.

**Closing is "stop watching this", not "delete".** A closed session leaves the collection
and stays in the navigator as a stored conversation, because its file is on disk and
reopening is now cheap. Closing one that is mid-turn is [ticket 48](48-sessions-run-in-the-background.md)'s
problem; here nothing can be running in an unfocused session yet.

**No cap.** Decided in the open: each session is a harness and a transcript in memory, and
a refusal is worse than the honest cost until anyone has actually hit it.

## Acceptance criteria

- [ ] A new session can be created from the navigator, from the ADE menu, and from the
      palette; all three produce an empty chat.
- [ ] Two or more sessions appear in the navigator; exactly one is focused.
- [ ] Switching focus does not reload the window, does not re-read the session from disk,
      and preserves each transcript exactly.
- [ ] The composer, transcript, cost line and context meter all follow focus.
- [ ] Closing a session removes it from the collection and leaves it listed as stored.
- [ ] Turns taken in one session are written only to that session's file.
- [ ] `npm run check` and `npx tsc --noEmit` clean, and the whole flow is driven in the
      native window.
