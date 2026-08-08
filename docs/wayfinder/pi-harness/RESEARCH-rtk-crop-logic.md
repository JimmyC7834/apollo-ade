---
label: wayfinder:research
title: What rtk actually crops, per command
parent: tickets/11-rtk-in-profile.md
status: open
assignee: jc4649
---

# What rtk actually crops, per command

Date: 2026-08-08. Subject repo: `github.com/rtk-ai/rtk`, **tag `v0.44.2`, commit
`700bdde3343299ea06bbca18dc6670a80c88b289`**, `Cargo.toml:3` = `version = "0.44.2"`.
Read-only clone in scratch. No build was run. The installed binary
`C:\Users\c7834\.local\bin\rtk.exe` (**v0.43.0**, one minor behind) was invoked for
measurement only, with read-only commands. Version skew is noted where it could matter;
nothing measured depended on it.

Companion to [RESEARCH-rtk-filter-engine.md](RESEARCH-rtk-filter-engine.md), which
measured *where the engine lives and what it costs to take*. This note answers the
different question ticket 11 Amendment 2 left open: **per command, is the saving a pure
post-filter we can reimplement, or a different invocation plus a bespoke parser we
cannot?**

Every code claim carries a `path:LINE` citation against `v0.44.2`.

---

## Summary — the answer before the catalogue

**All 63 TOML filters are pure post-filters. Every one. Zero exceptions.**
`src/main.rs:1321-1338` spawns `resolved_command(argv[0]).args(argv[1..])` — the exact
argv the caller typed, no flag injection — captures stdout, and hands the string to
`apply_filter_with_info`. That is category (a) by construction: the TOML schema has no
field that can add an argument. Reimplementing it changes nothing about what runs.

**The `cmds/` half is not one thing, and this is the finding that matters.** Splitting
the 78 Rust-routed commands three ways:

| Class | What it is | Count | Extractable? |
|---|---|---|---|
| **(a)** Same argv, drop/truncate lines only | 5 | Yes — expressible as TOML today |
| **(a′)** Same argv, bespoke Rust *renderer* (groups, counts, summarises) | ~34 | Only by copying the parser |
| **(b)** Different argv (injected flags, forced JSON, written side-files) | ~27 | No |
| **(c)** rtk does not spawn the tool at all — reimplemented in Rust | 5 | No |

The 27 in class (b) are where the headline percentages live: `--porcelain`,
`--format json`, `--reporter=json`, `--output-format=json`, and in the worst case
(`dotnet`) an MSBuild binary log and a `.trx` file written to disk and parsed back.

**And a correction that sharpens Amendment 2's verdict:** for a Tauri/React/Rust project
running `cargo`, `npm`, `tsc`, `git`, `vite`, `rustc`, `clippy`, `node` — **zero of the
63 TOML filters fire.** Not "close to nothing", zero. See §6. But two of the four
commands that matter (`npm`, `cargo clippy`) turn out to be class (a) or (a′) with **no
argv change**, which is a better result than Amendment 2 assumed and reopens a cheaper
option than either E or F.

---

## 0. Corrections to the existing record

### 0.1 The pipeline has **eight** stages, not nine — ticket 11 Amendment 2 is wrong

Ticket 11's Amendment 2 says "The pipeline has nine stages, not eight." That is
incorrect, and the correction it was making was itself a mis-transcription of
[RESEARCH-rtk-filter-engine.md §3](RESEARCH-rtk-filter-engine.md), which says eight.

Upstream's own doc comment, verbatim, `src/core/toml_filter.rs:486-493`:

```rust
/// Pipeline stages (in order):
///   1. strip_ansi           — remove ANSI escape codes
///   2. replace              — regex substitutions, line-by-line, chainable
///   3. match_output         — short-circuit if blob matches a pattern
///   4. strip/keep_lines     — filter lines by regex
///   5. truncate_lines_at    — truncate each line to N chars
///   6. head/tail_lines      — keep first/last N lines
///   7. max_lines            — absolute line cap
///   8. on_empty             — message if result is empty
```

The numbered `// N.` comments in the body (`:514`, `:523`, `:539`, `:554`, `:561`,
`:580`, `:606`, `:617`) match exactly. Eight.

What was probably being counted as a ninth is one of two real things the eight-item list
hides:

- **`head_lines` shares stage 6 with `tail_lines`** and is undocumented in
  `src/filters/README.md`. It is a distinct branch (`:588-596`), not a distinct stage.
- **`filter_stderr` is a real ninth step, but it runs in the caller, not the pipeline.**
  `src/main.rs:1321-1338` decides whether to pipe stderr, and `:1348-1352` merges it into
  the string *before* stage 1. It is a field on `CompiledFilter` (`:153`) that the filter
  never reads. Calling it stage 0 is defensible; calling it stage 9 is not.

**The correct statement: eight in-pipeline stages, plus one caller-side pre-stage
(`filter_stderr`), with `head_lines` an undocumented branch inside stage 6.**

### 0.2 `RUST_HANDLED_COMMANDS` is not the routing table — clap is

Amendment 2 treats the 49-name `RUST_HANDLED_COMMANDS` list as the authority on which
commands a TOML filter can never serve. It is not. Its own doc comment says so
(`src/core/toml_filter.rs:247-249`): Clap routes first, and this list exists only to emit
an author-facing shadow warning at `compile_filter` time (`:315-326`).

**Clap defines 78 subcommands** (`enum Commands`, `src/main.rs:85` onward). The 49-name
list is a stale subset. It omits, among others: `gradlew`, `mvn`, `sbt`, `dotnet`,
`rake`, `rspec`, `rubocop`, `phpunit`, `phpstan`, `pest`, `paratest`, `ecs`, `pint`,
`php`, `uv`, `oc`, `glab`, `gt`, `jest`, `rg`, `pipe`.

**Consequence, which is new:** several shipped TOML filters are **dead in rtk's own hook
path**, because the hook rewrites the raw command to an `rtk <name>` that Clap routes to
a Rust module before `run_fallback()` is ever reached. Measured by cross-referencing
`src/discover/rules.rs` targets against the Clap variant set:

- `gradle.toml` — the rewrite rule at `rules.rs:720` sends `gradle`/`gradlew` to
  `rtk gradlew`, a Clap subcommand. Dead.
