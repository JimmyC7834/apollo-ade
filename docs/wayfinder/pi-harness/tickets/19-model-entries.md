---
label: wayfinder:grilling
title: What the app knows about a model
parent: ../map.md
blocked-by: []
assignee: jc4649
status: open
---

# What the app knows about a model

## Question

An obligation the map stated and never assigned. From the Notes:

> **⚠ pi's bundled model catalogs go stale, and pinning does not help.** […]
> `gemini-2.5-flash` — which pi 0.83.0 ships in `GOOGLE_MODELS` — returns
> `404: no longer available to new users` for a newly issued key […] **Whatever
> ships needs a live model list or an honest failure when a catalogued model is
> gone.**

[Ticket 15](15-core-already-does-this.md) decided the shape — *machinery in,
entries ours* — and [ticket 16](16-compaction.md) built the one entry that had a
deadline, `CONTEXT_WINDOWS` in `src/agent/compaction.ts`. Nothing else moved,
and there is no ticket that would ever cause it to. This is that ticket.

**Do not treat this as one problem.** It is three, they have different urgencies,
and lumping them is why it has sat: only two of them are actually wrong today.

### Existence — probably already fine, and worth confirming rather than fixing

`allModels()` registers every provider with `models: []`, because
`requireProvider` resolves by `model.provider` and never checks the list
(`pi-ai/dist/models.js:275`). So the catalog is not consulted for enumeration at
all — the model travels with the request. Naming a dead model therefore fails as
the provider's own HTTP error, surfaced through the turn as an `error` event.

That may already be the "honest failure" the warning asked for. It is a
different failure from what the warning feared, which was pi's *advertised* list
being wrong — and we advertise nothing. Settle whether that is the answer, and
if so say so on the map rather than leaving the obligation open. The residue is
that the error arrives one turn late and reads as a provider problem rather than
"that model does not exist", which may or may not be worth improving.

### Capability — wrong today, and silently

`modelFor` in `provider.ts` sets `reasoning: /reason|think/i.test(choice.id)`.
The comment already calls it knowingly poor: right for `deepseek-reasoner` by
accident of naming, wrong for the next reasoning model not named after one.

The consequence is not cosmetic. `clampThinkingLevel` reads it, so a profile
asking for `thinkingLevel: "high"` against a mislabelled model gets clamped to
`off` and the user sees a model that simply does not think — with no error,
because nothing failed. The adapter reads `reasoning_content` off the stream
regardless, so a mislabelled model still *shows* reasoning when it produces
any; what the flag actually controls is whether reasoning is echoed back on
later turns.

So: where does `reasoning` come from? A hand-written table beside
`CONTEXT_WINDOWS`, a probe, or something pi exposes.

### Cost — absent, and honestly so

`cost` is zeroed in `modelFor`, with a comment saying a wrong cost table
produces confident wrong numbers and that is worse than none. Nothing in the UI
displays cost today — the meter shows tokens — so this is currently a decision
that costs nothing.

It stops being free the moment anyone wants a spend figure, and ticket 15
already took `calculateCost` from pi. Decide whether cost entries are in scope
here or whether this stays deliberately empty until something asks for it.

## Settle

- **Whether the three questions share one answer.** A single hand-written table
  holding `contextWindow`, `reasoning` and `cost` per model id is the obvious
  shape, and `CONTEXT_WINDOWS` is already half of it. The argument against is
  that a table is exactly what goes stale, which is the failure this ticket
  exists because of.
- **Where entries come from, given the same problem recurs.** Hand-written is
  what ticket 15 decided and what shipped; the honest cost of that is a table
  someone has to remember to edit when a model lands. `fetchModels` exists on
  pi's provider factories and is passed for none of ours — that is the live-list
  route, and it is a network call at startup.
- **What an unknown model does.** `contextWindowFor` already answers *unknown*
  rather than guessing, which is what keeps auto-compaction from firing against
  a fabricated denominator. Whatever is added should be able to say the same,
  and `reasoning` currently cannot — a boolean has no unknown.
- **Whether this needs a model picker to matter.** There is none: the model
  comes from a profile file or an env var, both hand-typed. A picker would need
  a list, which is the live-list question again, and
  [ticket 04](04-profile-data-model.md) deliberately left profile editing out.
  Say whether the picker is in scope or a separate thing.

## Not in scope

Which providers are bundled — settled by [ticket 08](08-bundle-cost.md), all
three, statically. This is about what the app knows about a model it has already
decided it can talk to.
