---
label: wayfinder:grilling
title: How rtk becomes a profile setting
parent: ../map.md
blocked-by: [02-exec-not-terminal.md, 04-profile-data-model.md]
assignee: jc4649
status: closed
---

# How rtk becomes a profile setting

## Question

One of the three things the dev asked for by name. The map already settled the *shape*:
rtk is a **per-profile setting**, not a transparent wrapper on every command and not a
tool the model chooses. So a "cheap" profile routes shell commands through rtk and a
"careful" one does not.

What rtk is, for whoever picks this up: a CLI proxy that filters verbose command output
down to what matters — `git status` becomes `rtk git status` — claiming 60–90% token
savings on dev operations. The dev already runs it under Claude Code via a hook that
rewrites commands transparently. That hook is the prior art, and it is also the design
this map deliberately did *not* choose.

Settle:

- **The field's shape**, which [the profile data model](04-profile-data-model.md) will
  want back. A boolean is honest if rtk is the only wrapper we will ever want. An
  `execWrapper: string` generalizes at the cost of an obvious injection surface. A
  command allowlist is the middle and probably the most useful, since rtk only helps for
  commands it knows.
- **Where the rewrite happens.** In the `ExecutionEnv.exec` adapter is the natural place
  — but note the interaction with [the permission gate](03-permission-gate.md): if the
  user approves `git status` and the harness runs `rtk git status`, the approval no
  longer describes what ran. Decide whether the gate sees the original or the rewritten
  command, and what the user is shown. This is the genuinely interesting part of the
  ticket.
- **What happens when rtk is absent.** It is an external binary that may not be
  installed, may be the *wrong* rtk (the dev's own notes flag a name collision with an
  unrelated `rtk`), or may fail. Decide the fallback — silently run the raw command, or
  refuse — and note that silently falling back means the token savings quietly stop
  without anyone noticing.
- **Whether filtered output is safe to feed a model.** rtk's value is dropping detail.
  A harness that drops detail the agent needed produces a worse turn, and the failure is
  invisible — it looks like the model being dumb. Decide whether any commands are
  exempt, and whether the agent is told its output was filtered.
- **Verification.** `rtk gain` reports savings. Whether the ADE surfaces that, and
  whether it is the honest measure once a coding agent rather than a human is the
  consumer, is worth one line.

---

## Resolution

**`rtk: boolean` on the profile. Applied in the bash tool's `prepare` hook.**

### The field

```
rtk: boolean
```

On or off, as the dev decided. This is the honest shape *if rtk is the only command
wrapper this project will ever want* — and a boolean is the right bet, because widening
it later is a config migration, which is cheap while the config has one author. An
`execWrapper: string` would generalise at the cost of an obvious command-injection
surface, and a per-command allowlist is speculative until a real command is shown to be
harmed by rtk.

### Mechanism

**`prepare`, not `commandPrefix`.** Correcting what ticket 01's resolution first
recorded: `commandPrefix` builds `` `${prefix}\n${command}` `` — a *preamble line* for
shell setup, not a wrapper. The seam is
`BashToolOptions.prepare?: (execution, context, signal) => void | Promise<void>`, which
is awaited and free to mutate `execution.command` before it runs
(`harness/tools/bash.js:36`).

So: construct the bash tool with a `prepare` that consults the active profile and
rewrites the command when `rtk` is on. No adapter surgery, no fork.

### Decisions

1. **Ordering is fixed by pi, and it is the right way round.** The `tool_call` gate
   returns `kind: "immediate"` before the loop reaches `kind: "prepared"`
   (`agent-loop.js:412-434`), and `prepare` runs inside the tool's `execute`. Therefore
   **the user approves the command the model actually asked for**, and rtk rewrites it
   afterwards.

   **The consequence must be documented, not left implicit**: what the user approved is
   not literally what runs. That is defensible *only because rtk is meant to be
   semantically transparent* — same command, filtered output. **If rtk ever changes
   behaviour rather than only output, this ordering hides it**, and that is the condition
   under which this decision should be revisited.
2. **When rtk is absent or fails, run the raw command — and say so once.** rtk is an
   external binary that may not be installed, may be the wrong `rtk` (the dev's own notes
   record a name collision with an unrelated project of the same name), or may error.
   Silently falling back forever means the token savings quietly stop and nobody notices;
   refusing outright makes an optional optimisation into a hard dependency. Surface the
   fallback once per session through the `error` kind from
   [the event contract](05-event-contract.md), then proceed quietly.
3. **Only rewrite commands rtk actually handles.** rtk's value is dropping detail, and a
   harness that drops detail the agent needed produces a worse turn *invisibly* — it
   looks like the model being dumb. Commands rtk does not know pass through untouched,
   which is also what makes the boolean safe: "on" cannot silently degrade an arbitrary
   command.
4. **Not a security control.** rtk rewriting is an optimisation applied after the gate.
   It must not be relied on to constrain anything —
   [the permission gate](03-permission-gate.md) and Rust's containment are the only
   things that stop a command.
5. **Moot in dev mode.** `exec` returns `shell_unavailable` under `npm run dev`
   ([browser mode](10-browser-mode-env.md)), so `prepare` never reaches a real shell
   there. The profile field still round-trips, so profile handling is exercised.

### Verification

`rtk gain` reports cumulative savings, and is the obvious way to check this is doing
anything at all. Whether the ADE surfaces it is a UI question and not decided here — but
one honest caveat belongs on the record: rtk's savings figures were designed with a human
reader in mind, and a coding agent is a different consumer. That the numbers go down is
not by itself evidence the turns got better.