- `dotnet-build.toml` — `rules.rs:690` sends `dotnet build` to `rtk dotnet`. Dead.
- `biome.toml` — `rules.rs:171` matches `biome` and sends it to `rtk lint`. Dead.
- `yadm.toml` — `rules.rs:40` matches `yadm` and sends it to `rtk git`. Dead.
- `uv-sync.toml` — `rules.rs:917` sends `uv sync` to `rtk uv`; `uv_cmd.rs:63-67` then
  **passes it straight through unfiltered** because the first arg is not `run`. Dead, and
  worse than dead — the user gets no filtering at all.

None of these five names appears in `RUST_HANDLED_COMMANDS`, so `compile_filter`'s shadow
warning never fires for them. **The warning has false negatives.**

This does **not** affect route E. If our own `exec` applies the TOML filters directly,
there is no Clap in the path and all 63 are live. It affects only the claim "rtk ships 63
working filters" — through rtk's own hook, it ships fewer.

### 0.3 Filter data size

63 files, **73,240 bytes**, 2,402 lines, **154 inline test cases**. This differs slightly
from RESEARCH-rtk-filter-engine.md's 75,642 bytes / 2,160 lines — that count was taken
against `develop`; at `v0.44.2` the numbers above hold. Amendment 1's "97 files / ~100 KB"
and Amendment 2's "261 KB" are both wrong; 63 files / 73 KB is the measurement.

Field usage across the 63 is **identical** to what RESEARCH-rtk-filter-engine.md recorded
(`description` 63, `strip_ansi` 58, `strip_lines_matching` 57, `max_lines` 54, `on_empty`
27, `truncate_lines_at` 22, `match_output` 11, `tail_lines` 3, `unless` 2,
`keep_lines_matching` 1, `filter_stderr` 1, `replace` 0, `head_lines` 0). Re-verified
independently.

---

## 1. The (a)/(b) split, as upstream itself states it

`CONTRIBUTING.md:98-104` is the decision table rtk gives its own contributors. It is the
same axis this ticket cares about, in their words:

| Use **TOML filter** when | Use **Rust module** when |
|---|---|
| Output is plain text with predictable line structure | Output is structured (JSON, NDJSON) |
| Regex line filtering cuts 60%+ of the output bytes | Needs state machine parsing |
| **No need to inject CLI flags** | **Needs to inject flags like `--format json`** |
| No cross-command routing | Routes to other commands (lint → ruff/mypy) |

`src/filters/README.md:11` adds the constraint that makes the TOML half safe to
reimplement:

> "TOML filters strip noise lines — they don't reformat output. The filtered result must
> still look like real command output."

So upstream's own rule is: **TOML ⇒ category (a). Rust ⇒ probably (b), sometimes only
(a′).** The catalogue below tests that rule and finds it mostly but not entirely true —
several Rust modules inject nothing.

### The proof that TOML is (a)

`src/main.rs:1321-1338`, in `run_fallback`:

```rust
    if let Some(filter) = toml_match {
        // TOML match: capture stdout for filtering
        let result = if filter.filter_stderr {
            core::utils::resolved_command(&args[0])
                .args(&args[1..])
                .stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped()) // captured for merging
                .output()
        } else {
            core::utils::resolved_command(&args[0])
                .args(&args[1..])
                .stdout(std::process::Stdio::piped()) // capture
                .stderr(std::process::Stdio::inherit()) // stderr always direct
                .output()
        };
```

`args[0]` and `args[1..]` are the user's own argv, unmodified. Then `:1352-1353`:

```rust
                let (filtered, loss) =
                    core::toml_filter::apply_filter_with_info(filter, &combined_raw);
```

`apply_filter` is `(&CompiledFilter, &str) -> String` (`src/core/toml_filter.rs:495`).
There is no `Command`, no `Stdio`, no argument on either side of that boundary. **The
TOML half cannot change what runs, structurally.**

One safety valve worth copying, `src/main.rs:1371-1375`:

```rust
                // Never emit an unrecoverable truncation marker: fall back to full raw.
                let shown = if lossy && hint.is_none() {
                    core::runner::emit_guarded(&combined_raw, None, &combined_raw)
```

If output was dropped and no spill file could be written to recover it, rtk emits the
**raw** output rather than a lossy crop. Ticket 02 already gave us an overflow file, so we
can honour this.

---

## 2. Catalogue — the 63 TOML filters (all class (a))

The crop logic *is* the file. Reading the table below is reading the crop logic; the
column values are the literal TOML keys. Format: `strip` = count of
`strip_lines_matching` regexes, `keep` = `keep_lines_matching`, `trunc` =
`truncate_lines_at`, `max` = `max_lines`, `tail` = `tail_lines`, `mo` = `match_output`
short-circuit rules.

Path for every row: `src/filters/<name>.toml`, and the filter body starts at line 1.

