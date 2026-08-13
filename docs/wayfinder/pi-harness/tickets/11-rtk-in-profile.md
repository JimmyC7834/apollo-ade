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

## Amendment 4 — the seam ran, and the number was 0.3%

Amendment 3 shipped the crop and did not run it. Running it changes what this
ticket is about.

**Measured on this repo, real captured stdout:**

| | `npm run build` | `npm run check` |
|---|---|---|
| rtk's npm rule alone | 13,323 → 13,286 (**0.3%**) | 1,399 → 1,362 (**2.6%**) |
| with the escape strip | 13,323 → 8,203 (**38.4%**) | — |

The transcribed rule is mechanically correct — it drops the `> pkg@1.0.0 build`
banner and blanks, keeps the echoed command line, announces itself, and the
never-worse guard never has to fire. It is simply almost worthless here:

1. `npm WARN` does not match npm 10's lowercase `npm warn`, and those go to
   **stderr**, which `env.ts` does not crop. Dead twice over.
2. 8,040 of 13,323 bytes are vite's 102-line asset table — real output the rule
   correctly keeps. Whether a model needs 102 chunk sizes is a question nobody
   has asked yet, and it is a rule, not a bug.
3. **5,083 bytes, 38.2%, were ANSI escapes.** `exec.rs` pipes stdout and sets no
   `NO_COLOR`; vite colours anyway.

**This moves route G's centre of gravity.** The research read 1,042 lines of rtk
and found ~34 argv-preserving commands whose line-dropping is extractable. That
is still true and still the route. But the first thing built from it returned
0.3%, and one stage rtk does not have at all returned 38.4% — so the next rule
should be chosen by measuring our own output, not by porting the next filter.
The `console.debug` in the call site is what makes that possible, and it is now
the most valuable line in the seam.

`rtk: boolean` remains inert, and nothing here changes that.

---

## Amendment 5 — reopened. The yardstick was wrong, and it changes the route

**Reopened at the dev's direction.** Everything below Amendment 4 was argued
against the wrong measuring stick, and he said so plainly: *"we want that feature
for an ADE, not for my project."*

Amendment 4 and the research note both scored rtk by what it does for **this
repository** — a Tauri/React/Rust tree running `cargo`, `npm`, `tsc`, `git`,
`vite`. Against that, zero of the 63 TOML filters fire and the one transcribed
rule returned 0.3%, so the conclusion was *measure our own output before porting
another filter*. That reasoning is sound and it answers a question nobody asked.
**An ADE opens whatever the user opens.** The filters that do not fire here are
`ansible-playbook`, `basedpyright`, `biome`, `brew`, `bundle`, `composer`,
`dotnet build`, `df`, `du` — every one of them a command someone's project runs.
Scoring a general-purpose editor's feature against one repository is the same
error as tuning a language server for the file that happens to be open.

### The finding that decides the route: reimplementation has a ceiling, and it is low

rtk's surface is roughly **141 command handlers** — 63 TOML filters plus 78
Rust-routed commands. Splitting them by what can actually be ported:

| | Count | Portable? |
|---|---|---|
| 63 TOML filters — all class (a), pure post-filters | 63 | Yes, mechanically |
| (a) Rust-routed, drop/truncate only | 5 | Yes, expressible as TOML today |
| (a′) Rust-routed, bespoke renderer — groups, counts, summarises | ~34 | Only by copying each parser |
| (b) Different argv — injected flags, forced JSON, side-files | ~27 | No — see the mismatch below |
| (c) rtk never spawns the tool; reimplemented in Rust | 5 | No |

So **route E/G tops out near 68 of 141, about 48%** — and the excluded 27 are
where the headline percentages live (`--porcelain`, `--format json`,
`--reporter=json`, and for `dotnet` an MSBuild binary log plus a `.trx` file
written to disk and parsed back).

