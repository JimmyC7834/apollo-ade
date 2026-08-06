---
label: wayfinder:ticket
title: Typing while the agent is running
status: closed
---

# Typing while the agent is running

**Shipped in Slice 32.** Enter queues a follow-up, `/steer <text>` changes the
running turn, and the queue crosses the seam as the thirteenth event kind. The
three small points left open below were settled while building; each one is
recorded where it was decided.

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

The kind carries the queue, not one message: `queue_update` sends all three
arrays every time, and a "one message was queued" event would make `AgentChat`
rebuild a list pi already sends whole. It is shaped as the state, not as the
change.

**Two arrays, not three.** `nextTurn` is dropped in `mapEvent`. Enter on an idle
harness is `prompt()`, so nothing in this app can ever put a message in that
queue — and a field that is always empty is a field that will be misread.

### ~~0. The command list comes first~~ — **done**

Settled with [ticket 21](21-command-autocomplete.md) in the same grill, and
built first. The chain of `startsWith` is now
[`src/agent/commands.ts`](../../../../src/agent/commands.ts): a list of commands
with a summary, an argument source and a `whileRunning` flag, plus
`parseCommand`. `AgentChat.send` matches against the list and keeps the bodies,
because each body closes over the provider and the component's state.

It is not in `src/commands/commandRegistry.ts`. That registry is the workbench
palette — entries there carry a `run`, are fuzzy-searched, and belong to the
window. Sharing one list would mean a "which surface" field on every entry.

### ~~3. What a cancel says~~ — **settled: it says what was not sent**

**Not from `abort`.** The cleared queues pi returns arrive too late to be
useful: `cancel()` synthesises `cancelled` at once rather than waiting for pi
(the reason is in `provider.ts`), and the subscription is disposed before pi's
`abort` lands. So the app already holds the answer — the last `queued` state is
exactly what was never sent — and `queuedLabel` reads it.

One sentence, and the two queues are not told apart in it. From the composer
they are one thing: text you typed that the agent has not read. Where it was
bound for stops mattering the moment it is gone.

A turn that *completes* with a queue left over gets the same sentence, which is
not a special case: a run that ends never drains what is left, so the message is
as lost as a cancelled one.

### ~~4. The transcript model~~ — **settled: state on the turn, not a part**

A queued message is not a `Part`. Every part is something that **happened**, and
these have not — so `Turn` grows a `queued` field instead, replaced whole on
every `queued` event because pi sends both queues whole on every change.
Appending parts would have left the transcript claiming a message was sent after
the queue had drained it, or thrown it away.

The follow-up does *not* open a second `Turn`. pi drains it inside the same
`prompt()` call, so its output arrives on the same subscription and lands in the
same turn — which is also the truthful rendering, since it was one run.

### ~~5. Queue mode~~ — **settled: pi's defaults, untouched**

`setSteeringMode` and `setFollowUpMode` are not called. pi defaults follow-up to
`"one-at-a-time"`, and there is still no evidence for anything else —
[ticket 15](15-core-already-does-this.md)'s rule. The setters are there when a
user asks for the other behaviour.

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