| Filter | `match_command` | ansi | strip | keep | trunc | max | tail | mo | `on_empty` |
|---|---|---|---|---|---|---|---|---|---|
| ansible-playbook | `^ansible-playbook\b` | ✓ | 3 | | | 60 | | | |
| basedpyright | `^basedpyright\b` | ✓ | 5 | | | 50 | | | `basedpyright: ok` |
| biome | `^biome\b` | ✓ | 5 | | | 50 | | | `biome: ok` |
| brew-install | `^brew\s+(install\|upgrade)\b` | ✓ | 6 | | | 20 | | 1 | |
| bundle-install | `^bundle\s+(install\|update)\b` | ✓ | 4 | | | 30 | | 2 | |
| composer-install | `^composer\s+(install\|update\|require)\b` | ✓ | 5 | | | 30 | | 1 | |
| df | `^df(\s\|$)` | ✓ | | | 80 | 20 | | | |
| dotnet-build | `^dotnet\s+build\b` | ✓ | 4 | | | 40 | | 1 | |
| du | `^du\b` | | 1 | | 120 | 40 | | | |
| fail2ban-client | `^fail2ban-client\b` | | 1 | | | 30 | | | |
| gcc | `^g(cc\|\+\+)\b` | ✓ | 6 | | | 50 | | | `gcc: ok` |
| gcloud | `^gcloud\b` | ✓ | 1 | | 120 | 30 | | | |
| gradle | `^(gradle\|gradlew\|\./)gradlew?\b` | ✓ | 11 | | 150 | 50 | | | `gradle: ok` |
| hadolint | `^hadolint\b` | ✓ | 1 | | 120 | 40 | | | |
| helm | `^helm\b` | ✓ | 2 | | 120 | | | | |
| iptables | `^iptables\b` | | 3 | | 120 | 50 | | | |
| jira | `^jira\b` | ✓ | 2 | | 120 | 40 | | | |
| jj | `^jj\b` | ✓ | 3 | | 120 | 30 | | | |
| jq | `^jq\b` | ✓ | 1 | | 120 | 40 | | | |
| just | `^just\b` | ✓ | 3 | | 150 | 50 | | | |
| liquibase | `(?:^\|/)liquibase(?:\s\|$)` | ✓ | 12 | | | 200 | | | `liquibase: ok` — **`filter_stderr = true`** |
| make | `^make\b` | | 3 | | | 50 | | | `make: ok` |
| markdownlint | `^markdownlint\b` | ✓ | 1 | | 120 | 50 | | | |
| mise | `^mise\s+(run\|exec\|install\|upgrade)\b` | ✓ | 6 | | 150 | 50 | | | `mise: ok` |
| mix-compile | `^mix\s+compile(\s\|$)` | ✓ | 3 | | | 40 | | | `mix compile: ok` |
| mix-format | `^mix\s+format(\s\|$)` | | | | | 20 | | | `mix format: ok` |
| nx | `^(pnpm\s+)?nx\b` | ✓ | 7 | | 150 | 60 | | | |
| ollama | `^ollama\s+run\b` | ✓ | 2 | | | | | | |
| oxlint | `^oxlint\b` | ✓ | 3 | | | 50 | | | `oxlint: ok` |
| ping | `^ping\b` | ✓ | 5 | | | | **4** | | |
| pio-run | `^pio\s+run` | ✓ | 9 | | | 30 | | | `pio run: ok` |
| poetry-install | `^poetry\s+(install\|lock\|update)\b` | ✓ | 5 | | | 30 | | 1 | |
| pre-commit | `^pre-commit\b` | ✓ | 4 | | | 40 | | | |
| ps | `^ps(\s\|$)` | ✓ | | | 120 | 30 | | | |
| pulumi-destroy | `^pulumi\s+destroy(\s\|$)` | ✓ | 21 | | | | | | `pulumi destroy: nothing to destroy` |
| pulumi-preview | `^pulumi\s+preview(\s\|$)` | ✓ | 20 | | | | | | `pulumi preview: no changes` |
| pulumi-refresh | `^pulumi\s+refresh(\s\|$)` | ✓ | 20 | | | | | | `pulumi refresh: no drift` |
| pulumi-stack | `^pulumi\s+stack(...)` | ✓ | 6 | | | | | 1 | `pulumi stack: ok` |
| pulumi-up | `^pulumi\s+up(\s\|$)` | ✓ | 20 | | | | | | `pulumi up: no changes` |
| quarto-render | `^quarto\s+render` | ✓ | 8 | | | 20 | | 1 | |
| rsync | `^rsync\b` | ✓ | 3 | | | 20 | | 1 (**`unless`**) | |
| shellcheck | `^shellcheck\b` | ✓ | 1 | | | 50 | | | |
| shopify-theme | `^shopify\s+theme\s+(push\|pull)` | ✓ | 3 | | | 15 | **5** | | `shopify theme: ok` |
| skopeo | `^skopeo\b` | ✓ | 6 | | 120 | 30 | | | `skopeo: ok` |
| sops | `^sops\b` | ✓ | 1 | | | 40 | | | |
| spring-boot | `^(mvn\s+spring-boot:run\|java\s+-jar.*\.jar\|gradle\s+.*bootRun)` | ✓ | | **11** | | 30 | | | |
| ssh | `^ssh\b` | ✓ | 7 | | 120 | 200 | | | |
| stat | `^stat\b` | ✓ | 3 | | 120 | 20 | | | |
| swift-build | `^swift\s+build\b` | ✓ | 3 | | | 40 | | 1 (**`unless`**) | |
| systemctl-status | `^systemctl\s+status\b` | ✓ | 1 | | | 20 | | | |
| task | `^task\b` | ✓ | 3 | | 150 | 50 | | | `task: ok` |
| terraform-plan | `^terraform\s+plan` | ✓ | 5 | | | 80 | | | `terraform plan: no changes detected` |
| tofu-fmt | `^tofu\s+fmt(\s\|$)` | ✓ | | | | 30 | | | `tofu fmt: ok (no changes)` |
| tofu-init | `^tofu\s+init(\s\|$)` | ✓ | 7 | | | 20 | | | `tofu init: ok` |
| tofu-plan | `^tofu\s+plan(\s\|$)` | ✓ | 5 | | | 80 | | | `tofu plan: no changes detected` |
| tofu-validate | `^tofu\s+validate(\s\|$)` | ✓ | | | | | | 1 | |
| trunk-build | `^trunk\s+build` | ✓ | 6 | | | 30 | **10** | | `trunk build: ok` |
| turbo | `^turbo\b` | ✓ | 6 | | 150 | 50 | | | `turbo: ok` |
| ty | `^ty\b` | ✓ | 3 | | | 50 | | | `ty: ok` |
| uv-sync | `^uv\s+(sync\|pip\s+install)\b` | ✓ | 4 | | | 20 | | 1 | |
| xcodebuild | `^xcodebuild\b` | ✓ | 30 | | | 60 | | | `xcodebuild: ok` |
| yadm | `^yadm\b` | ✓ | 3 | | 120 | 40 | | | |
| yamllint | `^yamllint\b` | ✓ | 1 | | 120 | 50 | | | |

Every one of the 63 is class **(a)**. There is no key in the schema that can do anything
else.

### Five bodies verbatim, one per distinct mechanism

**Plain strip + cap** — the modal shape, 40-odd of the 63 look like this.
`src/filters/shellcheck.toml:1-9`:

```toml
[filters.shellcheck]
description = "Compact shellcheck output — strip blank lines, keep caret indicators for error position"
match_command = "^shellcheck\\b"
strip_ansi = true
strip_lines_matching = [
  "^\\s*$",
]
max_lines = 50
```

**Short-circuit with the `unless` guard** — the only mechanism in the TOML half that can
replace the whole output with a fixed string, and the guard that stops it swallowing an
error. `src/filters/rsync.toml:1-12`:

