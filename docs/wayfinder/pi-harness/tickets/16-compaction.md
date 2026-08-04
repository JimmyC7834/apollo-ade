---
label: wayfinder:grilling
title: Who decides when to compact
parent: ../map.md
blocked-by: []
assignee: jc4649
status: open
---

# Who decides when to compact

## Question

Opened by [What pi already does that we are reimplementing](15-core-already-does-this.md),
which put compaction in as group D and made it the next slice. The premise going in was
*"adopt pi's compaction"* — the same premise that turned out to be right for sessions and
for bash.

**It is only half right here.** Grepping `dist/` before planning the slice — the standing
rule that ticket 15 just made policy, applied to itself — turns up the fact the plan was
about to assume away:

```
$ grep -rn "shouldCompact" dist --include=*.js | grep -v compaction/compaction.js
$
```

**`shouldCompact` is exported and never called.** Nothing inside `pi-agent-core` invokes
it. `AgentHarness.compact()` is a method someone else has to call, and `agent-harness.js`
reaches for `prepareCompaction` in exactly one place — `navigateTree`, for branch
summaries, not for context pressure.

So the ticket's subject is not *whether* to adopt compaction. Core ships the whole
expensive half: cut-point selection, turn-boundary handling, summary generation, the
file-operation ledger, session entries, and a `session_compact` event that
`src/agent/events.ts` already maps to our `compacted` kind. **What core does not ship is
the decision to run it**, and that decision is this ticket.

---

## Fact 1 — the meter was already right

`src/agent/events.ts` says of its context number:

> The provider's own total rather than pi's `calculateContextTokens`, which needs the
> whole session. Enough for a meter; revisit if it has to drive compaction.

This is the revisit, and the comment over-apologised. `calculateContextTokens` is:

```js
export function calculateContextTokens(usage) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
```

It takes a `Usage`, not a session — **it is `usage.totalTokens` with a fallback for
providers that omit it.** The meter is not an approximation of pi's number; it is pi's
number, minus the fallback.

There is a real gap, but it is a different one. `estimateContextTokens(messages)` returns:

```ts
{ tokens, usageTokens, trailingTokens, lastUsageIndex }
```

— provider usage *plus a character-heuristic estimate of everything appended since the
last assistant message*. Between an assistant turn and the next request, the context grows
by the user's message and every tool result, none of which any usage block has counted
yet. A meter that reads only the last usage is **stale by exactly the amount that a long
tool-heavy turn adds**, which is the case where compaction matters most.

## Fact 2 — the threshold's denominator is a number we made up

```js
export function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
}
```

`contextWindow` comes from `Model.contextWindow`. In `src/agent/provider.ts` that is:

```ts
contextWindow: 128_000,
maxTokens: 8_192,
```

hard-coded for every model, next to a `cost` block that is deliberately zeroed with the
comment *"a wrong cost table produces confident wrong numbers in the UI, which is worse
than none."* The same argument applies with more force here, because `contextWindow` is
not decorative: **a wrong window silently moves the compaction trigger.** Too high and
compaction never fires before the provider rejects the request; too low and it fires
constantly, throwing away history nobody needed to lose.

`DEFAULT_COMPACTION_SETTINGS` is `{ enabled: true, reserveTokens: 16384, keepRecentTokens:
20000 }`. With a real 128 k window that trips at 111.6 k. With a fabricated 128 k standing
in for a model that actually has 64 k, it never trips at all.

This is [ticket 15](15-core-already-does-this.md)'s catalog decision arriving sooner than
expected. That decision — machinery in, entries hand-written — is not reopened here, but
it now has a consequence: **the hand-written entry has to carry a true `contextWindow`,
and being wrong about it is no longer cosmetic.**

Note also that `enabled: true` in the defaults means nothing on its own. Nothing reads it
but `shouldCompact`, and nothing calls `shouldCompact`. It is a flag core defines for an
application that has not been written yet — ours.

## Fact 3 — there is a recovery path, and it is provider-aware

`pi-ai` exports `isContextOverflow(message, contextWindow?)`, backed by a pattern table
covering roughly fifteen providers by name — Anthropic's *"prompt is too long"*, OpenAI's
*"exceeds the context window"*, Google's *"input token count exceeds the maximum"*, and so
on — plus two documented unreliable cases (z.ai silently accepts overflow; Xiaomi MiMo
truncates and returns zero output).

This matters because **any threshold we choose will sometimes be wrong**, and the
alternative to a perfect threshold is not a better threshold but a recovery. An overflowed
turn currently surfaces as `{ kind: 'error' }` from `message_end` with
`stopReason === 'error'` — indistinguishable, to the user, from a bad API key.

## Fact 4 — the hook exists for cancelling, and for the gate's precedent

`session_before_compact` returns `SessionBeforeCompactResult { cancel?, compaction? }`.
It can veto a compaction or supply one wholesale. This is the same shape as the `tool_call`
hook the permission gate uses, and it carries the same trap: a hook that throws is wrapped
into an `AgentHarnessError` and kills the turn, which `src/agent/gate.check.ts` asserts
against for tools and would need to assert against here too if we use it.

---

## Settle

- **Where the trigger lives.** Between turns in `provider.ts`, or inside the existing
  `subscribe()` handler on `message_end`? The second is closer to the data and further
  from a good place to `await` a summarisation call.

- **`estimateContextTokens` or `calculateContextTokens`.** Fact 1 says these differ only
  in whether uncounted trailing messages are included, and the heuristic half costs a walk
  over the message list per check. Decide whether the meter and the trigger read the same
  number — and if they do not, whether the user seeing one number while a different one
  fires compaction is acceptable.

- **Automatic, manual, or both.** `/compact` is a command with no decision in it
  (ticket 15). Automatic compaction is the decision: it edits the conversation without
  being asked, which for a *coding* agent means the model can silently lose the thing it
  was told forty messages ago. Weigh against the alternative, which is the turn dying.

- **What `contextWindow` becomes.** A required field per hand-written entry with no
  default, an env var, or a conservative floor. Fact 2 rules out keeping `128_000` as a
  silent default for everything.

- **Whether an overflow error triggers a compact-and-retry**, using `isContextOverflow`.
  This is the safety net for a wrong threshold, and it is also the one path that can loop:
  compact, retry, overflow again. Decide the stopping condition before, not after.

- **What the transcript shows.** The `compacted` event carries `tokensBefore` and
  `summary` and has never fired — [ticket 15](15-core-already-does-this.md) established it
  was *unreachable* rather than untested, and slice 16 made it reachable without anything
  yet reaching it. Decide whether the summary is visible, collapsed, or merely marked, and
  whether compacted history is dimmed or dropped from the view.

- **Whether `session_before_compact` is used at all.** Cancelling is the only capability
  we would want, and we only want it if compaction is automatic.

## Out of scope

- **Tuning `DEFAULT_COMPACTION_SETTINGS`.** [Ticket 15](15-core-already-does-this.md)
  closed the map's fog entry on this provisionally: ship the defaults, reopen on the first
  bad summary. Choosing `reserveTokens` from first principles before observing one real
  compaction is the guessing that entry warns about.
- **Branch summarisation** (`navigateTree`, `collectEntriesForBranchSummary`). Same
  machinery, different feature; forking has no UI in v1 by ticket 15's resolution.
- **The command system.** Deleted from the queue by ticket 15 and shipping alongside this
  slice as a lookup table, not as a design.

---

## Resolution

<!-- filled on close -->
