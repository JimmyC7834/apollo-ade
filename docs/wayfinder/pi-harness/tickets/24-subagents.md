---
label: wayfinder:grilling
title: Profiles as subagent definitions
parent: ../map.md
blocked-by: [04-profile-data-model.md, 13-user-authored-tools.md]
assignee: jc4649
status: closed
---

# Profiles as subagent definitions

**Decided, then built in Slice 36.** This ticket is the record of one grilling
session. The dev's premise was that a profile is a reasonable subagent
definition, and the grill confirms it with one added field.

Everything below is implemented except two items, both named where they appear:
the deferred list at the end, and **compaction**, which turned out to have
nothing to fire on — a child runs exactly one turn and pi compacts only an idle
harness, so the rule is satisfied vacuously until the deferred chat view lets a
child be talked to again. See `docs/DEVLOG.md`, Slice 36.

## The precondition, answered

The map said one check comes first: whether pi's core supports subagent forking
at all, and that a "no" makes this "a different and much larger effort".

**pi has no subagent concept.** `subagent`, `spawnAgent`, `forkSession` and
`childAgent` return zero hits across all 34 files in
`@earendil-works/pi-agent-core/dist`.

**The map drew the wrong conclusion from that.** The effort does not grow,
because the harness is already the unit of one agent. `AgentHarness`'s
constructor (`agent-harness.js:136`) takes `session`, `models`, `model`,
`thinkingLevel`, `tools`, `activeToolNames`, `toolContext` and `systemPrompt`.
There is no registry, no singleton and no global state. **A second agent is one
`new`.**

Two things pi ships that this uses, both found rather than built:

- `JsonlSessionRepo.create` accepts `parentSessionPath` and a free-form
  `metadata` object, and `list()` returns both on every entry
  (`jsonl-repo.js:30`, `jsonl-storage.js:114`). Parentage is pi's own model.
- `memory-repo.js` exists, so an in-memory child session was available. It is
  not used — see the session decision below.

One thing pi has that must not be confused with this: session **branching**
(`getBranch`, `branch_summary`). That is one conversation splitting in two. It
is not a child agent, and the two do not share a word. `fork` also stays taken
by [ticket 14](14-switch-aftermath.md).

**pi has no step limit.** No `maxSteps`, `maxIterations` or `maxTurns` anywhere
in `dist`. A turn runs until the model stops calling tools. That is tolerable
for the main agent, which the user watches, and is not tolerable for a child
that renders as one line. See the budget decision.

## The vocabulary

- **subagent** — the child. A second `AgentHarness` with its own session.
- **delegation** — the act. It renders as a tool call, because it is one.
- **delegable profile** — a profile that a parent model may spawn.

## The decisions

### What a subagent is

A second `AgentHarness`, built from a profile, with **its own session on disk**.

The dev chose disk over memory. A child's transcript is therefore inspectable
after the fact, which is what the deferred chat view will read.

### Who spawns one

**The model**, through a `task` tool. The value of a subagent is a sub-job that
would flood the parent's context, and the model is the party that knows
mid-turn that it is about to flood itself.

The tool is listed in a profile's `tools`, so a profile that must not delegate
does not list it. [Ticket 13](13-user-authored-tools.md)'s rule covers this with
no new mechanism.

The tool takes three arguments: the **profile name**, the **prompt**, and a
short **label** the model writes. The label is not the profile name, because
three parallel children of the same profile would then read alike, and it is not
the prompt's first line, because that is a sentence.

### What makes a profile delegable

**`subagent: boolean`, plus a description the user must then write.**

The parent model chooses the child, so it must be told what each profile is for.
`instructions` is what the child is told, not what the parent reads to pick it.

`subagent: true` with no description is **dropped from the delegable list with a
warning**, reported by `/reload`. This is the shadowed-template rule from Slice
35, and one rule for both beats two. The profile still works for the user; it is
only invisible to the parent model.

### What the child starts with

**The parent's prompt, and nothing else.** No parent history. Copying that
history pays the cost the delegation exists to avoid, twice. It also makes the
prompt the whole contract, which is what makes a bad delegation debuggable.

### How many, and how deep

**Four at once**, and **depth 3 including the main agent**. Both are constants.
Making them configurable is deferred.

No cap would let one model call start twelve agents against one API key and one
working tree. A per-profile cap is configuration for a constant.

### The budget

**Fifteen minutes of wall clock per child**, reusing the timeout shape user
tools already have. Configurable in settings later; deferred.

A tool-call budget was rejected. It counts actions, so it kills a child reading
sixty files correctly and a child stuck in a cheap loop with the same number.
Time is the question a person actually asks about a background job.