```toml
[filters.rsync]
description = "Compact rsync output — short-circuit on success, strip progress"
match_command = "^rsync\\b"
strip_ansi = true
strip_lines_matching = [
  "^\\s*$",
  "^sending incremental file list",
  "^sent \\d",
]
match_output = [
  { pattern = "total size is", message = "ok (synced)", unless = "error|failed|No such file" },
]
max_lines = 20
```

Only **two** of the 63 use `unless` (rsync, swift-build) despite **eleven** using
`match_output`. The other nine can short-circuit past an error. `brew-install.toml:12-14`
returns `"ok (already installed)"` on any output containing `already installed`, with no
guard.

**Allowlist instead of denylist** — the single file that uses `keep_lines_matching`.
`src/filters/spring-boot.toml:1-17`:

```toml
[filters.spring-boot]
description = "Compact Spring Boot output — strip banner and verbose startup logs, keep key events"
match_command = "^(mvn\\s+spring-boot:run|java\\s+-jar.*\\.jar|gradle\\s+.*bootRun)"
strip_ansi = true
keep_lines_matching = [
  "Started\\s.*\\sin\\s",
  "Tomcat started on port",
  "ERROR",
  "WARN",
  "Exception",
  "Caused by:",
  "Application run failed",
  "BUILD\\s",
  "Tests run:",
  "FAILURE",
  "listening on port",
]
max_lines = 30
```

**`tail_lines`** — three files use it; the semantics matter because it prepends an
omission marker that `max_lines` then counts. `src/filters/ping.toml:1-12`:

```toml
[filters.ping]
description = "Compact ping output — strip per-packet lines, keep summary"
match_command = "^ping\\b"
strip_ansi = true
strip_lines_matching = [
  "^PING ",
  "^Pinging ",
  "^\\d+ bytes from ",
  "^Reply from .+: bytes=",
  "^\\s*$",
]
tail_lines = 4
```

**`filter_stderr`** — the one file that reaches back into the caller.
`src/filters/liquibase.toml:1-5`:

```toml
[filters.liquibase]
description = "Compact liquibase output — strip headers and generic info"
match_command = "(?:^|/)liquibase(?:\\s|$)"
strip_ansi = true
filter_stderr = true
```

---

## 3. Catalogue — the `cmds/` half

76 files, **43,903 lines** (re-measured; matches Amendment 2). 78 Clap subcommands.

### 3.1 The evidence method

A command is class **(b)** if it adds any argument the user did not type. I extracted
every literal flag passed to a spawned `Command` across `src/cmds/**/*.rs`, excluding
`#[cfg(test)]` blocks. That list is the classification's backbone; each row below also
carries a direct line citation.

Savings percentages come from `src/discover/rules.rs`, the `RtkRule` table upstream uses
to estimate savings in `rtk discover`. They are upstream's **estimates**, declared as
constants — not measurements. `rules.rs:9-11`:

```rust
    pub category: &'static str,
    pub savings_pct: f64,
    pub subcmd_savings: &'static [(&'static str, f64)],
```

### 3.2 Class (b) — different invocation. **Cannot be extracted.**

| Command | Injected argv | Citation | Upstream est. |
|---|---|---|---|
| `git status` | `--porcelain -b` (replaces user args) | `git/git.rs:79` | 70% |
| `git log` | `--pretty=format:%h %s (%ar) <%an>%n%b%n---END---`, `-10`/`-50`, `--no-merges` | `git/git.rs:455,465,469,479` | 70% |
| `git diff` | `--stat`, `--shortstat`, `--no-color` | `git/git.rs:163,1553` | 80% |
| `git show` | `--no-patch`, `--pretty=format:…` | `git/git.rs:268-306` | 80% |
| `gh` | `--json number,title,state,author,body,url`, `--limit 10` | `git/gh_cmd.rs:661,726` | 82% (pr 87%) |
| `glab` | `-F` (format) | `git/glab_cmd.rs` | 82% |
| `aws` | `--output json` | `cloud/aws_cmd.rs:238,309` | 80% |
| `docker` / `kubectl` / `oc` | `--format`, `-a`, `-o` | `cloud/container.rs` | 85% |
| `curl` | `-s` | `cloud/curl_cmd.rs` | 70% |
| `go test` | `-json` | `go/go_cmd.rs` | 85% |
| `golangci-lint` | `--out-format=json`, `--output.json.path` | `go/go_cmd.rs` | 85% |
| `lint` (eslint/biome) | `--output-format=json2` | `js/lint_cmd.rs:117` | 84% |
| `vitest` | `--no-watch --json` | `js/vitest_cmd.rs:220-222` | 99% |
| `jest` | JSON reporter | `js/vitest_cmd.rs` (shared) | 99% |
| `playwright` | `--reporter=json`, `--no-install` | `js/playwright_cmd.rs:266` | 94% |
| `prisma` | `--name` | `js/prisma_cmd.rs:91` | 88% |
| `pnpm` | `--json`, `--format` | `js/pnpm_cmd.rs:371,427` | 80% |
| `ruff` | `--output-format=json` | `python/ruff_cmd.rs` | 80% |
| `pytest` | `--tb=short -q -rxX` | `python/pytest_cmd.rs:35` | 90% |
| `pip` | `--format=json`, `--outdated` | `python/pip_cmd.rs` | 75% |
| `rubocop` | `--format json` | `ruby/rubocop_cmd.rs:65` | 65% |
| `rspec` | `--format json` | `ruby/rspec_cmd.rs:82` | 65% |
| `phpstan` | `--error-format json` | `php/phpstan_cmd.rs:75` | 65% |
| `pint` | `--format=json` | `php/pint_cmd.rs:48` | 70% |
| `pest` / `paratest` | `--no-progress` | `php/pest_cmd.rs:13`, `php/paratest_cmd.rs:13` | 80% |
| `ls` | forces `-la`, sets `LC_ALL=C`, rewrites user flags | `system/ls.rs:51-53` | 65% |
| `tree` | `-I <ignore-pattern>` | `system/tree.rs:32` | 70% |
| `grep` / `rg` | `--line-buffered`, `--` | `system/search.rs:323,328,452` | 75% |
| `format` | `--check` | `system/format_cmd.rs:90` | — |
| **`dotnet`** | **worst case** — see below | `dotnet/dotnet_cmd.rs:486-526` | 70% |

**`git status`, the measured example.** `src/cmds/git/git.rs:75-83`:

