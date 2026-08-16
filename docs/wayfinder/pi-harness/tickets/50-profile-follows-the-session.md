# 50 — Profile and model follow the session

**Blocked by:** [49](49-a-session-in-another-folder.md).
**Status:** landed

## What to build

Each session carries the profile it was born with, and the composer edits the focused
session's.

**The whole profile, not just the model.** Splitting them was considered and declined: a
background session running under one profile's tool set with another profile's model is the
same class of bug as a workspace switch corrupting a session — state that belongs to a run
being mutated by something outside it.

Today profiles, skills and user tools are module-level stores with one active profile per
window, and `onProfileChange` retunes the single harness. That becomes per-instance: the
composer's profile control shows and changes the focused session's, and a background
session's harness is never retuned by anything the user does elsewhere.

**Gated after [49](49-a-session-in-another-folder.md) on purpose.** Project profiles are
read from the root, so a session in another folder has a different set available to it.
Building per-session profiles before per-session roots means building them twice.

Global profiles stay global; a project profile belongs to the session's root and overrides
the global one there, exactly as it does now.

## Acceptance criteria

- [x] Each session has its own active profile, chosen when it is created.
- [x] The composer shows and edits the focused session's profile; changing it retunes only
      that session's harness.
- [x] A session in another root offers that root's project profiles.
- [x] A background session mid-turn is unaffected by a profile change made in another
      session.
- [x] Approval mode is per session too, since it is part of the profile.
- [x] `npm run check` and `npx tsc --noEmit` clean.
