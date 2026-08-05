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

---

## Amendment — how rtk is obtained, and where it applies

**Status: deferred.** The field shape above (`rtk: boolean`) is unaffected and stands.
What is reopened is the *mechanism* — the resolution assumed an rtk binary on `PATH` and
a `prepare` hook rewriting the command, and the findings below make that one option of
five rather than the obvious one. Nothing is built. This section is the record so the
choice is made on facts rather than on recall.

### Findings, verified rather than remembered

All checked against the installed binary and the published repository:

- **The project is `github.com/rtk-ai/rtk`**, v0.44.2, **Apache-2.0**, homepage
  `rtk-ai.app`. The copy on this machine is `~/.local/bin/rtk.exe`, v0.43.0, 8.5 MB —
  a downloaded release binary, not a `cargo install`.
- **The crates.io name is taken by a different project.** `crates.io/crates/rtk` is
  "The CLI for Rust Type Kit", v0.1.0, `reachingforthejack/rtk`. The collision the dev's
  own notes warn about is real and occupies the name; rtk-ai's rtk **is not on crates.io
  at all**.
- **It is binary-only.** `Cargo.toml` has no `[lib]`, there is no `src/lib.rs`, and
  `src/main.rs` is 122 KB. **Cargo cannot depend on it** — a git dependency resolves a
  library target and there is none. Calling its functions requires a fork that adds a lib
  target and widens module visibility, against an unversioned internal API on a project
  that shipped 0.27 → 0.44 inside one afternoon of reading it.
- **Distribution** is Homebrew, an `install.sh`, `cargo install --git`, and per-platform
  GitHub release binaries (macOS x86_64/aarch64, Linux x86_64/aarch64, Windows). No npm,
  scoop or winget.
- **It splits into two halves that are nothing alike**, and this is the load-bearing
  finding:
  - **`src/cmds/`** — Rust, twelve language-specific subdirectories. This half **spawns
    the underlying tool itself with tuned arguments and reformats the result**.
  - **`src/filters/`** — **97 TOML files, no Rust.** Declarative rules applied to
    *already-captured* stdout/stderr through a documented 8-stage pipeline:
    `strip_ansi → replace → match_output → strip/keep_lines → truncate → tail_lines →
    max_lines → on_empty`. Upstream's stated rule for this half is that filters strip
    noise and **do not reformat** — "the filtered result must still look like real
    command output."
- **Measured, not assumed:** `rtk git status` returns `* master` / `clean — nothing to
  commit` where raw git returns `On branch master` / `nothing to commit, working tree
  clean`. That is a *different invocation* (porcelain, near-certainly) plus a renderer —
  so **rtk's value is not a post-filter over output we already have**. By contrast
  `rtk git log --oneline -3` is byte-identical to raw. The savings are unevenly
  distributed across the two halves.
- **Weight:** 8.5 MB on disk, **3.9 MB gzipped** — against **3.1 MB gzipped** for this
  app's entire frontend, Monaco and pi and every provider included. Bundling rtk adds
  more compressed weight than everything currently shipped in the WebView.
- **Unverified and load-bearing if we ever redistribute it:** the binary references
  `docs/TELEMETRY.md` and its default config carries `[tracking] enabled = true,
  history_days = 90`. That is *probably* the local history behind `rtk gain`, but
  "probably" is not good enough to ship inside someone else's installer. Read it first.

### The five viable routes

Each is stated with what it costs, because none is free:

1. **A — call whatever `rtk` is on `PATH`.** The original resolution. Zero weight, zero
   packaging, works today on this machine. Costs: PATH roulette, the crates.io name
   collision is a live hazard for anyone who installed the wrong one, and the
   approval-mismatch caveat above stays load-bearing.
2. **B — bundle the release binary as a Tauri `externalBin` sidecar.** Kills "absent",
   pins the exact version, ships inside a signed installer. Costs: **+3.9 MB compressed
   for every user including those who never enable it**, per-platform artifacts in the
   release pipeline, Apache-2.0 attribution alongside pi's MIT, and the telemetry
   question above becomes mandatory reading. Does *not* fix the approval mismatch.
3. **C — depend on it as a library.** **Not available.** No lib target, not on crates.io.
   This is a fork with a `lib.rs` and widened visibility, maintained against an
   unversioned internal API. Listed because it was asked for and because ruling it out
   needed the evidence above, not because it is viable.
4. **D — fetch on first enable.** Rust downloads the pinned release asset into the app
   data directory when a profile first turns `rtk` on, verifies a recorded SHA-256, and
   caches it. Keeps B's version pinning with none of the installer weight; only users who
   opt in pay, and in disk rather than download. Costs: **the app downloads and executes
   a third-party binary at runtime**, which is a larger security-design question than the
   weight it saves and deserves its own grilling.
5. **E — vendor the filter *data*, implement the pipeline ourselves.** Take the 97 TOML
   files at a pinned tag under Apache-2.0 with attribution, and implement the eight
   documented stages in `src-tauri` over the output our own `exec` already captures.
   **~100 KB rather than 8.5 MB**, no sidecar, no download, no fork, no internal API —
   TOML is a stable data contract and a new upstream filter is a file copy.
   **Rust keeps sole process authority**, so ticket 02's confinement, Channel streaming,
   process-tree abort and overflow file all continue to apply. And it **deletes decisions
   1 and 2 of the resolution above** rather than amending them: nothing is rewritten, so
   the user approves the exact command that runs, and there is no external binary that
   can be absent. Costs: **the `cmds/` half does not come with it** — the tuned git,
   cargo and npm invocations are where a large share of the headline savings live — and
   we own an engine, small as it is, that must keep matching upstream's semantics.

### What this changes structurally

A and B and D apply rtk **before** the command runs, in `prepare`, which is why the
resolution had to document that what the user approved is not literally what runs. E
applies it **after**, in the exec adapter, where the question cannot arise. That is a
different seam, not a different setting, which is why this is deferred rather than
decided in passing.

They are also not exclusive. E now and B or D later for the `cmds/` half is a coherent
sequence, and E is the only one of the five that can be built without first settling a
distribution or a security question.