```rust
fn build_status_command(args: &[String], global_args: &[String]) -> Command {
    let mut cmd = git_cmd(global_args);
    cmd.arg("status");
    if uses_compact_status_path(args) {
        cmd.args(["--porcelain", "-b"]);
    } else {
        cmd.args(args);
    }
    cmd
}
```

and the renderer, `src/cmds/git/git.rs:642-673`:

```rust
fn format_status_inner(porcelain: &str, detached: Option<&str>) -> String {
    let lines: Vec<&str> = porcelain.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() { return "Clean working tree".to_string(); }
    let mut output = Vec::new();
    if let Some(branch_line) = lines.first() {
        if branch_line.starts_with("##") {
            let branch = branch_line.trim_start_matches("## ");
            output.push(format!("* {}", detached.unwrap_or(branch)));
        }
    }
    for line in lines.iter().skip(1) { output.push((*line).to_string()); }
    if lines.len() == 1 && lines[0].starts_with("##") {
        output.push("clean — nothing to commit".to_string());
    }
    output.join("\n")
}
```

**Measured on this repository, v0.43.0 binary**, with `rtk proxy git status` for the raw
baseline (`rtk proxy` "executes command without filtering"; the plain `git status` path
on this machine is itself hook-rewritten, which invalidated a first attempt):

| | bytes |
|---|---|
| `git status` raw | 437 |
| `rtk git status` | 101 |
| **reduction** | **77%** |

Estimated by upstream at 70% (`rules.rs:44`). A pure post-filter of the raw text —
dropping the `(use "git …")` hint lines and blanks — would reach roughly 250 bytes, about
43%. **So of git status's 77%, about 43 points are (a)-reachable and 34 are not.**

**`dotnet`, the extreme.** `src/cmds/dotnet/dotnet_cmd.rs:492-526`:

```rust
    let mut effective = Vec::new();
    if subcommand != "test" && !has_binlog_arg(args) {
        effective.push(format!("-bl:{}", binlog_path.display()));
    }
    if subcommand != "test" && !has_verbosity_arg(args) {
        effective.push("-v:minimal".to_string());
    }
    ...
    if subcommand == "test" {
        match runner_mode {
            TestRunnerMode::Classic => {
                if !has_trx_logger_arg(args) {
                    effective.push("--logger".to_string());
                    effective.push("trx".to_string());
                }
                if !has_results_directory_arg(args) {
                    if let Some(results_dir) = trx_results_dir {
                        effective.push("--results-directory".to_string());
                        effective.push(results_dir.display().to_string());
                    }
```

This makes the tool **write two files to disk** (an MSBuild `.binlog` and a VSTest
`.trx`), which rtk then parses back with `binlog.rs` (1,667 lines) and `dotnet_trx.rs`
(590 lines, quick-xml). Nothing about this is a filter. It is the clearest possible
counterexample to "rtk crops output".

### 3.3 Class (c) — rtk does not run the tool at all

| Command | What actually happens | Citation |
|---|---|---|
| `find` | Never spawns `find`. Walks the tree with the `ignore` crate and a hand-written glob matcher. | `system/find_cmd.rs:6-11` (`use ignore::WalkBuilder`), `:11` `fn glob_match` |
| `read` (`cat`/`head`/`tail`) | Reads files directly in Rust. No `Command::new` outside tests. | `system/read.rs` |
| `json`, `deps`, `env` | Pure Rust; no child process. | `system/json_cmd.rs`, `system/deps.rs`, `system/env_cmd.rs` |
| `log` | Pure Rust dedup/filter over a file or stdin. Zero `.arg(` calls in the file. | `system/log_cmd.rs` |
| `wc` | Spawns `wc` with user args verbatim but the interesting path is Rust. | `system/wc_cmd.rs:16` |

`rtk find` replacing `find` is the sharpest instance of ticket 11 resolution decision 1's
hazard: the user approves `find . -name '*.rs'` and rtk runs a Rust tree-walk with
different gitignore semantics. Not a filter, not even the same program.

### 3.4 Class (a′) — same argv, bespoke Rust renderer

These are the interesting middle. rtk spawns the tool with **exactly the user's
arguments** — so the approval-mismatch objection does not apply — but the output is
*reformatted*, not merely thinned, so a TOML filter could not reproduce it.

| Command | argv change | Renderer does | Citation | Est. |
|---|---|---|---|---|
| `cargo build/check` | **none** | stream state machine, groups diagnostics | `rust/cargo_cmd.rs:267-273` | 80% |
| `cargo test` | **none** | aggregates `test result:` lines | `rust/cargo_cmd.rs:381-387` | 90% |
| `cargo clippy` | **none** | groups warnings by lint name, keeps error blocks | `rust/cargo_cmd.rs:1256+` | 80% |
| `tsc` | **none** (falls back to `npx tsc` if absent) | groups by file + code, appends a summary line | `js/tsc_cmd.rs:18-28, 80-103` | 83% |
| `mvn` | **none** | `jvm/mvn_cmd.rs:906` `cmd.args(args)` | | 82% |
| `gradlew` | **none** | `jvm/gradlew_cmd.rs:99` `cmd.args(args)` | | 75% |
| `sbt` | **none** | `scala/sbt_cmd.rs:90-92` | | 80% |
| `next build` | **none** beyond the subcommand | `js/next_cmd.rs:22-25` | | 87% |
| `prettier` | **none** | `js/prettier_cmd.rs:12` | | 70% |
| `rake` | **none** | `ruby/rake_cmd.rs:57` | | 85% |
| `phpunit` | **none** | `php/phpunit_cmd.rs:25` | | 75% |
| `psql` | **none** | strips table borders | `cloud/psql_cmd.rs:30` | 75% |
| `wget` | **none** | `cloud/wget_cmd.rs:25` | | 65% |

**`cargo`, the proof it injects nothing.** `src/cmds/rust/cargo_cmd.rs:267-273`:

```rust
    let mut cmd = resolved_command("cargo");
    cmd.arg(subcommand);

    let restored_args = args_utils::restore_double_dash(args);
    for arg in &restored_args {
        cmd.arg(arg);
    }
```

`restore_double_dash` re-inserts a `--` that Clap ate; it does not add anything. There is
**no `--message-format=json` injection** — `has_json_message_format` (`:347-360`) only
*detects* whether the user passed one, and picks a different renderer if so
(`:363-367`, `:390-392`, `:397-401`). Upstream deliberately declines to force JSON on
cargo, and says why at `:377-380`:

