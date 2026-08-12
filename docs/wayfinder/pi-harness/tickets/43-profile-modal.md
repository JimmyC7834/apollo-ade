# 43 — The profile modal, its subpages, and a third gate policy

**Blocked by:** [37](37-shell-tokens-and-stack.md).
**Status:** **landed in `1bbd413`, with `6dfbb89` folding the three gate-policy
declarations into one; record not yet written.** The criteria below are untouched because
nobody has checked them against the code — they say nothing about whether the work is
done. Do not read an unticked box here as work remaining.

## What a Profile is here

Already built: name, model, reasoning effort, maximum context, tools enabled/disabled,
skills enabled/disabled, approval behaviour. [Ticket 04](04-profile-data-model.md) settled
the data model and [ticket 03](03-permission-gate.md) the gate. This slice is the surface,
not the model — with one real change to the model, below.

The [Shell Guide](../../UIUX-UPDATE.md) says *"Profiles created in this prototype persist
only for the current session."* That is the prototype's limitation, not this app's:
profiles persist here and continue to.

## The menu

Each Profile row has a right-aligned edit icon, **absolutely overlaid, visible only while
that row is hovered, and its appearance must not change the row's width.** Fifth appearance
of the non-shifting rule.

Radix's pointer-down selection has to be intercepted so clicking Edit does not activate the
Profile first. Editing opens the same configuration modal populated with existing values —
one modal, two entry points, not two modals.

## Tools and Skills are pages, not checkboxes

Both are navigation rows on the main Profile page showing the number currently enabled.
Clicking opens an in-modal subpage with a Back button, a search field with a clear button, a
count, and Enable all / Disable all.

Rows use **no native checkbox**. Enabled rows show a right-aligned Codicon checkmark;
disabled rows show no trailing indicator; clicking anywhere on the row toggles it.

That styling choice has an accessibility consequence worth naming before it is discovered:
a row with no checkbox and no trailing indicator communicates its state to sighted users
only. The rows need proper checkbox semantics underneath — `role`, checked state,
Space to toggle — with the Codicon as the visual. Radix has the primitive; use it rather
than putting a click handler on a `div`.

## Approval: Ask, Auto, Bypass

`gate.ts:19` has `GatePolicy = 'auto' | 'careful'` today. The Shell Guide names three, and
the dev chose three. So: **`careful` → Ask**, **`auto` → Auto**, and **Bypass is new**.

What each one means, stated precisely because a third policy is only safe if its edges are
written down:

- **Ask** — prompts before mutating tool calls.
- **Auto** — the default and the one the dev actually runs. Never prompts, but still
  refuses on the deny list: `gate.ts:197` allows only when there is no `reason`, and that
  check fires in auto mode too.
- **Bypass** — skips the gate entirely, including the deny list.

**What Bypass does not bypass, and cannot:** Rust's root confinement. `workspace.rs` refuses
writes outside the canonical root, and no JavaScript-side policy reaches it. The per-turn
`git_checkpoint` also stands — it is not part of the gate. So Bypass removes the deny list,
which `context.md` records as *a foot-gun guard and explicitly not a security boundary*.

The objection to Bypass was raised during grilling and overruled by the dev. It is recorded
here so the next reader knows the mode was chosen rather than accumulated.

## Acceptance criteria

- [ ] The profile menu lists profiles; the edit icon is overlaid, hover-only, and does not
      change row width.
- [ ] Clicking Edit opens the modal without first activating the profile.
- [ ] Create and Edit use the same modal, populated.
- [ ] Tools and Skills are subpages with Back, search + clear, a count, and
      Enable all / Disable all.
- [ ] Selection rows toggle on click anywhere, show a Codicon checkmark when enabled and
      nothing when disabled, and carry real checkbox semantics with Space toggling.
- [ ] `GatePolicy` is `'ask' | 'auto' | 'bypass'`; `gate.check.ts` covers all three,
      including that Bypass skips the deny list and that a write outside the root is still
      refused under it.
- [ ] Profiles still persist across restarts.
- [ ] `npm run check` and `npx tsc --noEmit` clean.
