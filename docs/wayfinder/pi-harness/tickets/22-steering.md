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

### 1. What Enter means while a turn is running

The one decision that matters, because it is the whole feature to a user and
there is no obviously right answer. `steer` interrupts and changes what the agent
is doing now, which is what you want when it has gone the wrong way. `followUp`
queues the next thing, which is what you want when it is doing fine and you have
already thought of the next step. Guessing wrong is worse than not having the
feature, because a steer that was meant as a follow-up derails a turn that was
working.

Three shapes to weigh: one verb chosen by a rule, two affordances the user picks
between, or a modifier key. Note that the app already has a shape for this —
`/skill` and `/profile` are typed commands rather than buttons — so a prefix is
available and costs no chrome.

### 2. Whether the event contract grows a kind

[Ticket 05](05-event-contract.md) settled twelve kinds and none of them is "a
message you typed that has not been sent yet". A queued message is not `text`
(that is the model speaking) and it is not a turn of its own until it drains.
Either a thirteenth kind carries it, or the queue is rendered from
`queue_update` in `AgentChat` without crossing the seam at all. The second is
smaller and the first is the one that survives a second UI.

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
