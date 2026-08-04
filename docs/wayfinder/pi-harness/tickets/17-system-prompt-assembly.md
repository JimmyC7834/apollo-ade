---
label: wayfinder:grilling
title: What the system prompt is made of
parent: ../map.md
blocked-by: []
assignee: jc4649
status: open
---

# What the system prompt is made of

**Deferred deliberately.** The one part of this that is not a decision — passing a
callback instead of a string — is being fixed first, as its own slice, because it
forecloses everything else here and costs a line. The questions below wait until
profiles are close enough that answering them is cheaper than guessing.

## Question

The last unsettled dependency before [profiles](04-profile-data-model.md) can be built.
Four of the map's fog entries are blocked behind profiles; profiles carry an
`instructions` field; and nobody has said what that field *does* to the prompt that
already exists.

## Fact 1 — we are already on the wrong side of this

[Ticket 04](04-profile-data-model.md) resolved, in bold:

> **Pass a callback, never a string** — a string forecloses `instructions` switching
> permanently.

`src/agent/provider.ts:309` passes a string. `systemPrompt(shell)` is evaluated once when
the harness is constructed, so a profile's `instructions` have no way to reach the model
however the questions below are answered.

This is the same class of mistake [ticket 15](15-core-already-does-this.md) was written
about — building against an assumption that a closed ticket had already corrected —
except here the ticket being contradicted is our own rather than pi's. The walking
skeleton predates ticket 04's resolution, which explains it and does not fix it.

## Fact 2 — the callback runs once per turn, and that is the whole mechanism

There is no `setSystemPrompt`. `systemPrompt` accepts
`string | ((context) => string | Promise<string>)`, and `createTurnState()` awaits the
callback **once per turn** (`agent-harness.js:291`). A callback reading current profile
state therefore gives a per-turn system prompt with no setter and no new session.

`before_agent_start` can override it as a second lever, and whether that is used at all
is one of the questions.

## Settle

- **Does `instructions` append to the base prompt, or replace it?** pi's `preset.ts`
  chose one; we have not. Replacing lets a profile build a genuinely different agent and
  lets a user delete the shell guidance that keeps the model from writing POSIX at a
  PowerShell. Appending keeps the floor and makes profiles weaker than they look.

- **What composes in, and in what order.** Base guidance, detected shell, skills via
  `formatSkillsForSystemPrompt`, workspace facts, profile instructions. Order is not
  cosmetic — later text is generally weighted more heavily by models, and a floor placed
  first is a floor a profile can talk over.

- **What happens when it changes mid-conversation.** [Ticket 14](14-switch-aftermath.md)
  decided a profile switch renders as a visible transcript divider, on the reasoning that
  the agent's instructions changing underneath a continuous-looking conversation is a UX
  problem rather than a data one. A per-turn callback makes that real: the prompt can now
  differ between two adjacent turns with nothing in the transcript saying so.

- **Whether `before_agent_start` is used at all**, or left unwired like
  `session_before_compact` was in [ticket 16](16-compaction.md). Adopting a hook to use
  none of its capabilities is surface area for nothing.

- **Whether the assembly is pure enough to check.** Everything above is string
  composition over a small record, which is the shape that takes a `.check.ts` well —
  and `context.md` requires one for branch logic. Worth deciding before writing it, not
  after.

## Out of scope

- The profile data model itself. [Ticket 04](04-profile-data-model.md) settled eight
  fields and is closed; this ticket is about one of them.
- Skills *loading*, which [ticket 15](15-core-already-does-this.md) deferred until
  profiles exist. Their composition into the prompt is in scope here; where they come
  from is not.

---

## Resolution

<!-- filled on close -->