**And "adding the rules" understates the work, because there is no engine to add
them to.** `src/agent/crop.ts` implements **three** of the eight documented
stages — `strip_ansi`, `strip_lines`, `on_empty`. What the filters actually
lean on is missing: **`max_lines` appears in 54 of the 63**,
`truncate_lines_at` in 22, `match_output` in 11, plus `tail_lines`,
`keep_lines_matching`, `unless`, `replace`, `head_lines`, and the caller-side
`filter_stderr` pre-stage. Rules without the engine do nothing at all.

**Therefore: if the whole feature is the goal, shipping rtk beats reimplementing
it.** Reimplementation asymptotes below half at a cost that keeps climbing;
the binary is 100% on day one and stays current with upstream for free. That
inverts Amendment 2's preference for route E, and it inverts it on the goal
rather than on any new fact about rtk.

### Weight and platforms — the question the dev asked, answered

- **Per-platform GitHub release binaries: five targets** — macOS x86_64 and
  aarch64, Linux x86_64 and aarch64, Windows. No npm, scoop or winget.
- **You do not pay 5×.** A Tauri `externalBin` sidecar resolves per
  target-triple, so each installer carries **one** binary. A Windows user
  downloads **+3.9 MB compressed**, not 19.5 MB. The 5× is paid in CI artifacts
  and release storage, where it costs nothing anyone notices.
- Measured on this machine: **8.9 MB on disk** (v0.43.0 at `~/.local/bin/rtk`),
  3.9 MB gzipped — against **3.1 MB gzipped** for this app's entire frontend,
  Monaco and pi and every provider included. It is still the single heaviest
  thing that would be in the bundle, and that is a fact about rtk rather than an
  argument against it.

### The enabling decision, which is the real question in this ticket

Class (b) is not blocked by effort. It is blocked by **the approval mismatch**:
rtk rewrites the command, so the user approves `git status` while
`git status --porcelain -b` runs. Three honest answers, and this is what a grill
should settle:

1. **Gate on the rewritten argv.** Resolve the rewrite *first*, then gate, and
   show the user the command that will actually run. The mismatch disappears
   rather than being tolerated, and it costs an ordering change in `gate.ts`.
   **This is the recommendation.**
2. **Keep rtk, disable class (b) under `careful`.** Preserves the full feature on
   `auto` — which is the only policy the dev runs — and degrades to class (a) when
   someone is watching each call. Cheap, and slightly two-faced.
3. **Accept it.** The rewrite is a read-only reformulation by a trusted tool.
   Defensible, and it makes the gate's promise weaker than its wording.

Note that (1) is worth doing **whatever route is chosen**: it is the thing that
makes a rewriting filter honest, and without it route E's class-(b) half is
permanently unreachable too.

### Still open, and each blocks shipping rather than deciding

- ~~**Telemetry.**~~ **Struck — this was already answered and Amendment 5 re-raised
  it by reading Amendment 1 without its correction.** *The telemetry worry is
  cleared* above settled it, and Amendment 6's research re-confirmed it
  independently against upstream's own `docs/TELEMETRY.md` and this machine's
  `config.toml`. It blocks nothing.
- **Licence.** Apache-2.0 attribution alongside pi's MIT, for the binary or for
  the vendored filter data alike.
- **The crates.io name collision** stays a live hazard for route A: `rtk` there
  is an unrelated project, so a PATH lookup can find the wrong binary. Route A
  needs a `rtk gain` probe to confirm identity, not just a `which`.

### What Amendment 4 still gets right, and keeps

The escape strip stays regardless of route. **5,083 of 13,323 bytes — 38.2% — of
`npm run build`'s stdout were ANSI escapes**, and rtk has no such stage because
it re-runs most tools and formats the result itself, while we hand the tool's own
bytes to a model that pays for every one. That stage is ours, it pays more than
any ported rule measured so far, and it is free.

`rtk: boolean` remains inert until this is settled.

---

