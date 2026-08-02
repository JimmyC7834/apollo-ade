---
label: wayfinder:grilling
title: Where pi's event stream meets the ADE
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# Where pi's event stream meets the ADE

## Question

Carried over from the paused map and re-cut. The old version asked what a Rust harness
should emit; the question now is narrower and more answerable — **pi already emits
something, and `src/agent.ts` already accepts something. What is the mapping?**

The existing contract, written when the provider was scripted:

```ts
AgentEvent = text | activity{label, detail} | approval{label, detail} | complete | cancelled
AgentRun   = { cancel(), resolveApproval(approved) }
```

That file's own comment says the scripted provider ships alone on purpose because
*"cancellation and approval are the hard parts."* They still are — but they are now
pi's cancellation and pi's tool calls, not ours.

A real pi turn carries things `activity: {label, detail}` flattens into two strings:
tool calls with structured arguments, streamed tool *results*, token usage, thinking
blocks and thinking levels, per-turn boundaries, compaction events, and errors. pi's
browser-safe export includes `createAssistantMessageEventStream`, `streamProxy`, and
`agent.steer(...)` for queued messages — read what the stream actually yields before
designing against a guess.

Settle:

- **Does `AgentEvent` grow, and by how much.** Growing it is fine; growing it
  accidentally, one field per feature, is not. The discipline worth keeping from the
  earlier discussion: this seam is *ours* and should stay our size — providers adapt
  down to it, rather than it widening to whatever pi happens to emit.
- **Tool calls specifically.** `activity` was designed for a fake that only ever
  announced. Real tool calls need identity (to pair a result with its call), structured
  input (to render a diff card rather than a string), and a lifecycle (started →
  streaming → finished/failed). Decide whether that is one richer event or several.
- **Whether the scripted provider survives the change.** `context.md` requires a
  deterministic browser implementation and names this file as it. If `AgentEvent` grows,
  the scripted provider has to grow with it or it stops being a real implementation of
  the contract — which would quietly delete the `npm run dev` path.
- **Usage and cost.** pi anchors compaction on the last real provider usage number
  rather than estimating. If those numbers cross into the UI, the ADE can show context
  pressure; if they don't, it can't. Cheap to decide now, awkward to retrofit.
- **Cancellation.** `AgentRun.cancel()` currently stops a timer. Against pi it must
  abort a stream, and possibly a running child process. What it *promises* — has the
  tool already run? — is the part to write down. Deeper semantics stay in the fog until
  [`exec`](02-exec-not-terminal.md) lands.

---

## Resolution

**A structured tool lifecycle, eleven kinds, and the seam stays ours.**

### The transport question dissolved

The original ticket asked about transport — Tauri events, a channel, command-per-poll.
That was written when a *Rust* harness was assumed. pi now runs **in the renderer**, so
`harness.subscribe(listener)` and our event stream are both in-process: the mapping is a
pure function call, with no IPC and no serialisation. The only Rust→TS streaming left is
`exec`'s output, which belongs to [`exec`](02-exec-not-terminal.md) and is already
settled as a Tauri v2 `Channel`.

### What pi emits

`AgentHarnessEvent = AgentEvent | AgentHarnessOwnEvent`. The streaming half is 10 types:

```
agent_start · agent_end{messages} · turn_start · turn_end{message,toolResults}
message_start · message_update{message, assistantMessageEvent} · message_end
tool_execution_start{toolCallId,toolName,args}
tool_execution_update{toolCallId,toolName,args,partialResult}
tool_execution_end{toolCallId,toolName,result,isError}
```

`assistantMessageEvent` (from `pi-ai`) carries the token-level deltas, including thinking
and usage. `AgentHarnessOwnEvent` adds ~22 lifecycle and hook events, of which
`session_compact` is the one the UI needs.

### The contract

`activity{label,detail}` is retired. It was designed for a provider that only ever
announced, and it cannot carry a `toolCallId` (so no card updates in place), a
`partialResult` (so no live output), or `isError` (so no failure state).

```ts
type AgentEvent =
  | { kind: 'text';      text: string }
  | { kind: 'thinking';  text: string }
  | { kind: 'tool_start';  id: string; name: string; input: unknown }
  | { kind: 'tool_update'; id: string; partial: unknown }
  | { kind: 'tool_end';    id: string; result: unknown; isError: boolean }
  | { kind: 'approval';    id: string; name: string; input: unknown }
  | { kind: 'usage';       inputTokens: number; outputTokens: number; contextTokens: number }
  | { kind: 'compacted';   tokensBefore: number; summary: string }
  | { kind: 'error';       message: string; code?: string }
  | { kind: 'complete' }
  | { kind: 'cancelled' }
```

Decisions embedded in that shape:

1. **`thinking` is its own kind, not folded into `text`.** Separating later is
   impossible; the UI can collapse or hide it only if it arrives distinguishable.
2. **`approval` carries structured `{id, name, input}`**, resolving the item
   [What stops a tool call](03-permission-gate.md) deferred. `resolveApproval(approved)`
   is unchanged. The `id` is pi's `toolCallId`, so an approval and its later `tool_end`
   are correlatable.
3. **`usage` is surfaced.** pi anchors compaction on real provider numbers rather than
   estimates, so a context meter and cost display are free at the seam and expensive to
   retrofit — every event would have to be touched again.
4. **`compacted` is surfaced.** Without it the transcript silently loses detail and the
   user is left wondering why the agent forgot something.
5. **`error` is a first-class kind.** pi surfaces `AgentHarnessError` with codes
   (`hook`, `auth`, `compaction`, …) and tool failures via `isError`. Flattening those
   into `text` makes them unstyleable and unactionable.
6. **Turn boundaries are not exposed.** `turn_start`/`turn_end` matter to the loop, not
   to the transcript; `complete` remains the user-visible terminal. Revisit only if the
   UI needs to group by turn.
7. **The seam stays ours.** Providers adapt *down* to these eleven kinds; the contract
   does not widen to match whatever pi emits. This is what keeps a vocabulary that
   breaks in minor releases every ~2.1 days from reaching the UI.

### The cost, stated plainly

`context.md` requires a deterministic browser implementation, and the map names the
scripted `src/agent.ts` provider as it. **Eleven kinds is a lot to fake convincingly** —
noticeably more than the five it implements today. Either the scripted provider grows to
match, or the rule quietly dies while appearing satisfied. This is now
[What the agent does under `npm run dev`](10-browser-mode-env.md)'s central problem, and
that ticket's third option — an in-memory `ExecutionEnv` running the *real* pi loop
against fake files — looks considerably more attractive in light of it than writing an
eleven-kind script by hand.

A `.check.ts` asserting both providers satisfy the same contract is the mechanism that
keeps this honest. This repo already writes those.
