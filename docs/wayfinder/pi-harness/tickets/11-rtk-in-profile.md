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

---

## Amendment 2 — the source read, and the value question opened

**Status: still deferred.** What changed is that the cost question is now answered with
measurements, and a **value** question opened that neither the resolution nor Amendment 1
saw. The full research note is
[RESEARCH-rtk-filter-engine.md](../RESEARCH-rtk-filter-engine.md); this section is the
part that decides the ticket.

Amendment 1 said "all checked against the installed binary and the published
repository", and it had never located the code that applies the filters. That gap is
closed. The repository was cloned and read.

### Corrections to Amendment 1

- **63 TOML filter files, not 97.** 261 KB on disk, not "~100 KB".
- **The pipeline has nine stages, not eight.** `head_lines` exists and is not in the
  README, and there is an `unless` guard as well.
- The rest of Amendment 1 stands: no `[lib]` target, not on crates.io, binary-only.

### The engine, located and measured

One file: **`src/core/toml_filter.rs`, 1,968 lines** — 804 production and 1,164 tests.
The stages are 164 of those lines, at `:484-647`.

- **The transform is pure.** `apply_filter(&CompiledFilter, &str) -> String`. No process
  spawning, no stdout handles, no terminal detection. The global filter registry is
  optional; `find_filter_in` takes a slice.
- **It drags in almost nothing.** No config loader and no telemetry hook sit on the
  transform path.
- **Zero new crates.** It needs `regex`, `serde` and `toml`, and all three are already in
  our `Cargo.lock`.
- **The filters are compiled in**, through `include_str!` of a blob that `build.rs`
  concatenates. Vendoring the data is a file copy plus about 50 lines of build script, or
  one pre-concatenated file and no script at all.
- **The schema is frozen and the engine is not.** `TomlFilterDef` is identical at v0.36.0,
  v0.40.0 and v0.44.2. The engine moved 1,697 → 1,968 lines (+330/−59) in about two
  months, at roughly one release per week.

### The telemetry worry is cleared

Amendment 1 flagged this as unverified and load-bearing. `[tracking]` is a **local SQLite
database only**. `[telemetry]` defaults to off and needs both an opt-in consent and a
compile-time `RTK_TELEMETRY_URL`. None of it appears in the engine, the build script or
the filter data.

### A sixth route, which Amendment 1 did not list

**F — vendor the engine's Rust source into `src-tauri`.** Amendment 1 ruled out C as a
*Cargo dependency* and never priced copying the source, which needs no lib target at all.

Priced against E:

| Route | Lines |
|---|---|
| **E** — vendor the 63 TOML files, write our own engine | **385–430 written** |
| **F** — vendor the engine source, cut the tail | **510 copied + 60 written, ~290 cut** |
| **C'** — fork and add a `lib.rs` | compiles all 20 crates, including bundled SQLite |

**E over F**, and the margin is thin enough that it breaks on what we own afterwards
rather than on the diff. **E vendors the frozen contract; F vendors the moving code.** F
also brings Apache-2.0 §4(b) modified-file marking. C' stays ruled out.

### The value question, which is now the blocker

`RUST_HANDLED_COMMANDS` in `toml_filter.rs:250` holds **49 command names**, and a TOML
filter can never fire for any of them. The list includes:

> `git`, `cargo`, `npm`, `npx`, `pnpm`, `docker`, `kubectl`, `tsc`, `grep`, `find`, `ls`,
> `curl`, `wget`, `pytest`, `mypy`, `pip`, `go`, `gh`, `aws`, `psql`, `diff`, `log`

Those are handled by the `cmds/` half, which does not travel — see below. **What E
actually buys is the other 63 names**: `gradle`, `terraform-plan`, `helm`, `rsync`,
`make`, `gcc`, `jq`, `ssh`, `systemctl-status`, `pre-commit`, `shellcheck`, `biome`,
`oxlint`, `turbo`, `nx`, `poetry-install`, `uv-sync`, `xcodebuild` and similar.

For **this** repository the overlap is close to nothing. It is a Tauri, React and Rust
project, so its commands are `cargo`, `npm` and `tsc` — all three Rust-handled.

**So route E is cheap, safe, and aimed at commands this project does not run.** Nothing
should be written until something measures what our own turns actually spend tokens on.

### Why the `cmds/` half does not travel

The repository is about 84,000 lines of Rust in eight modules. Line counts include tests.

