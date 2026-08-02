---
label: wayfinder:grilling
title: Where the harness ends and the ADE begins
parent: ../map.md
blocked-by: []
assignee:
status: open
---

# Where the harness ends and the ADE begins

## Question

The loop runs in Rust; the chat panel is React. Everything the user sees crosses that
boundary, so its shape constrains the harness's public API.

The existing contract is already written: `src/agent.ts` defines `AgentEvent`
(`text` / `activity` / `approval` / `complete` / `cancelled`), `AgentRun`
(`cancel`, `resolveApproval`), and `AgentProvider`. That file's own comment says the
scripted provider ships alone on purpose because *"cancellation and approval are the
hard parts."* They still are.

Settle:

- **Does `AgentEvent` survive contact with a real harness, or does it need to grow?**
  A real loop has tool calls with structured arguments, streamed tool *results*, token
  usage, per-turn boundaries, compaction events, and errors. `activity: {label, detail}`
  flattens all of that into two strings. Growing it is fine; doing so accidentally,
  one field at a time, is not.
- **Transport.** Tauri events, a channel, or command-per-poll — and what the
  backpressure story is when the model streams faster than the renderer paints.
- **Where does approval live?** The harness must block mid-turn awaiting a human answer.
  That is a suspended Rust future waiting on an IPC round-trip; decide whether the
  harness owns that state or the caller does.
- **Cancellation.** What `cancel()` guarantees: stop streaming, kill in-flight tool
  children, both? And what the session log records for a cancelled turn.
- **The browser-mode obligation.** `context.md` requires every native capability to have
  a deterministic browser implementation. Whatever this boundary becomes, the scripted
  provider has to keep satisfying it.

## A hard constraint Zed hit, which we inherit

`docs/RESEARCH-zed-harness.md` §9: Zed's `ThreadEvent` enum is **not serializable** — it
carries a `oneshot::Sender` (for tool-call approval) and an `Entity<Diff>`. Zed gets away
with that because its harness and UI share a process and a GPUI executor, so an event can
carry a live channel end straight to the UI.

**Tauri IPC cannot.** Every event crossing to the renderer must be serde-serializable, so
the approval round-trip has to be a **correlation id plus a side table** rather than a
sender embedded in the event. That is a design decision to take on day one, not a
refactor: the whole enum's shape depends on it.

Related: this is the same seam as [Should the boundary be ACP?](11-acp-as-the-boundary.md),
which asks whether the vocabulary should be ours at all. Resolve that first or alongside;
answering this ticket alone would prejudge it.

Deliverable: the Rust-side public API and the TS-side `AgentProvider` shape, agreed as
one contract.
