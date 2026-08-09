# 26 — What the turn cost

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent.

## The whole ticket is one discarded field

pi already computes this. Every `message_end` carries
`usage.cost = { input, output, cacheRead, cacheWrite, total }`, and `Model.cost` carries
the per-token rates plus request-wide pricing tiers. `mapEvent` in `src/agent/events.ts`
reads `usage.input` and `usage.output`, computes `contextTokens`, and **drops `cost` one
line from where it is needed**.

[Ticket 19](19-model-entries.md) closed with *"cost stays absent while nothing displays
it."* Displaying it is now the only missing half, and the surface that would show it is
the token line already rendering under every turn.

## What to build

The cost of a turn, shown beside the tokens it already shows, and a session total.

Three things to decide, and they are the ticket:

- **Cache reads and writes are separate rates and usually the interesting ones.** A
  single total hides the thing a person would act on. Show the total, but do not throw the
  breakdown away at the event boundary — `AgentEvent` should carry all four.
- **A subagent's cost is not the parent's.** [Ticket 24](24-subagents.md) already keeps
  child tokens apart from parent tokens, for a stated reason: adding them corrupts the
  number auto-compaction divides by. Cost inherits that argument exactly. A delegation
  should be able to report what it spent without the parent's meter moving.
- **Cost can be unknown.** `Model.cost` comes from pi's catalog and a model we added by
  hand may have no rates. Unknown must render as absent, not as `$0.00`. Ticket 19 made
  the same call for `thinkingLevelMap` and it was right.

## Acceptance criteria

- [ ] `AgentEvent`'s `usage` carries input, output, cacheRead and cacheWrite cost, not a
      single total.
- [ ] A turn shows its cost; the session shows a running total.
- [ ] A model with no known rates shows no cost rather than zero.
- [ ] A subagent's spend is attributed to the subagent and does not move the parent meter.
- [ ] `events.check.ts` covers the mapping, including the unknown-rate case.
