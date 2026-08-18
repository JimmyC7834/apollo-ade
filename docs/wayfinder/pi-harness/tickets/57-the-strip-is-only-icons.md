# 57 — The strip is only icons

**Blocked by:** [55](55-navigator-is-part-of-the-chat.md), [56](56-archive-and-delete-a-session.md).
**Status:** **landed**

## What to build

Four corrections to the collapsed navigator, three of them consequences of 55 and 56 that
only showed up in use.

**The strip shows a pixel of every label.** The Shell Guide's 32px collapsed width included
a 1px right border and a 31px icon column, so the column matched the inner width exactly.
[55](55-navigator-is-part-of-the-chat.md) removed the border and left 32px of width around a
31px column. Collapsed width and icon column become one number — 28px, a little narrower
than before — so the strip is the icons and nothing else.

**The strip has a scrollbar.** A scrollbar is 15px of a 28px column: more than half the
width, offered for a gesture aimed at labels nobody can read yet. Scrolling belongs to the
expanded state, and arrives with the labels.

**A collapsed workspace loses its status dot.** This is 55's one real defect. The header is
a flex row holding the label button and a right-aligned `+`, and on a 28px strip that button
takes the whole width — so the icon beside it is clipped out of existence, and every
workspace showing a `+` went blank the moment the pointer left. Action buttons are not
rendered at all while the navigator is collapsed. The same rule covers archive and delete,
which had the same latent problem.

**Two controls for one action.** A group offered a **New session** row *and* a `+` standing
in for the row while the group was collapsed. One is enough, and the `+` is the one to keep:
the row was a session-shaped thing sitting in a list of sessions while not being one. It
behaves like archive and delete — right-aligned on the header, revealed on hover or focus.

## Acceptance criteria

- [x] No label text is visible while the navigator is collapsed.
- [x] The collapsed strip has no scrollbar; the expanded navigator still scrolls.
- [x] Every workspace keeps its status dot while the navigator is collapsed, including the
      ones offering a `+`.
- [x] There is exactly one way to start a session in a workspace: the `+` on its header,
      revealed on hover or focus, and reachable by keyboard.
- [x] The `+` still starts a session in the workspace it belongs to, expanded or collapsed.
- [x] Driven in the **native** window.

## Verified

Driven in the native window over CDP.

Collapsed, after a reload: the navigator measures 28px with `overflow-y: hidden` and
reserves no scrollbar; all six workspace headers show a 16px status dot inside a 28px icon
column; every action button computes `display: none`; and no label's box begins inside the
strip.

Expanded: 264px with `overflow-y: auto`. Every group carries a `+` flush to the right edge,
`opacity: 0` at rest and `1` while it holds focus — so the keyboard reaches it. Clicking the
one on `workspace-b` took that group from two rows to three and the window followed it,
breadcrumb `workspace-b`. No standalone **New session** row remains anywhere in the list.

**Not measured:** the expanded scrollbar actually appearing. The list fits at this window
size, so `overflow-y: auto` was confirmed as the computed value rather than by seeing a
scrollbar.
