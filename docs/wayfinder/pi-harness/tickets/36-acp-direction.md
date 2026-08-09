# 36 — Which way does ACP point?

**Blocked by:** nothing, and it blocks nothing.
**Status:** **not ready-for-agent.** This is a question, recorded at the dev's direction.
Nothing is built until it is answered.

## Why it is a ticket at all

Because the two readings of "an ACP adaptor" are different products, and a ticket that
recorded only the words would be a ticket someone later implemented in whichever direction
they happened to read first.

ACP appears nowhere in pi — `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`
mention it not at all across their whole `dist`. So either direction is entirely ours to
write, and neither is a matter of adopting something.

## The fork

**We host other agents — the client reading.** The workbench speaks ACP outward to Claude
Code, Gemini CLI, or anything else that serves it, and pi becomes one implementation
behind an interface rather than the only one.

This codebase is unusually ready for it. `src/agent/**` is 5,326 lines with **zero React
imports**, `AgentProvider` is already the seam every feature talks to, and `AgentChat` is
the only file in the app importing both React and pi. The structural work is largely done.

What it costs is that everything this repo decided about *agents* has to survive an agent
that never heard of those decisions. The gate, profiles, skills, user tools, the crop,
compaction — an external agent has its own answers or none, and "the profile says
`careful`" means nothing to a process we do not control. That is not a blocker; it is the
actual design problem, and it is bigger than the transport.

**Others drive our agent — the server reading.** We expose the harness we already have
over ACP so another editor can use it. Much smaller: the harness exists, the sessions
exist, this is a transport over them.

What it costs is the destination. This map exists to build *"pi with our front end"*, and
the server reading makes our front end optional. That is not an argument against it — it
is an argument that it needs to be chosen deliberately rather than because it was easier.

## What would settle it

Not analysis. One of:

- A second agent the dev actually wants to run inside this window. Then it is the client.
- Someone else wanting to drive this harness. Then it is the server.
- Neither, for long enough that the question stops being interesting. Then this ticket
  gets struck through and kept for the record, like the others.

## Acceptance criteria

None. There is nothing to accept until the fork is chosen. **Closing this ticket means
writing down which direction and why — not building anything.**