## Amendment 6 — decided: route D, on these terms

**Settled in a grill, with the facts researched rather than assumed.** The route
is **D — fetch the pinned release on first need**. Not built yet; every decision
below is the dev's, and the open question this ticket has carried since
Amendment 1 is closed.

### The design, end to end

**Acquisition.** `rtk: true` on the active profile and nothing usable on `PATH`
→ the app downloads the pinned release asset, verifies a **SHA-256 hardcoded in
our source beside the version**, and caches it under the app data directory.
**No confirmation dialog** — the dev weighed the "this app has never reached the
network for executable code" objection and judged the weight trivial against a
feature the user opted into by name.

**The digest is ours, not upstream's.** `checksums.txt` is published per release
(plain `sha256sum`) and is **deliberately not fetched**: it is served from the
same origin, over the same connection, from the same account as the asset, so
anything able to substitute the binary can substitute the digest beside it. It
detects the corruption HTTPS already detects and nothing more. We record the hash
at the moment we choose the version, having looked at it. With **no upstream
signatures of any kind** — no GPG, minisign or cosign anywhere in their release
workflow — that recorded hash is the only trust anchor available, which is
exactly why it must not arrive in the same fetch.

**The pin is a version we bump**, surfaced in the profile modal so staleness is
visible rather than silent. Upstream cut **47 stable releases in six months**
(v0.19.0 → v0.45.0), plus hundreds of `dev-*-rc` prereleases, so a pin is
permanently a little behind. That is the price of being able to say what the app
will execute: resolving `latest` at fetch time makes a pinned digest impossible
by construction, since you cannot hash an artifact that does not exist yet.

**PATH wins when it is there**, confirmed by running **`rtk gain`** rather than
`which` — the crates.io `rtk` is an unrelated project (Rust Type Kit) and finding
it is a live hazard no path lookup can detect. The resolved version is recorded
in the session so a bug report names the binary that answered. A dev tool that
ignores the dev's own installed toolchain is the wrong instinct.

**Extraction is Rust** — `zip` on Windows, `flate2` + `tar` elsewhere, since
upstream ships archives rather than bare binaries. **The archive's digest is
verified before anything is unpacked**, never the extracted binary afterwards:
an attacker-controlled archive is a zip-slip the moment it is opened. Shelling
out to `tar` or `Expand-Archive` is refused on this app's standing rule that Rust
owns process spawning deliberately — and unpacking is the one step that runs
before verification has finished mattering.

**Timing.** The fetch **blocks the tool call that triggered it**, with a timeout,
after which the command runs unfiltered and says so. The model has no clock, a
tool call taking a second longer is invisible, and there is no partial state to
reason about. The same code fires **eagerly at app open and on profile switch**,
so the blocking path is the correctness and almost never the experience.

### The pipeline, one ordering, no exceptions

```
resolve → rtk rewrites → deny list → gate → run → stripControl
```

**This ordering is the decision that makes route D worth 100% rather than ~48%.**
rtk's class (b) — 27 commands — replaces the command: `git status` becomes
`git status --porcelain -b`. Gating on what the model asked for would leave the
approval card describing something other than what runs, and would put the
rewrite *after* the deny list that screens resolved argv, reopening the hole the
argv-not-shell-string fix closed. Rewriting first means there is exactly one argv
in the system and everything reasons about the same bytes.

**Scope: every command the agent runs** — `bash` and user-authored tools alike.
**Never the integrated terminal**: a human reads that, a human can alias it, and
the saving this feature exists for is tokens.

**Failure is visible, never silent.** rtk unavailable — offline, proxied, timed
out, no asset for the platform — and the command runs raw while the transcript
says why, the same shape as the LSP `missing` state. This matters more here than
elsewhere: rtk's whole job is to make output shorter, so "rtk silently did
nothing" and "rtk worked" look identical to a reader and differ only in the bill.
**A digest mismatch is not a degradation, it is a refusal** — bytes that do not
match the pin never execute.

