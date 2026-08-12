# 26 — What the turn cost

**Blocked by:** none — can start immediately.
**Status:** **landed.** See [Landed](#landed).

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

## Landed

`models.ts` grew a `cost` field, filled from the same catalog files every other
entry came from — `anthropic.json` and `google.json`, read out rather than
recalled. `costFor` answers `undefined` for a model that has none, which is what
decides whether a cost ever reaches the UI; `Model.cost` still carries zeroes,
because pi's type has nowhere to put "unknown" and `calculateCost` multiplies
whatever it is handed.

**The two models this repo actually runs are the unpriced ones.** `deepseek-chat`
and `deepseek-reasoner` are absent from pi's `deepseek.json`, so there was no
rate to copy and prices from memory would have been the guess wearing a citation
this table exists to refuse. `VITE_AGENT_COST="input,output,cacheRead,cacheWrite"`
is the escape hatch, on the same terms as `VITE_AGENT_CONTEXT_WINDOW` — and it is
the path the dev will actually reach this feature by.

`mapEvent` takes a third argument, `priced`, because the event cannot answer the
question: pi fills `usage.cost` for every model and fills it with zeroes for an
unpriced one, so only the caller that built the `Model` knows whether the zeroes
mean anything.

Not done, and it is the one thing worth knowing: **the cost line has never been
seen against a real model.** pi's `fauxProvider` never calls `calculateCost`, so
browser mode reports `$0.0000` when a rate override is set and nothing at all
without one. Every real API implementation in `pi-ai/dist/api/` does call it, so
the native path should work; "should" is doing the work in that sentence.

## Acceptance criteria

- [x] `AgentEvent`'s `usage` carries input, output, cacheRead and cacheWrite cost,
      not a single total.
- [~] A turn shows its cost; the session shows a running total. **Built and
      wired, and the number itself is unverified** — see above. The rendering is
      exercised; what it renders has only been seen as `$0.0000` from a fixture
      that never prices anything.
- [x] A model with no known rates shows no cost rather than zero.
- [x] A subagent's spend is attributed to the subagent and does not move the
      parent meter. `Delegation.cost` and the task tool's `details`.
- [x] `events.check.ts` covers the mapping, including the unknown-rate case —
      and `models.check.ts`, `transcript.check.ts` and `subagent.check.ts` cover
      the ends of it, the last for a delegation's own spend.
