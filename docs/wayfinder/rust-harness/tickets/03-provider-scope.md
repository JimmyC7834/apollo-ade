---
label: wayfinder:grilling
title: How many providers does v1 speak?
parent: ../map.md
blocked-by: []
assignee:
status: open
---

# How many providers does v1 speak?

## Question

The single largest scope risk on the map. pi's harness imports **no** provider SDK —
the entire LLM surface is one injected function, `StreamFn`, contracted to *never throw
and encode failures in the stream* (`pi/packages/agent/src/types.ts:23-27`). That seam
is free to copy and painful to retrofit. What plugs into it is the decision.

Settle which of these v1 is:

- **B1 — Anthropic-only, direct.** One HTTP client speaking the Messages API. Smallest
  honest scope, and it buys Claude Code's advantage: a harness tuned to one model family
  hard-codes prompt-caching layout, thinking-level semantics, and tool-call format
  instead of negotiating them generically.
- **B2 — the seam, with one implementation behind it.** Same code today, optionality
  preserved.
- **B3 — port the provider layer.** ~21,000 lines. The map rules this out of scope;
  reopening it means redrawing the destination.

Evidence for what genericity costs, from `docs/RESEARCH-agent-harnesses.md`: pi carries
a 10KB `compat.ts`, a 6KB `legacy-api-aliases.ts`, a conditional-type `Model.compat`
with per-API override shapes, plus `constrained-sampling.ts` and `transform-messages.ts`
— all of it the tax for putting Cerebras, Bedrock and llama.cpp behind one interface.

Also settle:

- **Where credentials live.** Root-confined Rust is the only process authority here, so
  the renderer must never hold a key. Say where it does live and who reads it.
- **Whether the model is profile-scoped** — cross-check against
  [What is a profile, concretely?](01-profile-data-model.md).
