# 56 — Archive and delete a session

**Blocked by:** [55](55-navigator-is-part-of-the-chat.md) — it rewrites the same rows.
**Status:** **landed**

## What to build

A session row offers **archive** and **delete**, right-aligned, revealed on hover.

Archive takes a conversation off the list and leaves it on disk. Delete removes it.

## What archive is

Moving the file into `.ade/sessions/archive/`. `listStored` reads a directory, so a file
that is not in it is not listed, and nothing about naming, resuming or the store's shape
has to change. It survives a restart because it is a fact about the filesystem rather than
about this window.

The alternative — a flag in the session's metadata — needs a repo write API that does not
exist and buys nothing over a `rename`.

**Archived sessions are not browsable in the app, and that is a deliberate shortcut.**
Mark it as one. Archive's job is to get a row off a list; a second list for reading back
the rows you removed is the scaffolding "less is more" rules out. The file is in a plainly
named folder and a file manager reaches it. **Add the Archived group when someone actually
goes looking for an archived conversation** — that is the signal, not the tidiness of
having a round trip.

## Delete is already recoverable

`delete_entry` uses `trash::delete`, so this is the recycle bin rather than `unlink`. The
confirmation still stands — an accidental click still makes a conversation vanish from the
list, and the person clicking does not know where it went — but it is a smaller cliff than
it looks, and the confirmation should not claim the loss is permanent.

## No new Rust

`create_folder`, `rename_entry`, `delete_entry` and `delete_plan` already exist, are
already root-confined, and are already what the explorer uses. This ticket is a renderer
change plus a call into commands that are built.

## Where the buttons do not appear

- **The live row** and any row with a running turn. Archiving the conversation you are
  having is a state nothing downstream expects, and deleting a running session's file is
  worse.
- **A row in another workspace.** `rename_entry` and `delete_entry` resolve against
  `root_of(&state)` — the *window's* root. They take no session id, and there would be
  nothing to pass: a stored row is a file, not a registered session. Offering them on a
  foreign row means a new index-addressed **write** door into a root the window is not in,
  and that door is the confinement boundary itself.

  **It costs one click.** Selecting a foreign row already switches the window into that
  root ([49](49-a-session-in-another-folder.md)), so the only unreachable thing is
  archiving a session in a folder you never visit. Nothing about running sessions in
  several roots at once is touched: a session's own confinement is fixed at birth
  ([ADR 0002](../../../adr/0002-a-root-per-session.md)) and the `agent_*` commands take a
  session id, so a background turn keeps writing in its own folder throughout.

## The row has to stop being a button

`.ide-navigator-row` **is** a `<button>`, and two more buttons cannot go inside it —
nested buttons are invalid HTML and the inner ones stop receiving clicks. The row becomes
a flex `<div>` holding three controls: open (`flex: 1`), archive, delete.

The two actions are hidden until the row is hovered **or contains focus**. `:focus-within`
is not a nicety here: hover-only would make them pointer-exclusive, and accessibility is
one of `CONTEXT.md`'s fixed exceptions.

## Acceptance criteria

- [x] Hovering a session row reveals archive and delete, right-aligned; leaving hides them.
- [x] Tabbing into a row reveals the same two controls and both are operable by keyboard.
- [x] Archive moves the file out of the listed directory, the row leaves the list, and it
      is still gone after a restart.
- [x] Delete asks first, and its wording does not claim the conversation is unrecoverable.
- [x] Neither control appears on the live row, on a row with a running turn, or on a row
      belonging to another workspace.
- [x] The row is no longer a `<button>` containing buttons, and opening a session by
      clicking anywhere on its label still works.
- [x] Driven in the **native** window against real stored sessions.

## One correction to the plan

**The archive folder is `.ade/archive`, not `.ade/sessions/archive`.** Sessions are stored
in a per-cwd bucket *under* the sessions root, and `JsonlSessionRepo.list` called without a
`cwd` enumerates every directory under that root and parses the `.jsonl` files in each. An
archive folder inside it would have handed every archived conversation back to the next
caller that asked that way. `listStored` passes a `cwd` today and would not have noticed —
which is what makes it worth moving rather than commenting on. One directory up costs
nothing and removes the trap.

`archiveMove` also keeps only the file name, so the bucket directory does not come along
and nothing can land outside the archive folder.

## Verified

Driven in the native window against this repo's real `.ade/sessions`:

- **Archive**: seven rows to six, *"Archived …"* announced, and the file present in
  `.ade/archive/` afterwards. Still absent after a full app restart, with the file still in
  the archive folder.
- **Delete**: the dialog reads *"… will be removed from the list. Its file goes to the
  trash."* Confirming took six rows to five and announced *"Deleted …. It is in the
  trash."*
- The focused live row carried no buttons; every stored row in the current folder carried
  both; every row under `colorle`, `second-root` and `workspace-b` carried none.
- The buttons compute `opacity: 0` at rest and `1` while one holds focus, so the keyboard
  reaches them without a pointer.
