# 55 — The navigator reads as part of the chat

**Blocked by:** none — can start immediately.
**Status:** **landed**

## What to build

The Session Navigator stops looking like a second panel bolted to the side of the chat, and
the transcript gets its column back.

Four changes, all in the one component and its stylesheet:

**The workspace header stops switching roots.** It is the collapse toggle for every group,
uniformly. Today it is a toggle for the group you are in and a *switch* for every other
one, and that split needs a paragraph of comment to explain why a header cannot be both.
It can now be one thing, because switching already happens by picking a session
([ticket 49](49-a-session-in-another-folder.md)) — the header was a second way to do
something that already works.

**A collapsed group grows a `+`.** Collapsing a group hides its rows, and **New session**
is one of them, so a collapsed workspace currently offers no way to start anything in it.
A `+` on the right of the header, shown only while that group is collapsed, does exactly
what the hidden row would have done. This is what keeps a workspace with no conversations
reachable at all, now that its header no longer takes you there.

`Choose folder…` stays. It is the only way a root this app has never seen gets in.

**No border, no shadow, and the chat's own background.** The navigator keeps its geometry
and keeps being an overlay — it never reflows chat, expanded or not. What goes is the 1px
right border, the drop shadow, and `--sidebar`; `--background` replaces it, in **both**
states rather than only when expanded. Collapsed, that makes a 32px strip of status
markers on the chat surface rather than a gutter; expanded, it reads as the chat surface
widening rather than a panel appearing over it.

Opaque rather than transparent is deliberate and is the accessibility exception: expanded
labels sit above transcript text, and with no surface at all they are unreadable.

**The transcript gets a width again.** `.ide-agent-log` has no `max-width`, so the
transcript spans the whole region while the composer under it caps at `--composer-width`
(760px) — one column and one full-bleed wall of text, in the same view. The log's inner
content takes the same 760px cap, centred, with the scrollbar left at the region edge.

It is centred on the chat column, not on the space beside the *expanded* navigator. The
navigator is an overlay and must not move the column: a cap that reacted to expansion would
shift the transcript 116px every time the pointer crossed it.

The collapsed strip needs no allowance of its own —
`.ide-region-main > .ide-agent { margin-left: 32px }` has reserved that gutter since the
first look at the shell, so the column never reaches under the markers at any width.

## Acceptance criteria

- [x] Clicking a workspace header collapses and expands that group, in every group, and
      never switches root.
- [x] A collapsed group offers a `+` that starts a session in that workspace; an expanded
      one still offers the **New session** row.
- [x] `Choose folder…` still opens the OS dialog.
- [x] The navigator has no right border and no shadow in either state, and its background
      is the chat's in both.
- [x] Expanding the navigator does not reflow chat and does not move the transcript column.
- [x] The transcript is capped and centred on the region, with its scrollbar at the region
      edge and the composer aligned to it.
- [x] Driven in the **native** window.

## What the window said that the CSS did not

**The composer's cap was not in force, and the reason it had been lifted is the reason to
put it back.** A later block in `App.css` — the transcript's TUI skin — sets
`max-width: none` on the composer, arguing that *a centred box under a full-width
transcript* would give the skin away. That premise was true, and this ticket ends it: with
the transcript capped, the same rule now produces a full-width input under a centred
conversation, which is the mismatch it was written to prevent. The override is gone.

**The cap is the composer's content box, not its border box.** `--composer-width` caps the
composer's outer edge and its own padding insets the input from there, so capping the
transcript at the same number left it 20px wider on each side than the input beneath it —
measurably not one column. Both now run 69 → 797 in a standard window.

## Verified

Driven in the native window over CDP:

- `.ide-navigator` computes `border-right: 0px`, `box-shadow: none`, and a background equal
  to the page's, in both states.
- A header toggles its own group, and no header switches root. Collapsing reveals the `+`;
  expanding hides it and restores the **New session** row.
- The `+` on a collapsed group started a conversation in that workspace and the window
  followed it — the breadcrumb became `colorle/main`. On a recent root that no longer
  exists it reports *"The session could not be started."*, which is what the **New
  session** row it replaces already did.
- Transcript and composer share one column to the pixel, with the log's scrollbar left at
  the region edge.