| Module | Files | Lines | What it is |
|---|---|---|---|
| `cmds/` | 76 | 43,903 | The tuned per-tool wrappers, in 12 language subdirectories |
| `hooks/` | 11 | 13,374 | The Claude Code hook integration |
| `core/` | 16 | 9,400 | Runner, stream, guard, truncate, tracking, and the filter engine |
| `discover/` | 6 | 9,289 | `rtk discover`, which reads Claude Code history |
| `main.rs` | 1 | 3,621 | The CLI |
| `analytics/` | 5 | 2,759 | `rtk gain` |
| `learn/` | 3 | 942 | |
| `parser/` | 3 | 711 | |
| `filters/` | 0 `.rs` | — | 63 TOML files |

More than half of it is surface we would never want: the hook integration, the history
scanner, `rtk gain`, and the CLI.

Three reasons `cmds/` cannot be taken. Dependency weight is the third and the smallest.

1. **Size.** `src/cmds/git/` is 7,864 lines across five files, and `git.rs` alone is
   3,325 with no `#[cfg(test)]` block — all production. **Our whole Rust backend is 2,314
   lines.** Taking git handling alone makes `src-tauri` about 2.4× its current size, and
   git is one family of twelve.
2. **It spawns the process itself, and this is the real objection.** `git.rs` imports
   `std::process::Command` and `Stdio` and has six spawn sites. That is the design — the
   `cmds/` half re-invokes the tool with tuned arguments, which is why `rtk git status`
   returns *different* text rather than filtered text. The problem is not that Rust
   spawns things; ours already does. It is that this is a **second** spawning path that
   knows nothing about the first. [Ticket 02](02-exec-not-terminal.md) built root
   confinement, Channel streaming, process-tree abort and the overflow file into our
   `exec`, and `cmds/` bypasses all four. Rewriting it onto our runner is not reuse.
3. **The drag is deeper than the filter engine's.** `git.rs` imports seven `core`
   modules: `args_utils`, `guard`, `runner`, `stream`, `tracking`, `truncate` and
   `utils`. `core` is 9,400 lines, and `tracking` is the SQLite analytics. The filter
   engine is clean because it sits outside that path; `cmds/` sits inside it.

The 20 dependencies — including `rusqlite` with `bundled`, which compiles SQLite from
source, plus `ureq`, `clap`, `colored`, `quick-xml` and `flate2` — are why C' is ruled
out. They are a consequence of taking the whole binary, not the reason `cmds/` is
unusable.

**The summary that matters:** the filter engine is takeable because it is pure, small and
outside `core`'s web. `cmds/` is none of those. It is not a library that shipped as a
binary — it is a CLI, and its value is in the process invocation, which is the one thing
that cannot be imported.


---

## Amendment 3 — the per-command read, and the seam that got built

**Status: the seam is built; rtk itself is still deferred, and now for a smaller
reason.** Amendment 2 closed the cost question and opened a value question. This
amendment answers the value question one level down — per command, with the source
in front of it — and the answer moved. The full note is
[RESEARCH-rtk-crop-logic.md](../RESEARCH-rtk-crop-logic.md), read against **v0.44.2,
commit `700bdde3`**.

### Corrections to Amendment 2

Amendment 2 corrected Amendment 1 on three counts and was itself wrong on three.

- **The pipeline has eight stages, not nine.** Upstream's own doc comment at
  `toml_filter.rs:486-493` numbers eight, and the `// N.` markers in the body agree.
  `head_lines` is an undocumented *branch* inside stage 6, not a stage. `filter_stderr`
  is a real ninth step, but it runs in the **caller**, before stage 1 — which is a
  different claim and a more useful one.
- **The filter data is 73,240 bytes, not 261 KB.** 2,402 lines across the 63 files, with
  154 tests. Amendment 2's figure was off by 3.5×.
- **`RUST_HANDLED_COMMANDS` is not the routing table — Clap is.** 49 names against **78
  Clap subcommands**. It omits `gradlew`, `mvn`, `dotnet`, `uv`, `rspec` and `rubocop`,
  so its shadow warning has false negatives, and **five shipped TOML filters are dead on
  rtk's own hook path** (`gradle`, `dotnet-build`, `biome`, `yadm`, `uv-sync`). `uv sync`
  is worse than dead: `uv_cmd.rs:63-67` passes it through unfiltered.

The rest of Amendment 2 stands, including the finding that decides the ticket.

### The (a)/(b) split was too coarse. It is four classes.