**The child is held to the same rules as every other child this app starts:**
`CREDENTIAL_VARS` stripped, adopted into the `Reaper`.

### `crop.ts` loses its rules and keeps its strip

**The rule table goes.** One transcribed npm filter worth **0.3%**, genuinely
redundant once rtk is running, and a hand-maintained filter set drifting against
upstream is the thing Amendment 4 warned about. `RULES`, `ruleFor`, `CropRule`,
the never-worse guard and `crop.check.ts`'s rule cases — roughly 80 lines and one
concept deleted.

**`stripControl` stays**, running *after* rtk on whatever came back. rtk's
`strip_ansi` lives inside per-command TOML filters — 58 of the 63 carry it — but
**zero of the 63 fire on `cargo`, `npm`, `tsc`, `git`, `vite`, `rustc`, `clippy`
or `node`**, and npm's Rust module is four `continue`s with no ANSI handling. So
with rtk fully enabled and working, `npm run build` still hands the model its
escape bytes. Double-stripping is a no-op, so the composition is safe either way.

### The ANSI measurement, corrected — it is one tool, not a general rate

Amendment 4's single **38.2%** figure was quoted as though it characterised the
stage. It characterises **vite**. Measured on piped stdout — no TTY, exactly how
`exec.rs` captures it:

| command | bytes | escapes | share |
|---|---|---|---|
| `npm run build` | 13,323 | 5,083 | **38.2%** |
| `npx vite build` | 13,267 | 5,083 | **38.3%** |
| `npm run check` | 2,192 | 0 | 0.0% |
| `cargo test --lib` | 1,200 | 0 | 0.0% |
| `cargo build` | 0 | 0 | — |
| `npx tsc --noEmit` | 0 | 0 | — |
| `git status` | 55 | 0 | 0.0% |
| `git log --oneline -20` | 1,236 | 0 | 0.0% |

The two vite rows carrying **identical** escape counts is the giveaway: vite
colours even when its output is a pipe, and everything else detects the non-TTY
and emits nothing. So the honest case for the strip is **free, unconditional and
occasionally enormous** — not a headline rate. For an ADE that is still the right
shape of argument, because the tools that colour-when-piped are exactly the ones
nobody predicted. On a project that is all cargo and tsc it earns nothing, which
is acceptable for a stage costing one regex.

### Facts that fall out, and are not decisions

- **There is no ARM Windows asset.** Five targets ship: macOS x86_64 and aarch64,
  Linux x86_64 (musl) and aarch64 (gnu), Windows x86_64. An ADE on ARM Windows
  takes the "unavailable" path permanently. That is the degrade-visibly rule
  working rather than a defect, but it will be reported as one.
- **macOS argues *for* D, not against it.** Upstream ships **unsigned and
  unnotarized** macOS binaries — no `codesign`, no `notarytool` in their release
  workflow. Bundling one as a sidecar makes it *our* notarization problem, while
  a binary the app fetches never receives the `com.apple.quarantine` xattr, since
  that is set by browsers rather than by HTTP clients, so Gatekeeper's assessment
  never fires. **This reverses what Amendment 5 assumed.**
- **Licence.** Apache-2.0, notice preservation only, no UI attribution required.
  Whether a separate top-level `NOTICE` file exists upstream was not confirmed —
  check before shipping; it is a file copy either way.
- **`reqwest` with rustls is already in `Cargo.lock`**, so the download costs no
  new dependency. `sha2`, `zip`, `flate2` and `tar` are the additions.

### What this closes

`rtk: boolean` stops being inert once this is built. The question this ticket has
carried since Amendment 1 — *how rtk is obtained, and at which seam it applies* —
is answered: **fetched, pinned, verified against our own digest, applied to every
command the agent runs, ahead of the deny list and the gate.**

---

## Amendment 7 — built, and the one thing built differently