```rust
    // No json branch here on purpose: --message-format=json only reformats the
    // build phase, the test harness output stays human-readable.
```

**`cargo clippy`'s renderer**, the part that is not TOML-expressible —
`src/cmds/rust/cargo_cmd.rs:1256-1290`:

```rust
fn filter_cargo_clippy(output: &str) -> String {
    let mut by_rule: HashMap<String, Vec<String>> = HashMap::new();
    let mut error_count = 0;
    let mut warning_count = 0;
    let mut error_blocks: Vec<Vec<String>> = Vec::new();
    ...
    for line in output.lines() {
        if line.trim_start().starts_with("Compiling")
            || line.trim_start().starts_with("Checking")
            || line.trim_start().starts_with("Downloading")
            || line.trim_start().starts_with("Finished")
        { ... continue; }
```

The *skip* half of that is a `strip_lines_matching` list. The *grouping* half — keyed by
lint name, counted, re-emitted — is not.

**`tsc`'s renderer**, which appends a line that never existed in the input —
`src/cmds/js/tsc_cmd.rs:80-103`:

```rust
    fn format_summary(&self, _exit_code: i32, _raw: &str) -> Option<String> {
        if self.error_count == 0 {
            return Some("TypeScript: No errors found\n".to_string());
        }
        let mut result = format!(
            "TypeScript: {} errors in {} files\n",
            self.error_count, self.files.len()
        );
```

This is precisely what `src/filters/README.md:11` forbids for the TOML half — the result
no longer "looks like real command output".

### 3.5 Class (a) — same argv, drop-lines only. **Directly extractable.**

Five commands. These are Rust modules that could have been TOML files.

**`npm` / `npx`** — `src/cmds/js/npm_cmd.rs:136-168`, the entire filter:

```rust
fn filter_npm_output(output: &str) -> String {
    let mut result = Vec::new();
    for line in output.lines() {
        if line.starts_with('>') && line.contains('@') { continue; }
        if line.trim_start().starts_with("npm WARN") { continue; }
        if line.trim_start().starts_with("npm notice") { continue; }
        if line.contains("⸩") || line.contains("⸨") || line.contains("...") && line.len() < 10 { continue; }
        if line.trim().is_empty() { continue; }
        result.push(line.to_string());
    }
    if result.is_empty() { "ok".to_string() } else { result.join("\n") }
}
```

That is exactly:

```toml
[filters.npm]
match_command = "^npm\\s+(run|exec|run-script)\\b"
strip_lines_matching = ["^>.*@", "^\\s*npm WARN", "^\\s*npm notice", "^\\s*$"]
on_empty = "ok"
```

The one argv change is `run` injection (`npm_cmd.rs:86-92`), and it **cannot fire on the
hook path**: the rewrite rule is `^npm\s+(exec|run|run-script|rum|urn|x)(\s|$)`
(`rules.rs:90`), so `args[0]` is always already a subcommand and `is_npm_subcommand` is
true. **In practice `rtk npm` is pure class (a).** Upstream estimates 70%
(`rules.rs:94`).

The other four: `wc` (`system/wc_cmd.rs:16`), `psql` border-stripping
(`cloud/psql_cmd.rs:30`), `prettier` (`js/prettier_cmd.rs:12`), `rake`
(`ruby/rake_cmd.rs:57`) — all spawn with verbatim args and drop lines, though `rake` and
`psql` shade into (a′) where they re-tabulate.

### 3.6 The universal safety net, worth copying either way

`src/core/guard.rs:6-12`:

```rust
pub fn never_worse<'a>(raw: &'a str, filtered: &'a str) -> &'a str {
    if estimate_tokens(filtered) > estimate_tokens(raw) { raw } else { filtered }
}
```

If the "filtered" output would be larger than the raw, emit the raw. Called from the
`cmds/` half (e.g. `git.rs` after `filter_log_output`, `system/find_cmd.rs`). The TOML
half has an analogous guard in `main.rs:1371-1375`. Thirteen lines, and it is the
cheapest insurance against the ticket's "invisible degradation" worry.

---

## 4. The eight pipeline stages, with the code

`src/core/toml_filter.rs:511-647`. Input `&str`, split to lines at `:512`, rejoined at
`:620`. **The trailing newline of the input is not preserved.**

**Stage 1 — `strip_ansi`** (`:514-520`). Per line, gated on the bool.

```rust
    if filter.strip_ansi {
        lines = lines.into_iter().map(|l| crate::core::utils::strip_ansi(&l)).collect();
    }
```

The regex is `\x1b\[[0-9;]*[a-zA-Z]` — `src/core/utils.rs:52-57`. Note it handles CSI
only: no OSC (`\x1b]…\x07`), no bare `\x1b(`. `ollama.toml` compensates by stripping
spinner glyphs separately.

