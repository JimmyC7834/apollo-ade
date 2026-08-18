# 62 — An index is resolved when it is spent

**Blocked by:** [61](61-one-store-keyed-by-root.md).
**Status:** **landed**

## What to build

Clicking a conversation, or a workspace's `+`, always acts on the folder the row *names* —
never on whichever folder happens to sit at that position in Rust's list by then.

## What was happening

A root crosses to Rust as an **index into the recent list**, never as a path — that is
[ADR 0002](../../../adr/0002-a-root-per-session.md) and it is right. But the navigator
captured that index when the row was **drawn** and spent it when the row was **clicked**, and
`remember` reorders the list in between: choosing a folder puts it at the front and shifts
everything behind it down one.

So between the folder dialog closing and the renderer re-reading `recent_workspaces`, every
row on screen carried an index naming a different folder than the one it was drawn for.
Clicking one opened a conversation in the wrong workspace.

**The codebase had already learned this once.** `bootstrap` takes a `Locate` callback and
resolves each root immediately before it is used, and its comment says why: *"Resolving every
index up front and spending them one at a time is what put a restored conversation in the
wrong folder."* The lesson never reached the two click paths.

## The fix

Rows and groups carry the root they mean, as a **path**. `locate` — one callback, now shared
with `bootstrap` rather than inlined into it — turns that path into an index against the list
**as it stands at the moment of the click**. A root the list no longer names is refused with
a message rather than resolved to something else.

The path still goes no further than the renderer. What crosses to Rust is an index, exactly
as before; what changed is only *when* it is worked out.

`undefined` keeps meaning *here* for the `+` on the current workspace, and must: a root the
window is in that the recent list does not name would otherwise be refused a session in the
folder it is standing in.

## Acceptance criteria

- [x] Clicking a session in another root opens it in that root, even if the recent list was
      reordered after the row was drawn.
- [x] The `+` on a workspace starts a session in that workspace under the same conditions.
- [x] A root that has left the recent list is refused with a message, not silently resolved.
- [x] `bootstrap` and the click paths share one `locate` rather than two spellings of it.
- [x] Driven in the **native** window, against a list reordered behind the UI.

## Verified

Rust's recent list was reordered *behind* the renderer, using the debug-only `set_workspace`,
so the two disagreed exactly as they do after a folder dialog. `second-root` moved from index
2 to index 3, which meant every `second-root` row on screen carried an index that now named
`tauri-ade-prototype`.

The navigator was confirmed to still be holding the stale order at that moment. Pressing
`second-root`'s `+` then took that group from two rows to three and moved the breadcrumb to
`second-root/master` — the folder the row named, not the one its index pointed at. On the
build before this, that press would have started a conversation in `tauri-ade-prototype`.
