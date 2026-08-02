---
label: wayfinder:grilling
title: Compaction — what pi engineered and whether we need it
parent: ../map.md
blocked-by: [03-provider-scope.md, 04-session-store-shape.md]
assignee:
status: open
---

# Compaction — what pi engineered and whether we need it

## Question

~1,290 lines in pi, and the research doc argues it is the more carefully engineered of
the two harnesses' compaction *because* pi has no subagents, no MCP tool-search, and no
lazy skill loading — compaction is the only lever it has.

pi's approach, arithmetic and conservative:

- Anchor on the **last real provider usage number** rather than estimating tokens
  (`compaction.ts:230-258`).
- Compact when `tokens > window − 16384`; keep ~20k of recent context.
- **Carry a ledger of files read and modified forward across every compaction**
  (`compaction.ts:47-68`) so that information survives summarization. This is the
  thoughtful bit and the cheapest thing to steal.
- Guard against double-compaction by checking whether the usage figure predates the last
  compaction.

Claude Code's, staged and architectural: **clear old tool outputs first** — try the cheap
fix before summarizing — then summarize, emit a `compact_boundary` event, and refuse to
thrash if one giant output keeps refilling the window.

Settle:

- **Does v1 compact at all?** A harness that errors at the context limit is honest and
  small. Say whether that is acceptable for v1 or not.
- **If yes: clear-then-summarize, or straight to summarize?** The staged approach is
  strictly better and not obviously more code.
- **The file ledger** — in or out. It is the highest value-per-line idea in pi's harness.
- **Anchoring on real usage** requires the provider layer to surface usage numbers per
  response — a requirement on [How many providers does v1 speak?](03-provider-scope.md).
- **Where the summary is written** in the session log, and whether a compacted session
  can still be forked from a pre-compaction point — a requirement on
  [Session log — tree or line?](04-session-store-shape.md).
- Interaction with a mid-session profile switch — see
  [What a mid-session profile switch records](09-mid-session-switch.md).