**Stage 2 — `replace`** (`:523-536`). Per line, `replace_all`, rules **chained** (rule
N+1 sees rule N's output), `$1` backreferences supported. **Zero of the 63 built-ins use
it.**

**Stage 3 — `match_output`** (`:539-552`). The only stage that can discard everything.

```rust
    if !filter.match_output.is_empty() {
        let blob = lines.join("\n");
        for rule in &filter.match_output {
            if rule.pattern.is_match(&blob) {
                if let Some(ref unless_re) = rule.unless {
                    if unless_re.is_match(&blob) {
                        continue; // errors/warnings present — skip this rule
                    }
                }
                return (rule.message.clone(), Lossiness::Whole);
            }
        }
    }
```

Matched against the **joined blob**, not per line — so a pattern can span lines
(`dotnet-build.toml:11` relies on this: `"0 Warning\\(s\\)\\n\\s+0 Error\\(s\\)"`).
First rule wins, returns immediately, **stages 4-8 never run**.

**Stage 4 — `strip` / `keep`** (`:554-559`). Mutually exclusive; declaring both is a
compile error at `:308-310`. Implemented as a `RegexSet`, so "matches any pattern".

```rust
    match &filter.line_filter {
        LineFilter::Strip(set) => lines.retain(|l| !set.is_match(l)),
        LineFilter::Keep(set) => lines.retain(|l| set.is_match(l)),
        LineFilter::None => {}
    }
```

**Stage 5 — `truncate_lines_at`** (`:561-574`). **Character** count, not bytes.
`src/core/utils.rs:29-39`: the `...` is *inside* the budget — `truncate(s, n)` keeps
`n-3` chars and appends `...`; if `n < 3` the whole line becomes `...`.

**Stage 6 — `head_lines` + `tail_lines`** (`:580-604`). Three branches:

```rust
    if let (Some(head), Some(tail)) = (filter.head_lines, filter.tail_lines) {
        if total > head + tail {
            let mut result = lines[..head].to_vec();
            result.push(format!("... ({} lines omitted)", total - head - tail));
            result.extend_from_slice(&lines[total - tail..]);
            lines = result;
            noncontiguous_drop = true;
        }
    } else if let Some(head) = filter.head_lines {
        if total > head {
            lines.truncate(head);
            lines.push(format!("... ({} lines omitted)", total - head));
            head_cut = Some(head);
        }
    } else if let Some(tail) = filter.tail_lines {
        if total > tail {
            let omitted = total - tail;
            lines = lines[omitted..].to_vec();
            lines.insert(0, format!("... ({} lines omitted)", omitted));
            noncontiguous_drop = true;
        }
    }
```

`head_lines` is used by **zero** built-ins and is absent from `src/filters/README.md`.

**Stage 7 — `max_lines`** (`:606-615`). Runs *after* stage 6 and therefore counts the
omission markers stage 6 inserted. The marker text differs — "truncated", not "omitted".

```rust
    if let Some(max) = filter.max_lines {
        if lines.len() > max {
            let dropped = lines.len() - max;
            lines.truncate(max);
            lines.push(format!("... ({} lines truncated)", dropped));
            max_cut = Some(max);
        }
    }
```

**Stage 8 — `on_empty`** (`:617-624`). Checked on the **trimmed** join, so whitespace-only
output triggers it.

```rust
    let result = lines.join("\n");
    if result.trim().is_empty() {
        if let Some(ref msg) = filter.on_empty {
            return (msg.clone(), Lossiness::None);
        }
    }
```

**Plus `Lossiness`** (`:626-644`), interleaved bookkeeping that tells the caller whether
`tail -n +K` over a spill file could reconstruct what was dropped. `apply_filter`
(`:495-497`) throws it away. A pre-cut snapshot is taken at `:577-578` only when the crop
is a contiguous head cut.

---

## 5. The full TOML schema

Authoritative source: `src/core/toml_filter.rs:82-108`. The struct carries
`#[serde(deny_unknown_fields)]` (`:83`), so an unrecognised key is a hard parse error, not
a silent ignore.

### `[filters.<name>]`

| Key | Type | Required | Default | Line |
|---|---|---|---|---|
| `description` | string | no | `None` | `:85` |
| `match_command` | regex string | **yes** | — | `:86` |
| `strip_ansi` | bool | no | `false` | `:88` |
| `replace` | array of `ReplaceRule` | no | `[]` | `:91` |
| `match_output` | array of `MatchOutputRule` | no | `[]` | `:94` |
| `strip_lines_matching` | array of regex string | no | `[]` | `:96` |
| `keep_lines_matching` | array of regex string | no | `[]` | `:98` |
| `truncate_lines_at` | `usize` | no | `None` | `:99` |
| `head_lines` | `usize` | no | `None` | `:100` |
| `tail_lines` | `usize` | no | `None` | `:101` |
| `max_lines` | `usize` | no | `None` | `:102` |
| `on_empty` | string | no | `None` | `:103` |
| `filter_stderr` | bool | no | `false` | `:107` |

Thirteen keys. `strip_lines_matching` and `keep_lines_matching` are **mutually
exclusive** — `compile_filter` rejects both (`:308-310`).

### `ReplaceRule` — `src/core/toml_filter.rs:56-60`

| Key | Type | Required |
|---|---|---|
| `pattern` | regex string | yes |
| `replacement` | string (supports `$1`) | yes |

### `MatchOutputRule` — `src/core/toml_filter.rs:43-50`

| Key | Type | Required |
|---|---|---|
| `pattern` | regex string | yes |
| `message` | string | yes |
| `unless` | regex string | no (`None`) |

### File level — `src/core/toml_filter.rs:73-81`

| Key | Type | Required | Notes |
|---|---|---|---|
| `schema_version` | `u32` | **yes** | must equal `1`, checked at `:229-234` |
| `filters` | `BTreeMap<String, TomlFilterDef>` | no | `[filters.<name>]` |
| `tests` | `BTreeMap<String, Vec<TomlFilterTestDef>>` | no | `[[tests.<name>]]` |

`TomlFilterTestDef` (`:64-70`): `name`, `input`, `expected`, all required strings. Note
this struct is **not** nested inside `filters`, deliberately — `:79-80` explains it keeps
`deny_unknown_fields` on `TomlFilterDef` viable.

### Divergences from the README, and which to trust

`src/filters/README.md:47-62` documents **eleven** fields. Prefer the source:

- **`head_lines` is missing entirely** from the README table.
- **`match_output` is documented as `{ pattern, message }`** — no `unless`. Two shipped
  filters use `unless`.
- **`max_lines` is described as "keep only the first N lines"**, which is true but hides
  that it runs *after* head/tail and counts their omission markers.
- The README's mermaid diagram (`src/filters/README.md`, "Build and runtime pipeline")
  also lists the pipeline as `… → truncate → tail_lines → max_lines → on_empty`, omitting
  `head_lines`. Consistent with its own table, still wrong.

The local example at `C:\Users\c7834\AppData\Roaming\rtk\filters.toml` is 12 lines and
entirely comments apart from `schema_version = 1`. It is a template written by `rtk init`,
not a schema.

---

## 6. `RUST_HANDLED_COMMANDS`, verbatim

`src/core/toml_filter.rs:247-300`. Doc comment included because it is the part that
misleads:

```rust
/// Commands already handled by dedicated Rust modules (routed by Clap before TOML).
/// A TOML filter whose match_command matches one of these will never activate —
/// Clap routes the command before `run_fallback()` is reached.
const RUST_HANDLED_COMMANDS: &[&str] = &[
    "ls",
    "tree",
    "read",
    "smart",
    "git",
    "gh",
    "aws",
    "psql",
    "pnpm",
    "err",
    "test",
    "json",
    "deps",
    "env",
    "find",
    "diff",
    "log",
    "docker",
    "kubectl",
    "summary",
    "grep",
    "init",
    "wget",
    "wc",
    "gain",
    "config",
    "vitest",
    "prisma",
    "tsc",
    "next",
    "lint",
    "prettier",
    "format",
    "playwright",
    "cargo",
    "npm",
    "npx",
    "curl",
    "discover",
    "ruff",
    "pytest",
    "mypy",
    "pip",
    "go",
    "golangci-lint",
    "rewrite",
    "proxy",
    "verify",
    "learn",
];
```

**49 entries.** Its only two uses:

- `is_rtk_reserved_command` (`:301-303`), CLI name-collision routing.
- The shadow warning in `compile_filter` (`:315-326`), which prints to stderr and does not
  block the filter.

As §0.2 established, it is a **stale subset** of Clap's 78 subcommands and produces false
negatives.

---

## 7. The payoff — what applies to a Tauri/React/Rust project

Commands in scope: `cargo`, `npm`, `tsc`, `git`, `vite`, `rustc`, `clippy`, `node`.

### 7.1 TOML filters that would fire: **zero**

Checked each of the 63 `match_command` regexes against these command lines. None matches.
The nearest misses:

| Our command | Nearest filter | Why it does not fire |
|---|---|---|
| `cargo build` | — | No `cargo` filter exists. `cargo` is `RUST_HANDLED_COMMANDS[34]`. |
| `npm run build` | — | No `npm` filter exists. `RUST_HANDLED_COMMANDS[35]`. |
| `tsc --noEmit` | — | No `tsc` filter. `RUST_HANDLED_COMMANDS[28]`. |
| `git status` | — | No `git` filter. `yadm.toml` is git-shaped but `match_command = "^yadm\\b"`. |
| `npx vite build` | — | No `vite` filter, and `^npx\s+` routes to the Rust `npx` module. |
| `vite build` | — | **No rule and no filter. rtk does nothing at all.** |
| `rustc …` | `gcc.toml` | `match_command = "^g(cc\|\+\+)\b"`. Does not match `rustc`. |
| `node …` | — | No rule, no filter. rtk does nothing. |
| `cargo clippy` | — | Routed to `rust/cargo_cmd.rs:389-393`. |

**Amendment 2 said "the overlap is close to nothing." The measurement is stronger: it is
exactly nothing.** Route E — vendoring the 63 TOML files and writing the engine — buys
this repository **zero filters** as shipped.

### 7.2 But the `cmds/` classification changes the conclusion

Amendment 2's implicit model was: the value is in `cmds/`, `cmds/` cannot travel,
therefore nothing is worth building. §3 breaks that model, because the four commands we
actually run split as:

| Our command | Class | argv changed? | What we would have to write |
|---|---|---|---|
| `npm run …` | **(a)** | **No** | 4 regexes + `on_empty`. A TOML file. |
| `cargo build/check/test/clippy` | **(a′)** | **No** | ~15 skip-regexes get most of it; grouping is extra |
| `tsc` | **(a′)** | **No** | ~2 skip-regexes; the summary line is extra |
| `git status/log/diff/show` | **(b)** | **Yes** | not extractable |
| `vite`, `node`, `rustc` | — | — | rtk offers nothing; we would be writing new filters anyway |

**Three of our four are argv-preserving.** For `npm` the entire upstream filter is
reproduced above in six lines of TOML. For `cargo` and `tsc` the *noise-dropping* portion
— which is most of the byte reduction on a clean build — is a `strip_lines_matching`
list; only the grouping and summary lines need Rust.

That is a materially different picture from "route E buys nothing". It suggests a route
Amendment 2 did not list:

> **G — take the engine (route E's ~400 lines), ship almost none of the 63 upstream
> filters, and write our own five: `npm`, `cargo`, `tsc`, `vite`, `node`.**

Cost is E's engine plus five TOML files. It carries no Apache-2.0 obligation at all if we
write the filters ourselves — §7 of the companion note's licence analysis only attaches to
copied expression. It also keeps ticket 11 route E's structural win: the filter runs after
the command, so the user approves exactly what runs.

**What G cannot buy:** `git status`'s extra 34 points, `cargo clippy`'s lint grouping,
`tsc`'s error-count summary. Those need a parser, and a parser is per-tool work whether we
copy it or write it.

### 7.3 The measurement that is still missing

Both this note and Amendment 2 are reasoning about *rtk's* estimates. Upstream's
`savings_pct` values are **hard-coded constants in `src/discover/rules.rs`**, not
measurements — `rules.rs:9-11` declares them as struct fields with a 60.0 default
(`rules.rs:26`). The README's headline is hedged in the source too, `README.md:60`:

> "RTK cuts up to 90% of the bash output your agent reads. That is what RTK measures, and
> it is not the same as cutting your bill by 90%."

Nobody has yet measured what **our** turns spend tokens on. Amendment 2's blocker stands.
G is cheaper than E and aimed at commands we actually run, which lowers the bar that
measurement has to clear — but it does not remove it.

---

## 8. Where I am uncertain

1. **The class (a′)/(b) boundary for ~10 of the 78 Clap subcommands is inferred from a
   literal-flag scan**, not a line-by-line read. Commands built with `format!`-constructed
   arguments could be misclassified as (a′). I verified `psql`, `mvn`, `gradlew`, `sbt`,
   `dotnet`, `next`, `prettier`, `rake`, `phpunit`, `wc`, `wget`, `tree` by hand.
   `mypy`, `php`, `ecs`, `summary`, `err`, `smart`, `pipe`, `jest` are **unverified**.
2. **Counts in the (a)/(a′)/(b)/(c) summary table are approximate** — "~34", "~27" — for
   the same reason. The five in class (a) and the five in class (c) were each read.
3. **The 77% git-status measurement is one repository, one working-tree state**, on the
   v0.43.0 binary. `git.rs:75-83` is byte-identical at v0.44.2, so the mechanism holds,
   but the percentage is a single sample.
4. **The 43%-of-77 estimate for what a post-filter could reach on `git status` is
   arithmetic on the raw text I captured**, not a filter I ran.
5. **I did not check whether the five "dead" filters (§0.2) are reachable some other way**
   — e.g. a user typing `rtk gradle …` with no `w`. `gradle` is not a Clap subcommand, so
   that specific spelling probably does reach `gradle.toml`. Treat "dead" as "dead on the
   documented hook path".
6. **`rules.rs` savings figures are upstream constants, restated here, not verified.**
7. **v0.43.0 vs v0.44.2 skew** was not audited beyond the files quoted. Every code
   citation is against v0.44.2 source; every measurement is against the v0.43.0 binary.
