# 49 — A session in another folder

**Blocked by:** [46](46-a-root-per-session.md), [48](48-sessions-run-in-the-background.md).
**Status:** ready-for-agent

Where the session table earns out: two conversations, two working folders, both live.

## What to build

A session can be created in a root that is not the one you are in, and focusing it brings
the workbench with it.

**Creating one is the navigator again.** Its workspace groups already list every recent
root, so *New session* under a group creates one there; *Choose folder…* is how a root that
is not yet on the list joins it, through the OS dialog that is still the only way a root
enters this app.

**The workbench follows focus.** Explorer, open editors, terminal and the language server
all belong to the focused session's root. Editors are kept per root rather than discarded,
so moving back and forth is cheap rather than destructive — which is the half of ticket 31
that a reload could never do. A file tree showing a folder the visible conversation cannot
touch is a trap, so it does not exist.

**The session you left keeps running in its own root**, with its own confinement, while
you work in another. That is the whole point, and it is only sound because
[ticket 46](46-a-root-per-session.md) fixed each session's root at birth.

**What happens to workspace switching.** Switching roots stops being a mode change that
reloads the window and becomes a consequence of focusing a session — the same thing session
switching already does today, generalised. The recents list stays exactly as it is: Rust's,
indexed, never named by path.

## Acceptance criteria

- [ ] A session can be created in another recent root, and in a folder chosen through the
      dialog.
- [ ] Focusing it switches explorer, editors, terminal and LSP to that root.
- [ ] Editors open in one root are still open when you focus back into it.
- [ ] A turn running in one root continues while you focus a session in another, and its
      file operations stay confined to its own root.
- [ ] An agent in one session cannot read or write another session's root.
- [ ] The navigator shows live sessions under each of their own workspace groups.
- [ ] Driven in the native window with two roots and overlapping turns.
