# 61 — One store, keyed by root

**Blocked by:** [60](60-one-harness-per-file.md).
**Status:** **landed**

## What to build

Switching workspaces never draws one root's conversations under another root's name.

## What was happening

The navigator read from **two** stores, and only one of them knew which root it belonged to:

- `elsewhere` — a map from root path to that root's stored conversations.
- `stored` — a bare list, meaning *"the current root's"*.

A bare list carries no root, so it was drawn against whichever root was current **when it
rendered**, not the one it was **read from**. Switching moves the current root immediately
and the new list arrives a file read later. For that gap the workspace you had just arrived
in was drawn holding the conversations of the one you left — and since the list you left is
capped at twenty while a foreign one is capped at five, arriving somewhere quiet from
somewhere busy made its group balloon and then collapse.

The same gap ran the other way: the root you left became a *foreign* group, drawn from an
`elsewhere` entry that the effect had been skipping precisely because it used to be current.

## The fix

One store, keyed by root, holding every root's conversations including the current one. Both
effects write into it under the root they read from — the current-root read files its answer
under **the focused session's own root**, not under `selection`, because those two disagree
for exactly the length of a switch.

A root with no entry has no rows. That is what "not read yet" honestly looks like, and it is
a state a map can express and a bare list cannot: the bare list's empty value and its stale
value are the same thing.

## Acceptance criteria

- [x] Switching workspaces never shows a group holding another root's conversations, at any
      point.
- [x] The root being left keeps its own conversations throughout.
- [x] A root whose list has not been read yet shows its live sessions and nothing else.
- [x] Driven in the **native** window.

## Verified

A `MutationObserver` recorded the navigator's full shape — every group, every row name — at
every DOM change for nine seconds through a click on a stored conversation in another root.
The breadcrumb confirms the root really moved (`workspace-b / …`), and across the whole
switch there was **exactly one shape**. No group ever gained, lost or borrowed a row.

## One thing this review found and did not fix

**A row's `switchIndex` is an index into the recent list as it was when the row was drawn.**
Rust's list is reordered by `remember`, which only `choose_workspace` calls — so the window
is narrow, but it is real: between the folder dialog returning and the renderer re-reading
`recent_workspaces`, every row on screen carries an index that now names a *different* root.
Clicking one in that gap would open a conversation in the wrong folder.

It is the same class of defect as the one this ticket fixes — a value used against a list it
was not read from — and it is not fixed here because the fix is a different shape: resolve
the index at click time from a freshly read list, which is what `Locate` already does for
reopening at launch. Recorded rather than done, and not observed in the window.
