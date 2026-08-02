---
label: wayfinder:grilling
title: What a mid-session profile switch records
parent: ../map.md
blocked-by: [01-profile-data-model.md, 04-session-store-shape.md]
assignee:
status: open
---

# What a mid-session profile switch records

## Question

The switch semantics are already decided: **non-retroactive** — a switch applies to
subsequent calls, and prior history is never rewritten. That is the cheap, correct
choice. It is not free.

Settle the consequences:

- **The switch is an entry in the session log.** Otherwise a resumed or forked session
  replays the entire history under whichever profile is active at resume time, which is
  the wrong one. Decide what that entry looks like — a marker, or a full profile snapshot.
- **Snapshot or reference?** Recording a profile *name* means a later edit to that
  profile silently rewrites what history claims to have run under. Recording the resolved
  profile makes the log self-contained and larger. This is the same trade every build
  system makes with lockfiles.
- **Orphaned `tool_use` blocks.** After a switch narrows the tool set, history still
  contains `tool_use`/`tool_result` pairs for tools no longer in the request schema.
  Confirm the provider tolerates this, and decide what the harness does if it does not.
- **System-prompt change mid-history.** The prompt is not part of the message list, so a
  switch changes it wholesale for the next request. Decide whether the model is told a
  switch happened, or left to notice.
- **Interaction with compaction.** A summary generated after a switch is summarizing
  turns that ran under a different profile. Whether that matters is a real question —
  raise it with [Compaction](10-compaction.md).
