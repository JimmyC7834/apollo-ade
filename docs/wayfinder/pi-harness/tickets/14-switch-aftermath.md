---
label: wayfinder:grilling
title: What a profile switch leaves behind
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# What a profile switch leaves behind

## Question

Graduated from the map's fog by
[Where sessions are stored when there is no Node](09-session-store.md), which settled
the mechanism and the recording format. Switching is **non-retroactive** — a decision
taken before any ticket — so prior history is never rewritten. That is the cheap, correct
choice, and this ticket is about the debris it leaves.

Already settled elsewhere, and not to be reopened here:

- The switch is recorded by **profile name**, in a `CustomEntry` with
  `customType: "profile_switch"`, alongside the `model_change` /
  `thinking_level_change` / `active_tools_change` entries pi already ships (ticket 09).
- A dangling profile reference **refuses** rather than degrading silently (ticket 04).
- Tools are mutable mid-session via `setTools` / `setActiveTools` (ticket 04).

What is left is what happens to a *history* that was written under a different profile.

Settle:

- **Orphaned `tool_use` blocks.** After a switch narrows the tool set, history still
  contains `tool_use`/`tool_result` pairs for tools no longer in the request schema. This
  is primarily a **factual** question — confirm what the providers actually do when a
  message references a tool absent from the current schema. Anthropic, OpenAI and Google
  may differ, and every provider is now bundled. Only once that is known is there a
  decision: tolerate it, filter history on the way out, or refuse to narrow the tool set
  mid-session. Note that filtering history is a form of rewriting it, which sits awkwardly
  against the non-retroactive rule.
- **A system prompt that changes mid-history.** The prompt is not part of the message
  list, so a switch silently changes the frame around messages already written. There is
  no corruption to fix — decide whether it is *recorded* (the `profile_switch` entry
  implies it, but only by reference), and whether the transcript shows the user that the
  agent's instructions changed underneath the conversation. This is a UX question more
  than a data one.
- **Compaction across a switch.** pi carries a ledger of files read and modified forward
  through every compaction. If a compaction spans a switch boundary, the summary is
  generated under whichever profile is active at compaction time — including its
  `instructions`. Decide whether that matters, and whether the `compacted` event from
  [the event contract](05-event-contract.md) should note it.
- **Fork and replay.** `SessionRepo.fork(metadata, {entryId, position})` exists. A fork
  taken mid-session inherits whichever profile was active at the fork point — confirm that
  falls out of replaying the entries, rather than needing its own handling.

Out of scope: whether profiles also define subagents, which remains in the map's fog.

---

## Resolution

**Tolerate the debris. History is never filtered, the active profile is derived from the
entry stream, and the one genuinely unknown fact is handed to the walking skeleton as a
probe rather than guessed at here.**

### What pi does, established from the published 0.83.0 tarball

`createTurnState` (`harness/agent-harness.js:277-310`) splits two things that sound alike:

```js
const tools = [...this.tools.values()];                       // everything registered
const activeTools = this.activeToolNames
    .map((name) => this.tools.get(name))
    .filter((tool) => tool !== undefined);                    // the narrowed set
```

and `createContext` (`:311-317`) sends **`turnState.activeTools`** as the request schema
while passing **`context.messages.slice()`** — the history — through untouched.

So pi does not filter history, does not reconcile it against the tool schema, and has no
notion that an orphan exists. Two consequences:

- Whatever we decide, **pi will not do it for us**; filtering would be our code sitting
  between the session and the provider.
- The narrowing is genuinely non-destructive at pi's layer: `this.tools` still holds the
  removed tool's full definition even when it is not in `activeToolNames`. That matters
  for decision 2 below, because it means a mitigation is available cheaply *if* we turn
  out to need one.

### Decisions

1. **Do not filter history, and do not refuse to narrow the tool set.** Filtering is
   rewriting, which contradicts the non-retroactive rule the map settled in
   [Where sessions are stored when there is no Node](09-session-store.md); refusing to
   narrow makes mid-session profile switching useless, which is the feature. Both
   alternatives cost more than the problem is known to be worth.

2. **Whether orphaned `tool_use` blocks are actually rejected is not decided here — it is
   a probe, and it belongs to [the walking skeleton](12-walking-skeleton.md).** This
   ticket cannot answer it by reading: it is a live-API behaviour across Anthropic, OpenAI
   and Google, and the map is planning-only with no key in play. Recording it as *settled*
   on reasoning would be the kind of guess this map has already had to retract three
   times.

   What makes deferring it safe is that the mitigation is known and small. If a provider
   rejects a message referencing a tool absent from the schema, the fix is to include the
   orphaned tool's schema in the request while leaving it out of `activeToolNames` — the
   definition is still in `this.tools`, so this is a schema-assembly change at our
   `createContext` equivalent, not a session-format or profile-model change. **The
   decision above does not depend on the probe's outcome; only the size of the follow-up
   does.**

3. **A system-prompt change mid-history is shown, not just recorded.** The
   `profile_switch` `CustomEntry` already records it by reference, and that is enough for
   replay. It is not enough for the user: the agent's instructions changed underneath a
   conversation that reads as continuous. The transcript renders the switch as a visible
   divider naming the profile — the same entry, rendered rather than silent. This is a UX
   fix with no data cost.

4. **Compaction records the profile it ran under, in one field.** A summary spanning a
   switch boundary is generated under whichever profile is active at compaction time,
   including its `instructions`, and that is left as-is — regenerating or splitting the
   summary is far more machinery than the problem justifies. `CompactionEntry` carries
   `details?: T`, which is app-defined and generic, so the profile name goes there. The
   `compacted` event from [the event contract](05-event-contract.md) surfaces it. The
   value is diagnostic: when a summary reads oddly, the profile that wrote it is on the
   record instead of being inferred.

5. **Derive the active profile from the entry stream, not from session metadata.** This is
   the decision the fork question actually turns on. If loading a session scans entries
   for the last `profile_switch`, then `fork(metadata, {entryId, position})` inherits the
   correct profile with no fork-specific handling — the fork point is an entry index, and
   the profile is a function of the entries before it. Storing the active profile in
   session metadata instead would make it *wrong* on every mid-session fork, silently,
   because metadata is copied whole while entries are truncated.

   So it does fall out of replay, as the question suspected — **but only under this
   representation**, and the cheaper-looking one is the broken one.

### Not settled here

The orphan probe itself (decision 2), which is now an explicit deliverable of
[the walking skeleton](12-walking-skeleton.md).
