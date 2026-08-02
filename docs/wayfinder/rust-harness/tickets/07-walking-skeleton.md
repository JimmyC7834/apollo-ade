---
label: wayfinder:prototype
title: Thinnest end-to-end turn
parent: ../map.md
blocked-by: [02-harness-ui-boundary.md, 03-provider-scope.md, 06-tool-schemas-in-rust.md]
assignee:
status: open
---

# Thinnest end-to-end turn

## Question

A throwaway spike to test whether the contracts agreed upstream survive contact with a
real turn — **not** the beginning of the harness. Delete it afterward.

One prompt from the ADE chat panel → a real streamed model response → one tool call
(`read`) → tool result fed back → final text rendered in the panel. No sessions, no
compaction, no profiles, no permissions.

What it is trying to falsify:

- Does the `AgentEvent` contract from
  [Where the harness ends and the ADE begins](02-harness-ui-boundary.md) actually carry a
  real streamed turn, or does it need fields nobody predicted?
- Does async Rust streaming into Tauri events behave under a fast stream, or does the
  renderer fall behind?
- Does the tool-schema approach from
  [How tools are declared and validated in Rust](06-tool-schemas-in-rust.md) round-trip
  through a live model — schema out, arguments back, validated, dispatched?

Answer this ticket with **what broke**, not with working code. If nothing broke, that is
also the answer, and the three upstream contracts are confirmed.
