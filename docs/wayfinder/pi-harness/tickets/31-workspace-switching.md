# 31 — More than one workspace

**Blocked by:** none — can start immediately.
**Status:** **landed**, across three slices rather than one. See
[What was decided, and where](#what-was-decided-and-where).

It was **absorbed into [ticket 39](39-session-navigator.md)** because the Session Navigator
groups sessions by workspace and shows `workspace · branch` in its headers, so the navigator
could not be drawn honestly without switching working underneath it. 39 built the recents
list and the switch; [49](49-a-session-in-another-folder.md) turned switching into a
consequence of focusing a session and answered the editors; the terminal was the last of
the five and is answered here.

## A correction this ticket is built on

The dev was cautioned against this on the grounds that `workspace.rs` treats one root as
the confinement boundary and multi-root reopens that decision.

**That caution was about multi-root. He asked for switching.** One root is still the
boundary; it is merely a different root than it was a minute ago. Nothing about
containment is reopened, and `set_workspace` already exists and already does the Rust half.
The objection did not apply to what was asked for.

## What to build

A recent-workspaces list and a way to switch between them without restarting.

## What actually has to be decided

Switching is cheap in Rust and expensive in the workbench, because five things are holding
state that belongs to the old root:

- **Open editors.** Paths from the old root. Close them, or restore that root's set when
  you come back?
- **The terminal.** Its PTY has a cwd inside the old root. A live shell does not follow a
  workspace switch on its own.
- **A running agent turn.** The agent's `ExecutionEnv` is bound to the old root and its
  session is on disk under it. Switching mid-turn is the case that will break.
  **Refusing to switch while a turn is running is a legitimate answer** and is cheaper
  than making it correct.
- **Layout and view state.** `persistence.ts` stores one workspace's worth. Per-root or
  global?
- **Profiles, skills and user tools.** Project-scoped ones are read from the root, so a
  switch has to re-read them — which is `/reload` by another name.

The last one is the one most likely to be missed and the one that fails quietly.

## Acceptance criteria

- [x] Recent roots are persisted and offered; switching does not require a restart.
- [x] The agent, terminal, explorer, search and changes views all operate on the new root
      after a switch, with no stale handle to the old one.
- [x] Project-scoped profiles, skills and user tools are re-read on switch.
- [x] Switching during a running turn is either handled or refused with a reason — never
      left to race.
- [x] Unsaved editor changes are not lost without asking.
- [x] What happens to open editors is decided, recorded here, and consistent.

## What was decided, and where

The five things holding the old root's state, each with its answer:

**Open editors — kept per root, not closed.** A map from root path to that root's inputs and
active editor; leaving stashes, arriving restores. Landed with
[49](49-a-session-in-another-folder.md). This is also what removed the *"cannot switch with
unsaved changes"* refusal: switching was blocked because unsaved work was about to be thrown
away, and now it is put down and picked up again. Nothing is lost, so nothing needs asking.

**The terminal — the shell stays in the folder it was opened in.** A PTY's working directory
is set when it is spawned and never moves, so a shell cannot follow the window. It is not
killed either: it is still running for whoever left it there, and killing shells on a switch
would make a background turn's neighbour disappear under it. So a shell is tagged with the
root current when it was opened, shown only there, and hidden — not unmounted — everywhere
else. Unmounting is what kills the process, which is why every instance stays rendered and
only the tab strip is filtered. `terminalsIn` and `activeIn` in `terminal.ts` are the whole
rule, and `terminal.check.ts` holds the two ways of getting it wrong: a filter that forgets
the root, and a remembered tab id that survives a switch it should not have.

Two things the review sharpened. First, per-root shells were worth nothing until the terminal
also survived a change of *dock tab*: `ArtifactView`'s subtree is swapped whole when the
active artifact changes, so glancing at the file tree unmounted every instance and killed
every shell in every root. The terminal is now mounted for as long as it is **pinned**, and
hidden the rest of the time; unpinning still kills, and that is the one place it should.
Second, a shell opened before any folder is chosen belongs to no root and cannot be reached
once one is — its process keeps running with no tab. Left as it is: it costs a per-root
adoption rule to fix a path that needs the window to have no folder at all.

**A running turn — handled, not refused.** The case the ticket expected to break stopped
existing: a session's confinement is fixed at birth ([ADR 0002](../../../adr/0002-a-root-per-session.md)),
so a turn running in the folder you just left is simply unaffected. What moves on a switch is
only what the user is looking at.

**Layout and view state — global, except what is genuinely per root.** `persistence.ts` keeps
one set of pane sizes, dock fraction and theme, because those are preferences about the window
rather than facts about a folder. Editors and terminals are the two exceptions, and both are
per root for the same reason: they hold paths and processes that only mean something there.

**Profiles, skills and user tools — re-read on arrival, and scoped.** `loadProfileFiles(root)`
runs as part of entering, which is the *"`/reload` by another name"* this ticket predicted
would be missed. The half it did **not** predict is that re-reading is not enough: every
runner rebuilt its tool set from whatever load fired last, so glancing at a folder handed its
`ade.profiles.json` tool definitions to a session confined somewhere else. `loadedRoot()` plus
each runner's `mine()` test is the fix, and it landed with
[50](50-profile-follows-the-session.md).

## Verified

Driven in the native window over CDP, two roots, real shells:

- A shell opened in `second-root` prompts there; switching to the repo shows *"No terminals
  open."* and leaves that instance mounted and hidden rather than dead.
- A shell opened in the repo prompts in the repo; switching back shows `Shell 1` again with
  its scrollback, and `pwd` in each still answers its own folder after two switches — both
  processes outlived the round trip.
- Closing the only shell in one root leaves that root empty rather than adopting the other
  root's shell as its selected tab.
- Looking at Problems and coming back leaves the shell where it was, sized and live. **This
  is the one the first pass got wrong**: the same sequence on the build before the fix
  returned an empty panel and a dead process, and the driving that missed it never moved off
  the Terminal tab. Written down because unit checks cannot see it — the killing happens in
  a `useEffect` cleanup that only runs in a real tree.
