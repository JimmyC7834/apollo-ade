---
label: wayfinder:grilling
title: Should the boundary be ACP?
parent: ../map.md
blocked-by: []
assignee:
status: open
---

# Should the boundary be ACP?

## Question

Surfaced by `docs/RESEARCH-zed-harness.md` §10, which found something neither pi nor
Claude Code offers as prior art.

**Zed's own agent is not privileged.** `NativeAgentServer` implements the same
`AgentServer` / `AgentConnection` traits as any *external* ACP agent, in ~100 lines
(`native_agent_server.rs:23-59`), and runs the same end-to-end test macro as the external
ones. `acp_thread` does not depend on `agent` at all. The harness is a swappable
component behind a published protocol, and Zed proved it by making its own first-party
agent go through the front door.

That is a stronger version of the seam [Where the harness ends and the ADE begins](02-harness-ui-boundary.md)
is trying to draw, and it opens a strategic option this map did not previously have.

Settle:

- **Does the ADE's agent boundary speak ACP, a protocol of our own, or ACP-shaped-but-ours?**
  If ACP: the ADE gains the ability to drive *other* agents — Claude Code, Gemini CLI,
  Zed's own — through the identical interface, and the Rust harness becomes one
  implementation among several rather than the only thing that can ever sit there.
- **What does that cost?** A published protocol is a constraint: it fixes the event
  vocabulary, so harness features with no ACP representation become invisible to the UI.
  **Profiles are the immediate test case** — check whether ACP can express a profile
  switch at all, or whether it would have to ride as an out-of-band extension.
- **Does it dissolve or sharpen the destination?** If any ACP agent can be plugged in,
  the honest question "why write a harness at all rather than drive `claude -p` over
  ACP?" comes back — and this time with a real answer available, because the answer is
  *profiles and extensions*, which no external agent will expose. Confirm that holds.
- **Sequencing.** Adopting ACP later means rewriting the boundary; adopting it now means
  designing against someone else's vocabulary before knowing our own. Say which risk is
  preferred.

Resolve this **with or before** [Where the harness ends and the ADE begins](02-harness-ui-boundary.md)
— they are the same seam seen from two sides, and answering 02 first would prejudge it.