Amendment 2 reasoned with two: a post-filter we can take, and a re-invocation we cannot.
The middle is where the answer was hiding.

| | | |
|---|---|---|
| **(a)** same argv, drop lines only | 5 commands | directly extractable |
| **(a′)** same argv, bespoke Rust renderer | ~34 | the noise-dropping half is extractable; the formatting is not |
| **(b)** different argv, then a parser | ~27 | not extractable, and it reintroduces the approval mismatch |
| **(c)** rtk never spawns the tool | 5 | `rtk find` walks the tree with the `ignore` crate |

**All 63 TOML filters are class (a) structurally, not by convention.** `main.rs:1321-1338`
spawns `resolved_command(argv[0]).args(argv[1..])` — the user's exact argv — and hands
the captured string to `apply_filter`. The schema has no field that can add an argument.
That is a stronger guarantee than upstream's stated rule, because it is enforced by the
type rather than by discipline.

### What this changes for us

Amendment 2's model was: the value lives in `cmds/`, `cmds/` cannot travel, so nothing is
worth building. That model breaks, because **three of our four commands are
argv-preserving**.

| Our command | Class | argv changed | What we would write |
|---|---|---|---|
| `npm run …` | **(a)** | no | 4 regexes and an `on_empty`. Six lines. |
| `cargo build/check/test/clippy` | **(a′)** | no | ~15 skip-regexes get most of it; grouping is extra |
| `tsc` | **(a′)** | no | ~2 skip-regexes; the error-count summary is extra |
| `git status/log/diff` | **(b)** | **yes** | not extractable |

`cargo` is the surprise. It **injects nothing** (`rust/cargo_cmd.rs:267-273`) and declines
to force `--message-format=json` on purpose (`:377-380`).

Measured on this repository against the v0.43.0 binary: `git status` goes 437 → 101 bytes,
**77%**. Roughly 43 of those points are reachable by a pure post-filter; the other ~34
need the porcelain reformat — and buying them means the user approves one command while
another runs, which is the thing route E existed to delete.

### A sixth route, which Amendment 2 did not list

> **G — take route E's engine, ship almost none of upstream's 63 filters, and write our
> own for the commands we actually run.**

Cheaper than E and aimed at our own commands rather than at `gradle` and `xcodebuild`. It
carries **no Apache-2.0 obligation at all** when the filters are ours, since the licence
attaches to copied expression and a list of regexes for `cargo`'s output is not upstream's
expression. And it keeps E's structural win intact: the filter runs after the command, so
the user approves exactly what runs.

**What G cannot buy:** `git status`'s extra 34 points, `cargo clippy`'s lint grouping,
`tsc`'s error-count summary. Each needs a parser, and a parser is per-tool work whether it
is copied or written.

### The seam is built. The filters are not.

`src/agent/crop.ts` and its check. A pure `crop(command, text)` in the exec adapter,
called at [`env.ts`]'s `exec` return — after `onStdout` has streamed the raw bytes to the
UI, and before pi's 2000-line / 50 KB cap. Semantic first, positional second.

Three rules, and the last two are lifted from rtk because rtk needed them for the same
reason:

1. **A command with no rule is untouched.** Matching is opt-in, so `cat` and `git diff`
   pass through byte for byte.
2. **Never worse** — `core/guard.rs:6-12`. A crop that grew its input is discarded.
3. **It says what it dropped**, in the same place `[output truncated at 8 MiB]` is said.

It ships with **one rule, `npm`**, transcribed from `js/npm_cmd.rs:136-168` rather than
invented, because that one is proven and free. `cargo` and `tsc` are deliberately absent:
their noise is extractable, but the share of their output that is noise has never been
measured here, and a skip-list written on a guess is how a crop starts eating the errors
it was meant to surface.

### The blocker, restated and smaller

Upstream's `savings_pct` values are **hard-coded constants in `src/discover/rules.rs`**,
not measurements — `rules.rs:9-11`, defaulting to 60.0 at `:26`. Their own README hedges
the headline (`README.md:60`). So both this ticket's amendments have been reasoning about
rtk's estimates rather than about our spend.

**That is what the seam now fixes.** Every crop writes its lines and bytes where a person
can read them. The next rule is a number, not an argument — and rtk stays deferred until
there is one.

**`rtk: boolean` on the profile remains inert**, and is now doubly so: the crop applies to
every profile, because a four-regex npm filter is not a thing worth a policy dial. If the
field ever means anything, it will mean route G's engine rather than the binary.
