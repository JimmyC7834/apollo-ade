# 25 — One confirm dialog, not three

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent. **Prefactor**, not a feature: nothing a user can see changes.

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

- [ ] Both `ConfirmDiscard` and the revert confirm in `ChangesView` render through the
      primitive; neither builds its own `Overlay`.
- [ ] `ChangesView` no longer holds dialog mechanics beyond *which item* is pending.
- [ ] Escape cancels, focus lands on the non-destructive action, and focus returns to the
      trigger on close. Verified in the DOM, and recorded as structural in `OPEN-ISSUES.md`
      like every other accessibility claim in this repo — it has not been heard.
- [ ] No user-visible change. Both dialogs read and behave as they did.
- [ ] `npm run check` and `npx tsc --noEmit` clean.
