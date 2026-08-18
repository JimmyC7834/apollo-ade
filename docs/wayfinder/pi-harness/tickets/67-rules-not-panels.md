# 67 — Rules, not panels

**Blocked by:** [65](65-no-fill-at-rest.md).
**Status:** done

## What to build

What is left of the chrome once the fills are gone: square corners, one weight of rule per
job, and lists whose structure is drawn rather than spelled.

## Square, everywhere

The transcript has had a blanket `border-radius: 0` since slice 38, carved out for dialogs.
It becomes the app's rule rather than the transcript's, with the same carve-out and for the
same reason the original comment gives: a list of exceptions is a list of things waiting to
be forgotten.

## Two weights, and each means something

- **Hairline** (`--border`) — a division inside one thing: a turn from the next turn, a
  group header from its rows, a pane from its footer.
- **Strong** (`--border-strong`) — a boundary between two things: chat and the dock, an
  input's box, a tab strip's underline.

Anything that is neither gets no rule. Space is a separator too, and it is the cheaper one.

## Tree guides are borders, not characters

The obvious implementation is `│` and `├─`, and it does not work: a box-drawing character
is glyph-height and a row is line-height, so every row boundary shows a gap and the tree
reads as dashes. Drawn as 1px borders on the nested lists they are continuous by
construction and land on the same grid — with the parent's line masked below its last
child, so a branch ends instead of running on.

## The sash needs to be grabbable

The dock's edge is 1px of rule inside **9px of grab**, pulled back by its own negative
margin so the extra width costs no layout. A 1px drag target is a rule you can see and
cannot use.

## Not in scope

No region moves, no panel is added or removed, the dock keeps its sides and its collapse
behaviour, and the titlebar keeps everything it has. The status line drawn in the mockup is
**not** part of this ticket — see the slice note.

## Acceptance criteria

- [x] No rounded corner outside a dialog and outside [66](66-hover-lifts-focus-outlines.md)'s
      hover surface.
- [x] Every rule in the app is hairline or strong, and which one it is follows the rule
      above.
- [x] Tree guides are continuous through every row boundary, at every depth, and a branch's
      last child ends it.
- [x] The dock edge can be grabbed and dragged without pixel-hunting, and the layout does
      not shift when it is.
- [x] `npm run check` passes.
- [ ] Driven in the **native** window — *not done: driven in the dev WebView,
      both themes, by screenshot and by reading computed styles*, both themes.
