---
label: wayfinder:grilling
title: Does one profile definition also define a subagent?
parent: ../map.md
blocked-by: [01-profile-data-model.md]
assignee:
status: open
---

# Does one profile definition also define a subagent?

## Question

A profile and a subagent are different *verbs* over what may be the same *noun*.

- A **profile** configures the session you are in: one context window, continuous, chosen
  by the user, lasts until switched.
- A **subagent** configures a child you spawn: a **forked** context window
  (`createSubagentContext`, `forkSubagent.ts`), seeded only with the prompt string the
  parent wrote, running the same loop recursively (`runAgent.ts:748`), writing its own
  sidechain transcript, returning **only a final report** as one `tool_result`. That last
  property is the entire point — it is a context-economy device.

Both payloads are the same: tools + system prompt + model + skills. Claude Code already
demonstrates the unification — `--agent` sets the *main-thread* persona from the very
same `.claude/agents/` file that `AgentTool` spawns children from.

Settle:

- **One type or two?** If one, the extra fields a spawn needs (a description telling the
  parent model *when* to spawn it, an isolation mode, a return contract) have to exist on
  the profile type from the start, even if unused.
- **Are subagents in scope for this harness at all?** pi omits them deliberately. They
  are the main alternative to leaning on compaction — cross-check
  [Compaction: what pi engineered and whether we need it](10-compaction.md). Ruling them
  out makes compaction load-bearing; ruling them in makes it less so.
- If out of scope, say so and leave the profile type room to grow one field later.

This is cheap to decide now and expensive to retrofit, which is the only reason it is a
ticket rather than fog.
