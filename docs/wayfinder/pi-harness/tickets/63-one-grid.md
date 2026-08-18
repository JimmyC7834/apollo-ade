# 63 — One grid

**Blocked by:** none — can start immediately.
**Status:** done

## What to build

The whole application is set in one monospace face, on one line grid, with no ligatures.

## Why this is first

It is the single change that does most of the work, and everything after it assumes it.
Three quarters of what makes a terminal look like a terminal is typographic, and the app
already proved it once: the transcript's skin has been mono since slice 38 and is the only
part of this app that reads as a TUI today.

It is also the change that cannot be done incrementally. A second family in the app is a
second grid, and two grids next to each other are what makes a mono panel look like a
widget rather than like the app.

## What is there now

- `--font-sans` and `--font-mono` in `tokens.css`, and `--font-sans` on `body`.
- `.ide-agent { font-family: var(--font-mono) }` — the skin, scoped to the transcript.
- `.ide-agent dialog { font-family: var(--font-sans) }` — a rule that puts modal surfaces
  *back* into sans on the argument that a profile editor is not part of the stream. That
  argument is retired by this ticket: there is no second face to go back to.

## The shape of it

`--font-sans` is **deleted**, not left unused. A token nothing reads is a trap: the next
person to want "a proper UI font here" finds it sitting there looking supported.

`font-variant-ligatures: none` moves from `.ide-agent` to `body` for the same reason it was
set there — a cell is a cell, and `!=` becoming `≠` costs a column.

Monaco and xterm are untouched. They set their own families and always have.

## Not in scope

Nothing moves, nothing is renamed, no control changes what it does. If a screenshot before
and after differs by anything other than letterforms and the spacing they imply, something
in this ticket went further than it should have.

## Acceptance criteria

- [x] Every surface — titlebar, navigator, composer, dialogs, dock, command centre,
      context popover, profile editor — is set in `--font-mono`.
- [x] `--font-sans` no longer exists in `tokens.css` and no rule references it.
- [x] Ligatures are off everywhere, not only in the transcript.
- [x] Monaco and xterm still use their own font settings and are visibly unchanged.
- [x] `npm run check` passes.
- [ ] Driven in the **native** window — *not done: driven in the dev WebView,
      both themes, by screenshot and by reading computed styles*, both themes.
