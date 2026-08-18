# 66 — Hover lifts, focus outlines

**Blocked by:** [65](65-no-fill-at-rest.md).
**Status:** ready-for-agent

## What to build

The modern half of the brief. Everything is text until you point at it, and then it lifts.

## The rule that makes it coherent

**Elevation belongs to a surface, not to a row.**

- A row on the flat page — the dock's file list, the explorer tree, the problems list —
  lifts 1px onto a rounded card with a small shadow.
- A row on something that already floats — the session navigator, a menu, the command
  centre — does **not** lift. It brightens, and takes a `>` in its gutter.
- A row in a popup menu takes an inverted selection bar drawn from `--accent` /
  `--on-accent`, so a theme change moves it and nothing is hard-coded blue.

Two elevations for one decision reads as a bug, which is why this is a rule and not a list
of cases.

## Three details that are not obvious

**The radius exists only under the lift.** Nothing is rounded at rest, because nothing at
rest is a box — [65](65-no-fill-at-rest.md) saw to that. So `border-radius` never appears
except on the thing that floats, and the transcript's blanket `border-radius: 0` stays true
as written.

**Buttons lift but take no marker.** A `>` in front of `Save` reads as a bullet, not as a
cursor. The marker is for rows, which are places you are going.

**Focus takes the lift *and* an outline.** The lift alone, with no pointer to explain it,
reads as a glitch; the outline is what says the keyboard put it there. The marker gutter is
fixed-width and empty at rest, so nothing shifts sideways when it fills.

## Not in scope

No control gains or loses an interaction. Nothing becomes keyboard-only and nothing becomes
pointer-only; every row that can be tabbed to today still can, and shows it more clearly
than it does now.

## Acceptance criteria

- [ ] Rows on the flat page lift on hover; rows on a floating surface do not.
- [ ] Popup menu rows take an inverted bar built from theme tokens, and changing `--accent`
      changes it.
- [ ] Buttons lift and take no marker.
- [ ] Tabbing shows the lift plus an accent outline, and the label does not move when the
      marker appears.
- [ ] Motion respects `prefers-reduced-motion`.
- [ ] `npm run check` passes.
- [ ] Driven in the **native** window, with the keyboard as well as the pointer.