Route D shipped. What follows is what is in the tree, and it is worth reading
against Amendment 6 rather than instead of it: the design survived contact
almost intact, and the one place it did not is the load-bearing one.

### The seam is the `tool_call` hook, not `prepare`

**The resolution at the top of this ticket said `prepare`, and Amendment 6 said
the rewrite must precede the deny list. Both cannot be true.** `prepare` runs
inside the tool's `execute`, which is *after* `beforeToolCall` has already
returned — so a rewrite there is a rewrite the gate never saw, which is exactly
the ordering Amendment 6 reversed.

What makes the correct ordering available is a detail of pi's loop:
`prepareToolCall` validates the arguments once and passes **that object** to the
`tool_call` hook and then to `execute` (`agent-loop.js:405-435`), and
`emitHook` walks handlers in registration order keeping only the last
non-undefined result (`agent-harness.js:181-198`). So a hook registered *before*
the gate's can mutate `event.input.command` in place, return `undefined`, and
leave the gate to decide about the rewritten command. One argv, screened and
approved and run.

That is why `rewriteToolCall` is typed `Promise<undefined>` rather than
`Promise<void>`: anything it returned would displace the gate's decision on the
very call the gate was screening.

### What it refuses to rewrite, which the amendment did not cover

rtk takes a program and its arguments. A model writes **shell lines**, and
`rtk cd src && npm run build` runs `cd src` under rtk and then `npm run build`
bare, in the wrong directory. So `rtkCommand` returns `undefined` — leave it
alone — for any line containing `| & ; < > \` newline` or `$(`, and for a
leading `VAR=value` assignment, which is a shell feature and not a program.
Quoting is not parsed: an `&&` inside a quoted string costs that line its
rewrite and nothing else. **Both errors fall towards running what the model
wrote**, which is the safe direction.

This is a real ceiling on the feature and it should be stated rather than
discovered: compound lines are common in agent output, and every one of them
goes unfiltered. The alternative is a shell parser, which is a much larger thing
than this ticket.

### The rest, as specified

- **Acquisition** (`src-tauri/src/rtk.rs`): `rtk gain` on `PATH` first; else the
  cached binary under app data, versioned; else download the pinned asset,
  verify the digest **before** unpacking, extract by matching the entry's *file
  name* and writing to a path we chose, stage-then-rename. `rtk_resolve` never
  fails — unavailable is an answer, and the command runs unfiltered.
- **The digests are real and were looked at.** The Windows asset was downloaded
  and hashed independently of `checksums.txt`; the two agree. The other four
  come from that file, recorded at pin time, which is the "different road" the
  amendment asked for.
- **Prefetch at three sites**: app open when the active profile has it on, on
  profile switch, and when the modal row is ticked. `resolveRtk` memoises the
  *promise*, so the eager path and a racing tool call share one download.
  **Failures are memoised too** — a machine offline now is offline in ten
  seconds, and retrying on every switch turns one readable failure into a
  stutter. Restarting is the retry.
- **User tools** take the same rewrite as argv, before `destructive()` reads it.
  Nothing is joined or quoted there, so none of the shell caveats above apply.
- **The notice is the parent's.** A subagent gets the rewrite and passes no
  `warn`: the message is once per app run, and a child would spend it on a
  transcript nobody is reading.
- **`crop.ts` is 74 lines**, down from 183: `RULES`, `ruleFor`, `CropRule`,
  `crop` and the never-worse guard are gone, `stripControl` and a byte-counting
  note remain. `crop.check.ts` lost the rule cases with them.
- **The profile modal** grew an *Output* fieldset carrying the toggle and the
  version that answered — `0.43.0 from your PATH` on this machine, which is not
  the pin, and saying so is the point.

### Two facts, corrected and confirmed

