---
label: wayfinder:prototype
title: Thinnest end-to-end turn
parent: ../map.md
blocked-by: [01-execution-env-surface.md, 05-event-contract.md, 06-credentials-and-http.md]
assignee:
status: open
---

# Thinnest end-to-end turn

## Question

A throwaway spike to test whether the contracts agreed upstream survive contact with a
real turn. **Not** the beginning of the harness — delete it afterward. This map is
planning-only; the prototype exists to falsify decisions, not to ship.

One prompt from the ADE chat panel → a real streamed model response → one tool call
(`read`) → tool result fed back → final text rendered in the panel. No sessions, no
compaction, no profiles, no permissions, no rtk.

What it is trying to falsify:

- **Does the `AgentEvent` contract from [Where pi's event stream meets the ADE](05-event-contract.md)
  actually carry a real streamed turn**, or does it need fields nobody predicted? This
  is the main event. A contract designed against a scripted provider has never seen a
  model change its mind mid-stream.
- **Does the `ExecutionEnv` from [ticket 01](01-execution-env-surface.md) satisfy pi's
  never-throw invariant under a real tool call** — including the failure path. Point it
  at a file that does not exist and confirm a `Result` comes back rather than a rejected
  `invoke` bubbling into pi's loop.
- **Does the credential shape from [ticket 06](06-credentials-and-http.md) actually
  stream?** If Rust proxies the HTTP, this is the first time streamed bytes cross the
  IPC, and it is the riskiest thing on that ticket.
- **Does Rollup treeshake pi as well as esbuild did?** Carried here by
  [What pi costs in the bundle](08-bundle-cost.md), which measured under esbuild only.
  `pi-agent-core` declares no `sideEffects` field and its dist imports pi-ai's *barrel*
  rather than subpaths, so this is the first honest test through the real Vite config.
  Record the gzip delta against the pre-pi baseline of 1,122 kB.
- **What do providers do with an orphaned `tool_use` block?** Added by
  [What a profile switch leaves behind](14-switch-aftermath.md), which established that pi
  passes history through unfiltered and therefore cannot answer this for us. Once a tool
  call has completed, re-send the same history with that tool removed from the request
  schema and record what each provider does — Anthropic, OpenAI and Google may differ, and
  all three are bundled. This is the cheapest possible probe *given a turn that already
  works*, which is why it lives here rather than in its own ticket. It is a measurement,
  not a feature: it does not make the spike grow.
- **Does the renderer keep up?** `context.md` warns the browser pane serves no animation
  frames and is not equivalent to the native window. A fast token stream into React is
  exactly the case that differs, so **this must be run natively** —
  `docs/OPEN-ISSUES.md` documents the WebView2 debugging port.

Explicitly out of the spike: making it good, making it survive, or letting it grow a
second feature. If it works, record what it proved and delete the code. If it fails,
that is a better outcome — reopen whichever ticket it falsified.

One caution from `docs/OPEN-ISSUES.md` worth reading first: a hand-rolled
`plugin:event|listen` payload wedges the IPC, after which every `invoke` hangs while the
renderer keeps running — indistinguishable from the command under test deadlocking. An
hour has already been lost to that once.
