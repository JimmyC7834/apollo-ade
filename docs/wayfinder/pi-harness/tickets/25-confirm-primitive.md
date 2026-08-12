# 25 — One confirm dialog, not three

**Blocked by:** none — can start immediately.
**Status:** **landed.** See [What was built](#what-was-built). **Prefactor**, not a
feature: nothing a user can see changed.

## Why this is first

This repo's own rule is *"extract a UI primitive only after two real consumers show the
same behaviour."* Two exist. `ConfirmDiscard.tsx` is a save/discard/cancel dialog, and
`ChangesView.tsx:169` hand-builds a destructive-confirm over `Overlay` with its own
`confirmRevertId` state. Ticket 29 makes a third — deleting a file — and writing a third
hand-rolled overlay is how a repo ends up with three dialogs that focus differently, trap
Escape differently, and announce differently to a screen reader.

The rule is satisfied *now*, and the third consumer is what makes acting on it worth doing
rather than tidy.

## What to build

A confirm primitive in `src/ui` that both existing consumers use and ticket 29 can reach
for. It owns the overlay, the focus trap, initial focus on the safest action, Escape, and
the destructive-action styling. It does not own *what* is being confirmed.

`ConfirmDiscard`'s three-way shape — save, discard, cancel — is the awkward one, and it is
the reason to design against it rather than against the easy two-button case. Either the
primitive takes a list of actions with one marked safe and one marked destructive, or
`ConfirmDiscard` stays as-is and only the two-button case is extracted. **Pick by writing
both call sites, not by arguing.**

## Acceptance criteria

- [x] Both `ConfirmDiscard` and the revert confirm in `ChangesView` render through the
      primitive; neither builds its own `Overlay`.
- [x] `ChangesView` no longer holds dialog mechanics beyond *which item* is pending.
- [x] Escape cancels, focus lands on the non-destructive action, and focus returns to the
      trigger on close. Verified in the DOM, and recorded as structural in `OPEN-ISSUES.md`
      like every other accessibility claim in this repo — it has not been heard.
- [x] No user-visible change. Both dialogs read and behave as they did.
- [x] `npm run check` and `npx tsc --noEmit` clean.

## What was built

**A list of actions, not a two-button dialog.** Decided by writing both call
sites as the ticket said: `ConfirmDiscard` offers save *and* discard, so a
primitive with one `onConfirm` would have left the awkward consumer outside —
and the awkward consumer is the one that proves the shape.

**Cancel is rendered first, and that is the entire focus rule.** `Overlay`
focuses the first control it finds, so ordering the safe action first is what
puts initial focus on it. No `autoFocus`, no ref, nothing that can fall out of
sync with the layout.

Actions do not close the dialog. The caller owns `open` — a primitive that
closed itself would be a second source of truth for state the caller has to hold
anyway, and both call sites already hold "which item is pending".

Ticket 28's undo confirmation is the third consumer, written the same day, which
is what the "extract after two, act on it when a third arrives" rule was waiting
for.
