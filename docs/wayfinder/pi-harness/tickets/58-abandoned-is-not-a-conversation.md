# 58 — An abandoned session is not a conversation

**Blocked by:** [57](57-the-strip-is-only-icons.md).
**Status:** **landed**

## What to build

Two things the navigator gets wrong once you use it for an afternoon.

**A session with nothing in it is listed, and cannot be removed.** A session file is written
the moment one is opened, so every `+` you click and then think better of leaves an
`Untitled session` behind. They accumulate faster than anyone would remove them — and while
one is the conversation you are *in*, it is live, so [56](56-archive-and-delete-a-session.md)
correctly offers no way to remove it. The row you most want gone is the one row that has no
button.

The answer is not a third button. A session nobody said anything in is not a conversation,
so it is not listed. Closing one is how you remove it, which is a gesture that already
exists, and after this it is the only one needed.

**The list rearranges when you switch.** The navigator drew the current workspace first and
every other root under it, so arriving somewhere hoisted its group to the top and pushed the
rest down. A list you navigate by position must not reorder itself when you arrive: the
recent list moves when a folder is *chosen*, which is what `remember` in `workspace.rs` has
always meant, and the navigator is now the same. The current workspace keeps whatever place
Rust gives it.

## What this deliberately does not do

**It does not delete the files.** A session's write path is pi's and its file is small, so
not-listing is the whole of what "not saved" needs to mean here. Deleting an empty session's
file when it closes is the change if the leftovers ever matter — and it is not free, because
a session in another root would need a write door the window does not have.

The leftovers do have one cost, and it is handled rather than ignored: the list is capped at
twenty *rows*, and rows are dropped after they are named, so abandoned sessions would
otherwise push real conversations off the end. The cap stays on rows and a separate ceiling
bounds how many files may be read to fill it.

## Acceptance criteria

- [x] A session with no user message in it is not listed, in the current workspace or any
      other.
- [ ] Closing an empty session removes it from the navigator and it does not come back.
      **Half done, and the half that is not is the gesture** — see Verified.
- [x] A workspace with more abandoned sessions than the cap still lists its real
      conversations, and reading the list stays bounded.
- [x] Switching workspaces does not change the order of the groups.
- [x] A root the window is in that the recent list does not name still appears.
- [x] Driven in the **native** window.

## Verified

**The order.** Rust's recent list, read off `recent-workspaces`, is
`colorle, tauri-ade-prototype, second-root, workspace-b, ws-b, ws-a`, and the navigator drew
exactly that with the current root — `tauri-ade-prototype` — sitting *second* rather than
hoisted. Opening a conversation in `second-root`, the third entry, left all six groups in
the same order. Before this it would have moved to the top and pushed two groups down.

**The filter**, tested with a real empty session file rather than a fixture: the 124-byte
JSONL that ticket 56's archive had moved out was copied back into the sessions bucket under
a newer name, so it sorted first. After a reload it appeared nowhere — zero `Untitled
session` rows in the whole navigator — and the workspace still listed its four real
conversations. The probe file was then removed.

The empty-session rows that were in this repo's navigator before the change are gone with it.

**Not driven through the UI:** closing an empty session. `Close session` lives on the ADE
menu and the palette, and neither opens under a synthetic click, so the close *gesture* was
not exercised. What was tested is what closing leads to — an empty file on disk, not
listed — which is the half this ticket changed.