On timeout the child aborts and returns what it has as a **failed task**, not as
a harness error. The delegation ran; it did not finish.

### Failure

Two kinds, and they are not the same event.

- **Harness failure** — the child could not run. This returns an error
  `tool_result`, like any failing tool.
- **Task failure** — the child ran and did not achieve the job. This returns
  normally, and the child's answer says it failed.

A bad profile name, a profile with `subagent: false`, and a delegation at depth
3 are all error `tool_result`s in pi's `invalid_argument` shape, listing the
delegable profiles in the first case. The model can then correct itself inside
the same turn, which a thrown error would not allow — the pattern
[ticket 18](18-tool-reaches-the-gate.md) set.

### The gate

**The child's own profile's `gatePolicy` decides**, and its approval requests
reach the user, serialized.

This is the case that tests the premise. A `research` profile that only reads
can sit on `auto` while an `editor` child runs `careful`, and the profile author
decided that. Taking the parent's policy instead would leave a profile field
that silently does nothing for children.

Forwarding rather than refusing follows [ticket 18](18-tool-reaches-the-gate.md):
refusing never stopped anyone, it bought indirection and cost the one case a
foot-gun guard helps. Parallel makes the cards queue, which is a UI ordering
problem. The floor is unchanged — Rust refuses outside the root, and that is the
only real boundary.

### Compaction

**Per child, on the same rules as the main agent.** The machinery is in
`src/agent/compaction.ts` and a harness is a harness. A child that fails on
overflow is a delegation that spent its whole budget and produced nothing.

Recorded caveat: a child on a model with an unknown context window never
auto-compacts. That is existing behaviour and stays honest rather than guessing
a denominator.

### The checkpoint

**One checkpoint, before the parent's turn, exactly as today.**

Per-child checkpoints do not work. Children share one working tree. Child B
takes its checkpoint after child A has already changed files, so B's "before"
picture contains A's edits, and undoing B undoes A. They are not separable.

"Undo that turn" keeps its current meaning and covers everything the children
did. Per-child undo needs a working copy per child, which is a much larger
effort and its own ticket.

### Tokens

**Counted separately.** Adding a child's usage to the parent's meter corrupts
the number that drives auto-compaction — the parent's window is not fuller
because a child read a file. Both counts are kept. Showing them together is a
UI decision, deferred.

### How it crosses the seam

**No new event kind.** A delegation renders as a tool call.
`tool_start` / `tool_update` / `tool_end` already carry an `id`, already stream
partial output, and parallel tool calls already have distinct ids. Ticket 05's
rule holds untouched: `mapEvent` learns nothing new.

The tool's partial output carries one line, newest wins:

```
researcher - research rtk and... - [read file r...]
```

Profile, the model's label, and the child's latest event. **Tool calls and
prose** produce a line; `usage` and `queued` do not, and thinking does not —
tool calls alone go silent while the child reasons, which reads as a hang.

### Where child sessions live

**One directory, and start-up skips children.** The dev chose this over a
separate root once pi's parentage fields were found.

The problem it solves: `openSession` opens **the newest file** in
`/.ade/sessions` (`provider.ts:136`). A child's file is newer than the parent's,
so without this the next launch resumes a child's conversation.

Write **both** fields. `parentSessionPath` because it is true and the deferred
tab view needs the link. `metadata.delegatedFrom` as the thing start-up filters
on — `parentSessionPath` alone would also hide a **forked** session, and a fork
is a session the user should see, on the day forking gets a UI.

### Cancellation

Cancelling the parent turn aborts every running child. Each child's session file
stays on disk, half-written, because a partial record beats no record when you
are asking why it failed.

## Deferred, and written down rather than refused

- **The child chat view.** The dev's intent is that a subagent session opens as
  a tab and replays read-only. This is deferred to a future UI/UX design pass,
  and it is **the largest single piece of this effort**. The agent chat is
  currently the whole `main` region (`WorkbenchController.tsx:616`) and there is
  one of it. Note the knock-on: once child sessions render in tabs, a picker for
  the user's own sessions is nearly free — which reopens
  [ticket 15](15-core-already-does-this.md)'s "no session picker in v1".
- **Promoting a child to a session of your own.** The honest feature behind
  "can I keep talking to that child". Not designed.
- **Steering a running child.** There is no surface to steer from until the view
  exists, and Enter in the main composer already means something else. The
  queues are per-harness, so the capability arrives with the view.
- **Child token use in the main meter.** Tracked now, shown together later.
- **Configurable concurrency, depth and timeout.** Constants until asked for.

## What is left before this is buildable

Nothing is decided that blocks it. The line-only version — delegation as a tool
call, no chat view — is a complete feature on its own and ships without any of
the deferred items above.
