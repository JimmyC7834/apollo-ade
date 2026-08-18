# 65 — No fill at rest

**Blocked by:** [63](63-one-grid.md).
**Status:** ready-for-agent

## What to build

Nothing in the app has a background painted behind it when it is just sitting there. State
that used to be said with a surface is said with text colour and a marker instead.

## What a fill is, and why they go

A fill is a background colour behind a thing so it reads as an *object* rather than as
text: the pill behind a tool chip, the card behind a prompt, the bar behind a selected
row, the ground behind the dock, the tone behind an active tab, the block behind a button.

A terminal cannot paint a box behind a word, so it says the same things with brightness and
a glyph — and it turns out that is not a limitation, it is the reason a TUI reads as one
surface instead of as a tray of components. The transcript already did this to its chips in
slice 38 ("the chip, de-pilled") and nothing was lost.

**The tokens do not change.** `--card`, `--muted`, `--accent` and the rest stay in
`tokens.css` and stay the same values; they stop being painted as `background` and start
being read as `color`. This is not a palette ticket.

## Where a fill survives, and why

Three places, all of them the same reason: the thing genuinely floats over content, so
without a ground the text underneath shows through it.

- Popups and menus — context menu, the model and profile pickers, the context popover.
- The command centre.
- Dialogs.

Plus one that is not a fill at rest at all: the surface that appears **under a hover**,
which is [66](66-hover-lifts-focus-outlines.md)'s business.

## The dock is the interesting one

It loses its `--sidebar` ground and its border and keeps **one strong rule** on the edge it
meets chat at. It is not a panel beside the app; it is a column of it. This is the same
move [55](55-navigator-is-part-of-the-chat.md) made for the navigator, applied to the other
side of the window.

## Not in scope

No control changes what it does, nothing moves, nothing is removed. A selected row is still
selected — it says so by being brighter than its neighbours instead of by sitting on a
colour. Status colours keep their meanings and their tokens.

## Acceptance criteria

- [ ] No element has a `background` at rest outside a popup, the command centre or a
      dialog.
- [ ] Selection, active tab and current session read without a fill, in **both** themes —
      light is the hard one, and it is the one to check first.
- [ ] The dock has no ground and no border, and one strong rule on its chat edge.
- [ ] Every status distinction still survives being read out loud: colour is never the only
      carrier.
- [ ] `npm run check` passes.
- [ ] Driven in the **native** window, both themes.