- **The licence obligation is lighter than Amendment 6 assumed.** Apache-2.0's
  notice and attribution clauses attach to *redistribution*, and route D
  redistributes nothing: the user's machine fetches the binary from upstream. No
  `NOTICE` copy is owed. Bundling would have owed one, which is one more small
  argument for the route already chosen.
- **`zip` is Windows-only and `flate2`/`tar` are everywhere-else**, as target
  dependencies rather than unconditional ones — upstream's archive format splits
  exactly on that line, so neither needs to exist on the other side.

### Amendment 7, addendum — what the review and the window found

Three things changed after the first pass, and one measurement is worth keeping.

**The probe children were not held to the app's own rules.** `probe` spawned rtk
twice with the full inherited environment, no `Reaper`, and no timeout — while
`exec.rs` does all three for every other child. The environment one is a real
leak (`CREDENTIAL_VARS` reaches a binary we did not write), and the missing
timeout is worse than it looks: acquisition **blocks the tool call that
triggered it**, so a binary that hangs blocks that call forever. Now: stripped,
adopted, and killed after ten seconds. `gain`'s stdout goes to `null` rather
than a pipe, because an un-drained pipe fills at 64 KB and `rtk gain` prints a
table.

**The digest table is now a table.** It was a `match` on the running platform,
so the test that claimed to catch a mistyped digest only ever examined one of
the five. It walks all five now, and also asserts no two rows share a digest —
a copy-paste that did would hand one platform another's binary, and the check
would agree.

**The licence obligation is lighter than Amendment 6 assumed.** Apache-2.0's
notice and attribution clauses attach to *redistribution*, and route D
redistributes nothing — the user's machine fetches from upstream. No `NOTICE`
copy is owed. Bundling would have owed one.

**Measured in the native window, repo as the root:** `rtk_resolve` answers
`{ source: "path", version: "rtk 0.43.0" }` — not the pin, which is exactly why
the resolved version is reported rather than assumed. `git status` through
`agent_exec` came back **1,089 bytes raw against 541 through rtk**, in porcelain
form. That is a class (b) rewrite: rtk ran a *different command* and rendered the
result, which is the class `crop.ts` could never reach and the whole argument for
fetching the binary instead of reimplementing its filters. `cargo --version` is
36 bytes either way, so pass-through leaves an unknown command alone.

**And the fetch is proven too**, by a test rather than by the app:
`fetches_and_unpacks_the_pinned_asset` is `#[ignore]`d because it uses the
network, and run deliberately it downloads v0.45.0, matches the recorded digest,
unpacks the zip and confirms the extracted binary answers `gain` as v0.45.0.
A path that only ever runs on a stranger's machine is a path nobody has run.

## Amendment 8 — the compound ceiling, mostly lifted

Amendment 7 recorded "compound lines are refused" as a real ceiling. It was two
refusals wearing one coat, and only one of them had a reason.

`rtkCommand` now scans the line once, quote-aware, splits it at top-level `&&`,
`||` and `;`, and decides each segment independently:

```
cd src && npm run build   →   cd src && rtk npm run build
cargo fmt && ls | head    →   rtk cargo fmt && ls | head
git commit -m "a && b"    →   rtk git commit -m "a && b"
```

The refusals that remain are the ones with reasons behind them. A **pipeline or
redirection** segment is left bare because rtk reformats what it captures, so a
downstream `head` or `> file` would consume rtk's rendering instead of the
command's — semantic, not syntactic, and permanent. Anything that **nests or
spans lines** returns "do not touch the line": `$( )`, backticks, a subshell, a
newline, an unbalanced quote. That is where a 40-line scanner stops being honest
about what it is reading, and a shell parser is still a much larger thing than
this ticket.

**One latent bug came out of it.** `rtk cd src` asks rtk to spawn a binary called
`cd`, and `cd` is a shell builtin. The original code produced exactly that for a
bare `cd src`, and on a chain it would have taken every following command down
with it. A short `BUILTINS` set now leaves those segments alone.
