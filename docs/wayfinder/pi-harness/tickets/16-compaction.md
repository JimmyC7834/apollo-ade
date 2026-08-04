---
label: wayfinder:grilling
title: Who decides when to compact
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
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

**Manual by default, automatic only when a profile asks for it and a real context window
is known. Core supplies every primitive and none of the policy; the policy is small, and
most of it is a refusal to guess.**

### Decisions

1. **`/compact` is the default and always available. Auto-compaction is a per-profile
   setting, off unless enabled.** Interim: `VITE_AGENT_AUTOCOMPACT`, following the
   precedent `readGatePolicy()` set — *"a per-profile field once profiles exist; an env
   var until then."*

2. **The check runs on `agent_end`, with the harness idle**, using the real usage the turn
   just reported. Not before the next turn, which puts a summarisation between "send" and
   any answer at all.

   This decision settles a second one for free: **`estimateContextTokens` is not adopted.**
   Its whole value is estimating messages appended *since* the last usage block, and
   post-turn there are none. `calculateContextTokens` — which Fact 1 showed is
   `usage.totalTokens` with a fallback — is the whole requirement.

   Forced by `compact()` throwing `AgentHarnessError("busy")` unless `phase === "idle"`:
   the trigger cannot live in the `subscribe()` handler, because `message_end` fires with
   the agent loop still running.

3. **`contextWindow` must be explicit — `VITE_AGENT_CONTEXT_WINDOW` now, a profile field
   later. Unset means auto-compaction cannot fire and the meter shows raw tokens with no
   percentage.**

   The three candidate numbers for the denominator were our fabricated `128_000`, pi's
   `1_000_000` for `deepseek-reasoner`'s nearest catalogued neighbours, and the truth,
   which nobody in this repo has verified. **Both available numbers err upward, and upward
   is the direction where `shouldCompact` silently never fires.** This is the rule the
   `cost` block three lines above already follows — zeroed rather than guessed — applied
   to the field where being wrong changes behaviour instead of just the display.

   One wrinkle the decision cannot remove: `Model.contextWindow` is a required `number`,
   and pi uses it for `clampMaxTokensToContext`. A fallback still has to be handed to pi.
   It is kept, named as a fallback, and **never consulted for a compaction decision** —
   only an explicitly configured window is.

4. **An overflowed turn is detected and reported, not retried.** `isContextOverflow` turns
   the generic provider error into one naming `/compact` as the fix.

   Auto-retry was refused on evidence rather than taste: `executeTurn` flushes session
   writes in its `finally`, so a failed turn leaves **the user message and an errored
   assistant message in history**. Re-sending via `prompt(text)` appends the question a
   second time, and nothing later cleans that up. (`getAssistantUsage` skips
   `stopReason === "error"`, so at least the token accounting stays clean.)

5. **The transcript keeps its one-line marker, with corrected wording and the summary
   behind a `<details>`.** History above the cut point is not dimmed: the transcript
   records what happened, and dimming implies discarded.

   The existing line is wrong and is fixed as part of this slice regardless of the
   decision — it renders `tokensBefore` as *"summarised to save N tokens"*, but
   `tokensBefore` is the size of the context **before** compaction, not the saving. A
   111 k compaction retaining ~20 k would have claimed to save 111 k.

   What makes revealing the summary worth a disclosure element: **compaction changes what
   the model sees, not what the transcript shows.** Afterwards the user is reading a full
   conversation the model has partly forgotten, and the summary is the only artifact
   describing what it still knows.

6. **`/compact` is parsed in the chat input, not contributed to the command palette.**
   Slash commands are typed where the prompt is, and the user-authored half —
   `promptFromTemplate(name, args)`, with `parseCommandArgs` behind it — needs a command
   line to take arguments from. A palette entry has nowhere to put `/review src/agent`,
   and contributing one would thread the agent session into `WorkbenchActions` for a
   single item. `commandRegistry.ts`'s own `ponytail:` note says add dynamic registration
   when a feature needs it; one command is not yet that need.

7. **The per-turn usage footer is upgraded rather than replaced.** It gains a percentage
   when the window is known and a warning state when `shouldCompact` would fire. It
   already sits directly above the composer. A persistent composer-adjacent meter is the
   obvious long-term home and is not worth a new surface today.

8. **`session_before_compact` is not wired.** Its two capabilities are veto and
   supply-your-own; the profile setting already expresses the first, `/compact` is an
   explicit instruction not worth asking twice about, and the second was ruled out by
   keeping pi's summariser. It also carries the `tool_call` hook's trap — a throw is
   wrapped by `normalizeHarnessError` and surfaces as a compaction failure rather than as
   itself.

### Consequences, not choices

- **`keepRecentTokens: 20000` is not tunable.** `compact()` hard-codes
  `DEFAULT_COMPACTION_SETTINGS` when it calls `prepareCompaction`, while `shouldCompact`
  takes a settings argument we supply. **The profile can say when, never how much.**
  [Ticket 15](15-core-already-does-this.md)'s "ship the defaults" was less a decision than
  the only option short of reimplementing `compact()`.
- **Compaction cannot be stopped.** `compact()` passes `undefined` where `signal` goes.
  Stop must be visibly *unavailable* during one rather than present and inert — this repo
  has already shipped a Stop button that did nothing pi could see, and will not ship a
  second.
- **`/compact` on a short conversation throws `"Nothing to compact"`.** A normal thing for
  a user to try; it has to read as an explanation, not a failure.
- **Two exports, never called by pi.** `shouldCompact` and `isContextOverflow` are both
  offered to applications and used by neither package. The pattern is deliberate: **pi
  ships context-pressure primitives and owns none of the policy.** Worth remembering
  before the next "core already does this" assumption.

### What this slice does *not* protect

Out of the box — no `VITE_AGENT_CONTEXT_WINDOW`, no `VITE_AGENT_AUTOCOMPACT` — the only
protection shipped here is **a better error message after the turn has already died.**

That is the honest consequence of refusing to guess the window, and it is defensible while
nobody has hit the failure. But this ticket should not be read as "compaction is now
handled". It is handled for someone who configures it. Everyone else gets a clearer
diagnosis of the same failure.
