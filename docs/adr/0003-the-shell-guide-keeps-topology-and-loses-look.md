# 0003 — The Shell Guide keeps topology and loses look

**Status:** accepted, not yet implemented.
**Date:** 2026-08-18.
**Context:** [Slice 42](../wayfinder/pi-harness/map.md), tickets
[63](../wayfinder/pi-harness/tickets/63-one-grid.md)–[67](../wayfinder/pi-harness/tickets/67-rules-not-panels.md).
**Amends:** `CONTEXT.md`, "The guide is the spec".

## Context

`CONTEXT.md` makes the **Shell Guide** (`docs/UIUX-UPDATE.md`) authoritative for
*everything the user sees*: workbench topology, chrome, the transcript, the composer,
profiles as a surface, the palette, themes, tokens, iconography, and the component stack
they are written in. That rule has held since slice 37 and has been worth having — it is
what let slices 37–41 stop arguing about the shell and build it.

The dev has now asked for the whole application to look and feel like an advanced TUI, with
modern controls. Settled over four rounds of grilling: one monospace grid, characters
instead of icons, no fill behind anything at rest, rules instead of panels, and a hover
that lifts.

That contradicts the Shell Guide on four of the things it is authoritative for —
iconography, surfaces, radii, tone — and agrees with it on the rest. So the rule as written
is now false, and a rule everybody knows is partly false is worse than no rule: the next
reader cannot tell which half still binds.

## Decision

**The Shell Guide remains authoritative for what the workbench *is*, and stops being
authoritative for what it *looks like*.**

Still binding — the **model**:

- The regional topology: one Chat Workbench as the primary surface, a dock of artifacts, no
  permanent panels, the editor as a transient surface over chat.
- What a session, an artifact, a profile and the composer *are*, and which of them can be
  pinned, docked, modal or dismissed.
- Which controls exist, where they live, and what they do.
- The accessibility contracts.

No longer binding — the **surface**:

- Iconography. The Guide's rule is one icon library at 12–16px; the app's icons become
  characters on the text grid.
- Fills, elevation and radii. The Guide describes surfaces, cards and chips; the app has
  none at rest.
- Typography. The Guide's stack has a UI face and a mono face; the app has one face.
- Tone: what reads as emphasis, selection, or state.

**The palette is explicitly *not* in this split.** `tokens.css` keeps every value it has.
What changes is only that colours stop being painted as backgrounds and start being read as
text colour — see [65](../wayfinder/pi-harness/tickets/65-no-fill-at-rest.md). The Guide's
palette work survives intact, and Monaco's and xterm's derived themes are untouched.

**The `docs/tui-restyle-*.html` files are the reference for the surface**, in the same way
the Shell Guide is the reference for the model. They record decisions, not intentions: a
choice that was made by looking at three alternatives is cheaper to re-read there than to
re-derive. Two of the three are catalogues; the third, `tui-restyle-mockup.html`, is a
review artifact and is **not** a specification — it deliberately shows changes that were
not asked for and are not in any ticket.

## Consequences

**`CONTEXT.md` says the split**, so that "the Shell Guide is authoritative for everything
the user sees" stops being quotable as written.

**A disagreement now has a direction.** Where the Guide and the restyle differ, the restyle
wins on surface and the Guide wins on model. Where it is genuinely unclear which of the two
a question is — and there will be some, because "which control exists" and "what a control
looks like" are not always separable — the tie-break is the same as it has always been:
**less is more** outranks both, and the dev decides.

**The Guide's own caveat still applies and now applies twice.** `CONTEXT.md` already warns
that parts of the Shell Guide describe a mock with no engine, and that implementing those
literally is a misreading. The mockup carries exactly the same hazard, and for the same
reason: it was drawn to be looked at.

**This ADR does not authorise a redesign.** Slice 42 is a restyle: no region moves, no
control is added or removed, nothing changes what it does. If a ticket in this slice needs
the Guide's model to change, it is the wrong ticket and needs a decision from the dev
first.

## Alternatives considered

- **Supersede the Shell Guide entirely.** Rejected. Its topology is what slices 37–41 were
  built on, it is not in question, and nothing else describes it. Retiring it would leave
  the app's regional model written down nowhere.
- **Leave `CONTEXT.md` alone and treat the restyle as a deviation to record in the dev
  log.** That is the documented escape hatch for a one-off, and this is not one: it is five
  tickets that touch every surface in the app. A permanent contradiction described as a
  deviation is how a spec stops being read.
- **Rewrite `docs/UIUX-UPDATE.md` to match the restyle.** Rejected for now. It is a
  document that was drawn elsewhere and migrated here; editing it in place loses the record
  of what was migrated from what. If the restyle lands and holds, replacing it becomes a
  reasonable follow-up — this ADR is what would justify it.
