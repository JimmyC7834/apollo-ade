---
label: wayfinder:ticket
title: Typing while the agent is running
status: open
---

# Typing while the agent is running

Found by the reuse audit recorded on the map, and it is the largest thing pi
ships that this app does not use. Today the composer is dead for the whole of a
turn: [`AgentChat.tsx`](../../../../src/features/agent/AgentChat.tsx) returns
early from `send` while `running`, and the Send button becomes Stop. Your only
two options while the agent works are to wait or to kill the turn.

pi's answer is three queues, and it is already built.

## What pi gives

| Verb | When it lands | Idle? |
| --- | --- | --- |
| `steer(text)` | inside the running turn, at the loop's next drain point | throws `invalid_state` |
| `followUp(text)` | after the current turn ends, as a new turn in the same run | throws `invalid_state` |
| `nextTurn(text)` | after the whole run settles | always allowed |

With them come `setSteeringMode` / `setFollowUpMode` (`QueueMode` is `"all"` or
`"one-at-a-time"`), a `queue_update` event carrying all three queues so a UI can
render what is pending, and an `abort` event carrying `clearedSteer` and
`clearedFollowUp` — the messages a cancel threw away.

None of it is Node-bound and none of it is new API. The work is entirely on this
side of the seam.

## What is open

### ~~1. What Enter means while a turn is running~~ — **settled: `followUp`**

The one decision that mattered, and the dev settled it in the grill. `steer` puts
your text into the running turn. `followUp` puts it after the turn. A `steer`
that the user meant as a `followUp` changes a turn that was already correct, and
that is the error nobody can undo. `followUp` has no such error.

So **Enter is `followUp`**, and **`/steer <text>` is the other verb**. The app
already finds commands with a `/` prefix, so `steer` needs no new control and no
new key. `nextTurn` gets no surface: it is what Enter already does when the
harness is idle.

### ~~2. Whether the event contract grows a kind~~ — **settled: a thirteenth kind**

[Ticket 05](05-event-contract.md) settled twelve kinds and none of them is "a
message you typed that has not been sent yet". The dev chose to add one.

**I recommended the opposite and he overruled it, correctly.** My argument was
that queued text is composer state, so it does not belong on the domain
interface. The argument is wrong in one place: `queue_update` is a **pi** event,
and the seam exists so that no feature module reads pi's vocabulary. Rendering
the queue straight from `queue_update` puts pi's event shape inside `AgentChat`,
which is the one thing [ticket 05](05-event-contract.md) exists to prevent. It
also breaks the rule that `mapEvent` is the only place that knows pi's names —
the names that change in minor releases every couple of days.

So the queue crosses the seam as our own kind, `mapEvent` maps it, and
`events.check.ts` covers it like the other twelve.

**Open, and small.** The kind carries the queue, not one message: `queue_update`
sends all three arrays every time, and a "one message was queued" event would
make `AgentChat` rebuild a list pi already sends whole. Shape it as the state, not
as the change.

### 0. The command list comes first

Settled with [ticket 21](21-command-autocomplete.md) in the same grill. `/steer`
is a fourth typed command, and `AgentChat` still finds commands with a chain of
`startsWith`. The chain becomes **data** before either ticket builds anything.
Three consumers now want the list: completion, `/steer`, and prompt templates
later. Building it twice costs more than building it once.

### 3. What a cancel says

`abort` returns the cleared queues, so the app knows exactly which of your
sentences it threw away. Saying nothing is the cheapest option and the one that
loses typed text silently. This is small but it is the kind of thing that is
never added later.

### 4. The transcript model

`AgentChat` keeps one `Turn` per prompt. A steered message arrives *inside* an
existing turn and a followed-up one starts a new turn that the user did not
press Send for. Both need a shape before either verb is wired.

### 5. Queue mode

`"all"` versus `"one-at-a-time"`, per queue. Probably pi's defaults untouched,
for [ticket 15](15-core-already-does-this.md)'s reason — but it is a field with
two values and no evidence yet, so it is named rather than assumed.

## What is already decided and does not need revisiting

- **The gate is not affected.** An approval card leaves the harness in `turn`
  phase, so typing while one is up is an ordinary steer. The card is answered by
  its own buttons and stays that way.
- **Profile switching is unchanged.** A switch is non-retroactive and applies
  from the next call; a queued message drains into whatever profile is active
  when it lands, which is the same rule.
- **`nextTurn` needs no phase check**, so whatever Enter does while running, the
  idle path is untouched.

## Why it was not done earlier

Nothing asked for it. The map's destination named profiles, a gate and
user-authored tools; queueing is not on it, and every turn so far has been short
enough that waiting was free. It surfaces now because the audit read the harness
surface for a different reason and found three verbs with nothing calling them.
