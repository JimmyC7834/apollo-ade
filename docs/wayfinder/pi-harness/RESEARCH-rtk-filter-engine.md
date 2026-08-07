---
label: wayfinder:research
title: Where rtk's filter engine lives, and what it costs to take
parent: tickets/11-rtk-in-profile.md
status: closed
assignee: jc4649
---

# Where rtk's filter engine lives, and what it costs to take

Date: 2026-08-06. Subject repo: `github.com/rtk-ai/rtk`, shallow clone of the default
branch `develop` at commit `3044911`, plus fetched tags `v0.44.2`, `v0.40.0`, `v0.36.0`,
`v0.30.0`. Read-only. No build was run. No rtk binary was invoked.

This note closes the one gap left by
[ticket 11's Amendment](tickets/11-rtk-in-profile.md): **nobody had located the code that
applies the filter TOML rules.** That code is one file. This note measures it.

Every structural claim carries a `path:LINE` citation against `v0.44.2`. For
`src/core/toml_filter.rs` the tag and `develop` are byte-identical, so the line numbers
hold for both.

---

## 0. Corrections to the existing record

Three facts in ticket 11's Amendment are wrong or stale. The rest hold.

| Claim in ticket 11 | Measured |
|---|---|
| "`src/filters/` = 97 TOML files" | **63 TOML files**, one filter definition each, plus a `README.md`. Same count at `v0.44.2` and on `develop`. `v0.40.0` had 60. `v0.30.0` had 48. |
| "~100 KB" of filter data | **75,642 bytes (74 KB)** across 2,160 lines. |
| "the documented 8-stage pipeline: `strip_ansi → replace → match_output → strip/keep_lines → truncate → tail_lines → max_lines → on_empty`" | The code implements **`head_lines` as well as `tail_lines` at stage 6**, and a `unless` guard on `match_output`. Neither appears in `src/filters/README.md:47-62`. See §3. |
| "v0.44.2 is the current release" | Holds. `v0.44.2` is the newest non-rc tag. The default branch is `develop`, whose `Cargo.toml` still reads `version = "0.42.4"` and whose newest tag is `dev-0.45.0-rc.350`. |
| "no `[lib]`, no `src/lib.rs`, `src/main.rs` ~122 KB" | Holds. `Cargo.toml:1-12` has no `[lib]`. `src/main.rs` is 3,621 lines / 122.5 KB. |
| "not on crates.io" | Not re-checked in this pass. `Cargo.toml:8` gives `license = "Apache 2.0"`, a non-SPDX string. |
| "`src/cmds/` re-invokes the tool rather than filtering captured output" | Holds, and is confirmed by the code path in §4. |
| "`[tracking] enabled = true, history_days = 90` — unverified, load-bearing" | Verified. It is a **local SQLite database only**. See §7. |

The "97" figure was probably a count of something else. It is not the file count at any
tag I read.

---

## 1. Where the filter engine lives

**One file: `src/core/toml_filter.rs`, 1,968 lines.**

That file holds the whole TOML pipeline: the schema types, the regex compiler, the
matcher, and the eight stages. Nothing else in the tree implements any part of it.

Its internal structure, by line range:

| Lines | Count | What |
|---|---|---|
| 1-32 | 32 | Module doc + `include_str!` of the built-in blob |
| 34-109 | 76 | Deserialization types — the TOML schema |
| 111-154 | 44 | Compiled types, post-regex-compilation |
| 156-175 | 20 | `TestOutcome` / `VerifyResults` — for `rtk verify` only |
| 177-245 | 69 | `TomlFilterRegistry::load` and `parse_and_compile` |
| 247-304 | 58 | `RUST_HANDLED_COMMANDS` list + `is_rtk_reserved_command` |
| 306-392 | 87 | `compile_filter` — validation and regex compilation |
| 394-469 | 76 | Lazy singleton, env-var switches, `RegexSet` prefilter |
| 471-482 | 12 | `find_filter_in` — pure lookup |
| 484-647 | **164** | `apply_filter`, `Lossiness`, `apply_filter_with_info` — **the eight stages** |
| 649-774 | 126 | `run_filter_tests` / `collect_test_outcomes` — `rtk verify` |
| 776-798 | 23 | `find_matching_filter` — singleton wrapper |
| 804-1968 | **1,164** | `#[cfg(test)] mod tests` — 65 `#[test]` functions |

Production code is 804 lines. The pipeline itself is 164
(`src/core/toml_filter.rs:484-647`).

Two supporting files:

- `build.rs:19-70` — concatenates `src/filters/*.toml` alphabetically into
  `$OUT_DIR/builtin_filters.toml`, prepends `schema_version = 1`, parses the result to
  validate it, and panics on a duplicate filter name. 52 lines of the 76-line file.
- `src/core/utils.rs:29-39` (`truncate`, 11 lines) and `src/core/utils.rs:52-57`
  (`strip_ansi`, 6 lines) — the only two helpers the pipeline calls.

`src/core/filter.rs` (547 lines) is **not** part of this. It strips comments from source
code (`src/core/filter.rs:1`). The name collision is unhelpful.

---

## 2. What it drags in

### Internal modules

Only three, and two of them are avoidable:

| Module | How used | Where | Avoidable? |
|---|---|---|---|
| `core::utils` | `strip_ansi`, `truncate` | `toml_filter.rs:518`, `:567` | **No.** 17 lines out of a 1,048-line file. Copy the two functions. |
| `core::constants` | `RTK_META_COMMANDS` | `toml_filter.rs:25`, `:303` | **Yes.** Used only by `is_rtk_reserved_command`, which is CLI routing, not filtering. |
| `hooks::trust` | trust-gating of on-disk filter files | `toml_filter.rs:191`, `:208-221`, `:440-449`, `:676-680` | **Yes.** 631-line file. See below. |

**The load-bearing measurement:** every `crate::hooks::trust` reference sits in
`TomlFilterRegistry::load` (`:188-223`), `collect_match_patterns` (`:438-458`), or
`run_filter_tests` (`:657-710`). **None is inside `compile_filter`, `find_filter_in`, or
`apply_filter_with_info`.** The transform path has zero coupling to trust, to config
loading, or to telemetry.

There is **no** config loader in the path. `core::config` is never imported by
`toml_filter.rs`. There is **no** telemetry hook in the path. `core::telemetry` and
`core::tracking` are called by `main.rs`, after the filter returns
(`src/main.rs:1382-1388`).

### External crates

The pipeline needs three, all with versions from `Cargo.toml:15-36`:

| Crate | Version | Used for |
|---|---|---|
| `regex` | `1` | `Regex`, `RegexSet` — every stage |
| `serde` | `1`, `derive` | `#[derive(Deserialize)]` on the schema types |
| `toml` | `0.8` | `toml::from_str` |

rtk declares 20 direct dependencies. The other 17 — `clap`, `rusqlite` (with `bundled`,
so a C build), `ureq`, `quick-xml`, `flate2`, `sha2`, `chrono`, `dirs`, `ignore`,
`walkdir`, `colored`, `tempfile`, `which`, `getrandom`, `automod`, `anyhow`,
`serde_json` — are for the CLI, the tracking database, the network telemetry, and the
`cmds/` half. The pipeline touches none of them.

**Cost to us: zero new crates.** `regex 1.13.1` and `toml` are already in
`src-tauri/Cargo.lock` through Tauri's own graph. `serde` is already a direct dependency
(`src-tauri/Cargo.toml:16`). Promoting `regex` and `toml` to direct dependencies adds no
compilation.

---

## 3. The TOML schema

### Full field set

From `src/core/toml_filter.rs:83-109`. The struct carries
`#[serde(deny_unknown_fields)]`, so an unrecognised key is a hard parse error.

| Field | Type | Required | Default | Line |
|---|---|---|---|---|
| `description` | string | no | none | `:86` |
| `match_command` | regex | **yes** | — | `:87` |
| `strip_ansi` | bool | no | `false` | `:89` |
| `replace` | array of `{ pattern, replacement }` | no | `[]` | `:92` |
| `match_output` | array of `{ pattern, message, unless? }` | no | `[]` | `:95` |
| `strip_lines_matching` | regex[] | no | `[]` | `:97` |
| `keep_lines_matching` | regex[] | no | `[]` | `:99` |
| `truncate_lines_at` | int | no | none | `:100` |
| `head_lines` | int | no | none | `:101` |
| `tail_lines` | int | no | none | `:102` |
| `max_lines` | int | no | none | `:103` |
| `on_empty` | string | no | none | `:104` |
| `filter_stderr` | bool | no | `false` | `:108` |

File-level keys: `schema_version` (`:74`, must equal `1`, checked at `:229-234`),
`[filters.<name>]` (`:76`), `[[tests.<name>]]` with `name` / `input` / `expected`
(`:66-70`, `:80`).

`replace` rules are `{ pattern, replacement }` (`:57-60`). `match_output` rules are
`{ pattern, message, unless }` (`:45-50`).

**Divergences from the README.** `src/filters/README.md:47-62` lists eleven fields. It
omits `head_lines` entirely, and it documents `match_output` as `{ pattern, message }`
with no `unless`. It also says `max_lines` means "keep only the first N lines", which is
true but hides that `max_lines` runs *after* `head`/`tail` and counts the omission
markers those stages insert.

### Field usage across the 63 built-in filters

Measured over `src/filters/*.toml`:

| Field | Files using it |
|---|---|
| `description` | 63 |
| `strip_ansi` | 58 |
| `strip_lines_matching` | 57 |
| `max_lines` | 54 |
| `on_empty` | 27 |
| `truncate_lines_at` | 22 |
| `match_output` | 11 |
| `tail_lines` | 3 |
| `unless` | 2 |
| `keep_lines_matching` | 1 |
| `filter_stderr` | 1 |
| **`replace`** | **0** |
| **`head_lines`** | **0** |

Two of the eight documented stages are dead data in the shipped filter set. That matters
for §8.

### The eight stages, as the code implements them

`src/core/toml_filter.rs:511-647`. Input is a `&str`. The blob is split into lines at
`:512` and joined back at `:620`.

1. **`strip_ansi`** (`:515-520`). Per line, if the flag is set. Regex is
   `\x1b\[[0-9;]*[a-zA-Z]` (`src/core/utils.rs:54`).
2. **`replace`** (`:523-536`). Per line. Rules **chain**: rule *N+1* sees the output of
   rule *N*. `replace_all`, so every occurrence on the line. `$1` backreferences work.
3. **`match_output`** (`:540-552`). Short-circuit. The lines are joined into one blob
   (`:541`) and each rule is tried in declaration order. **First match wins and returns
   immediately** (`:549`) — stages 4-8 never run. If the rule has `unless` and that regex
   also matches the blob, the rule is skipped (`:544-548`). That is the guard against a
   success message swallowing an error.
4. **`strip_lines_matching` / `keep_lines_matching`** (`:555-559`). Mutually exclusive —
   declaring both is a compile error at `:308-310`. Implemented as a `RegexSet`, so a
   line matching *any* pattern is dropped (strip) or kept (keep).
5. **`truncate_lines_at`** (`:563-574`). Per line, character-count based, not byte-based
   (`src/core/utils.rs:30`). A truncated line ends with a literal `...` and the ellipsis
   is **inside** the budget: `truncate(s, n)` keeps `n-3` characters and appends `...`.
   If `n < 3` the whole line becomes `...`.
6. **`head_lines` + `tail_lines`** (`:582-606`). Three cases:
   - Both set, and `total > head + tail`: keep the first `head`, insert
     `... (N lines omitted)`, keep the last `tail` (`:585-592`).
   - Head only: truncate to `head`, then **append** `... (N lines omitted)` (`:593-598`).
   - Tail only: keep the last `tail`, then **prepend** `... (N lines omitted)`
     (`:599-606`).
7. **`max_lines`** (`:610-617`). Absolute cap applied *after* stage 6, so it counts the
   omission markers stage 6 inserted. On overflow it truncates and appends
   `... (N lines truncated)` — note "truncated", not "omitted".
8. **`on_empty`** (`:620-625`). If the joined result is empty after `.trim()`, return the
   message. Checked on the *trimmed* string, so a result of only whitespace triggers it.

Output is `lines.join("\n")`. The trailing newline of the input is not preserved.

`apply_filter_with_info` also returns a `Lossiness` (`:499-509`, computed at `:627-644`)
telling the caller whether a `tail -n +K` over a spill file could reconstruct what was
dropped. That is a *caller* concern, not a filter concern; `apply_filter` (`:495-497`)
throws it away.

### A representative filter, verbatim

`src/filters/gradle.toml`:

```toml
[filters.gradle]
description = "Compact Gradle build output — strip progress, keep tasks and errors"
match_command = "^(gradle|gradlew|\\./)gradlew?\\b"
strip_ansi = true
strip_lines_matching = [
  "^\\s*$",
  "^> Configuring project",
  "^> Resolving dependencies",
  "^> Transform ",
  "^Download(ing)?\\s+http",
  "^\\s*<-+>\\s*$",
  "^> Task :.*UP-TO-DATE$",
  "^> Task :.*NO-SOURCE$",
  "^> Task :.*FROM-CACHE$",
  "^Starting a Gradle Daemon",
  "^Daemon will be stopped",
]
truncate_lines_at = 150
max_lines = 50
on_empty = "gradle: ok"

[[tests.gradle]]
name = "strips UP-TO-DATE tasks, keeps build result"
input = "> Configuring project :app\n> Task :app:compileJava UP-TO-DATE\n> Task :app:compileKotlin UP-TO-DATE\n> Task :app:test\n\n3 tests completed, 1 failed\n\nBUILD FAILED in 12s"
expected = "> Task :app:test\n3 tests completed, 1 failed\nBUILD FAILED in 12s"

[[tests.gradle]]
name = "clean build preserved"
input = "BUILD SUCCESSFUL in 8s\n7 actionable tasks: 7 executed"
expected = "BUILD SUCCESSFUL in 8s\n7 actionable tasks: 7 executed"

[[tests.gradle]]
name = "empty after stripping"
input = "> Configuring project :app\n"
expected = "gradle: ok"
```

That file is typical. The 63 filters carry **154 inline test cases** in total, each a
plain `input` / `expected` string pair. They are executable data, not Rust.

---

## 4. How coupled the engine is to being a CLI

**The transform is a pure function.** The signature is:

```rust
pub fn apply_filter(filter: &CompiledFilter, stdout: &str) -> String
```

`src/core/toml_filter.rs:495`. String in, string out. No `Stdio`, no `Command`, no
`isatty`, no locks, no globals, no I/O, no `Result`. It cannot fail — a bad regex was
already rejected at compile time by `compile_filter` (`:306`).

Around that pure core there are three CLI entanglements, all of them outside it:

1. **A lazy global registry.** `static REGISTRY: LazyLock<TomlFilterRegistry>` (`:398`)
   is read only through `find_matching_filter` (`:782`). `find_filter_in` (`:477`) does
   the same lookup against a caller-supplied slice, with no global. The upstream doc
   comment at `:475-476` says tests should use it. So the global is optional.
2. **Environment variables.** `RTK_NO_TOML` (`:401`) and `RTK_TOML_DEBUG` (`:783`,
   `:791`), plus `RTK_TRUST_PROJECT_FILTERS` inside trust (`src/hooks/trust.rs:104`).
   All read outside the pipeline.
3. **`eprintln!` on bad input.** Parse and compile errors are printed to stderr and the
   bad filter is dropped (`:216`, `:240`, `:319`, `:735`). Nothing panics. This is the
   one thing we would change: we want an error value, not a stderr write.

**Process spawning lives entirely in the caller.** `src/main.rs:1321-1338` is where rtk
decides to pipe stdout, and `:1354-1355` is where it calls the filter on the already
captured string. That is exactly the seam ticket 11 route E predicted: our `exec` already
holds the captured string at that point.

The `filter_stderr` flag is the one field that reaches back into the caller. It is
`pub` on `CompiledFilter` (`:153`) and read by `main.rs:1323` and `:1348` to decide
whether to merge stderr into the text before filtering. It is a hint to the runner, not
a stage. One built-in filter uses it (`liquibase`).

---

## 5. Compiled in, or read at runtime?

**Both, and the built-ins are compiled in.**

`const BUILTIN_TOML: &str = include_str!(concat!(env!("OUT_DIR"), "/builtin_filters.toml"));`
— `src/core/toml_filter.rs:32`.

`build.rs:19-70` produces that file: read `src/filters/`, keep `*.toml`, sort by file
name for determinism (`build.rs:35`), prepend `schema_version = 1`, concatenate with a
`# --- name.toml ---` banner per file, parse the result as `toml::Value` to fail the
build on a syntax error (`build.rs:50-56`), and reject duplicate filter names
(`build.rs:58-68`).

Two runtime paths also exist, both trust-gated: `.rtk/filters.toml` (project) and
`<config_dir>/rtk/filters.toml` (global), listed at `src/hooks/trust.rs:206-216` and
loaded at `src/core/toml_filter.rs:188-223`. Precedence is on-disk first, built-in last,
first regex match wins (`:477-482`).

**Consequence for vendoring:** the filter data is a file copy plus a ~50-line build
script. There is no directory scan at runtime, no `include_dir!`, and no loader to write
unless we want user-supplied filters. The concatenation trick means we could also just
check in one pre-concatenated `.toml` and skip the build script entirely.

---

## 6. Version reality

| | |
|---|---|
| Newest release tag | `v0.44.2` |
| Default branch | `develop` (`Cargo.toml` version `0.42.4`, tag `dev-0.45.0-rc.350`) |
| Release cadence | `v0.40.0` 2026-05-13, `v0.41.0` 05-22, `v0.42.0` 05-24, `v0.42.1` 06-03, `v0.42.2` 06-05, `v0.42.3` 06-05, `v0.42.4` 06-12. Then `v0.43.0`, `v0.44.0`, `v0.44.1`, `v0.44.2` after the changelog on `develop` stops. **Roughly one release a week.** |
| Release tooling | `release-please`, `.release-please-manifest.json` |

**Schema drift: none.** `TomlFilterDef` is field-for-field identical at `v0.36.0`,
`v0.40.0`, and `v0.44.2` — same thirteen fields, same order, same defaults, including
`head_lines`, `unless`, and `filter_stderr`. `schema_version` has been `1` throughout.

**Engine drift: substantial.** `src/core/toml_filter.rs` went 1,697 → 1,968 lines between
`v0.40.0` and `v0.44.2` (+330 / -59), about two months. The changes were the trust
refactor, `lazy_static` → `std::sync::LazyLock`, the `RegexSet` command prefilter, and
the whole `Lossiness` enum, which does not exist at `v0.40.0` or `v0.36.0`. At `v0.30.0`
the file does not exist at that path at all.

**Filter data drift: additive.** 48 files at `v0.30.0`, 60 at `v0.36.0` and `v0.40.0`,
63 at `v0.44.2`. New tools get new files. Existing files change rarely — `v0.42.4`'s
changelog has exactly one filter fix (`CHANGELOG.md:16`).

This is the decisive shape. **The data contract is frozen. The code around it is not.**

---

## 7. License and telemetry

### License

`LICENSE` is the full Apache License 2.0 text. `Cargo.toml:8` writes it as
`"Apache 2.0"`, which is not a valid SPDX identifier, but the file settles it.
**There is no `NOTICE` file in the repository root.**

Apache-2.0 §4 obligations, and they are the same for the Rust source and for the TOML
data — the TOML files are copyrightable expression and are covered:

- **§4(a)** Ship a copy of the license with the derivative. One `LICENSE` file in the
  vendored directory.
- **§4(b)** Any file we modify must carry a prominent notice that we changed it.
  **Vendoring the TOML unmodified avoids this. Vendoring the Rust and cutting the tail
  triggers it.**
- **§4(c)** Retain the copyright, patent, trademark, and attribution notices in the
  source we copy.
- **§4(d)** If a `NOTICE` file existed we would have to reproduce it. None exists, so
  this is currently moot. It could appear later.
- **§3** carries a patent grant, and a patent-litigation termination clause. Neither is
  a practical concern here.
- The name **rtk** is not licensed by §6. We must not describe our feature as rtk.

### Telemetry — verified, and the ticket's worry is unfounded

Two separate things share the word.

**`[tracking]`, default `enabled = true, history_days = 90`**
(`src/core/config.rs:64-72`, `src/core/constants.rs:6`). This is a **local SQLite
database only**, `~/.local/share/rtk/tracking.db`. It is what `rtk gain` reads. Nothing
leaves the machine because of it. `docs/TELEMETRY.md:139` states the 90-day retention as
client-side.

**`[telemetry]`, default `enabled = false`** (`src/core/config.rs:113-120`; the
`#[derive(Default)]` makes `enabled` `false`, and `src/core/config.rs:278-282` asserts
it). Network telemetry requires **all three** of:

1. Explicit opt-in consent through `rtk init` or `rtk telemetry enable`
   (`docs/TELEMETRY.md:121`).
2. A compile-time endpoint. `const TELEMETRY_URL: Option<&str> = option_env!("RTK_TELEMETRY_URL")`
   — `src/core/telemetry.rs:16`. **If that variable is unset at build time, every
   telemetry code path is dead and the binary makes zero network calls**
   (`docs/TELEMETRY.md:180`).
3. `RTK_TELEMETRY_DISABLED` unset (`docs/TELEMETRY.md:132`).

When it does fire it is one HTTPS POST per 23 hours, on a background thread, 2-second
timeout, dropped silently on failure (`docs/TELEMETRY.md:24-27`). The payload is
aggregate counts and tool names — `docs/TELEMETRY.md:33-107` lists every field.
`docs/TELEMETRY.md:109-117` states that command lines, arguments, paths, and repository
names are not collected. Data controller is "RTK AI Labs", contact `contact@rtk-ai.app`,
GDPR rights documented at `:141-157`.

**For every route in §8 this is moot.** None of it lives in `toml_filter.rs`,
`build.rs`, or the TOML data. Vendoring either the data or the engine carries **no**
telemetry, no tracking database, and no network code. The ticket's flag can be cleared.

The obligation only returns for route B or D — shipping or downloading the upstream
binary — where we would be redistributing a build whose `RTK_TELEMETRY_URL` we did not
set, and where the consent prompt belongs to rtk's installer, not ours.

---

## 8. Verdict, with numbers

### E — vendor the 63 TOML files, write our own engine

**How much Rust do we write?** Mirroring what §3 documents, stage by stage:

| Piece | Lines |
|---|---|
| Deserialize structs (4 types) | 55 |
| Compiled types (4 types) | 40 |
| `parse_and_compile` | 20 |
| `compile_filter`, minus the shadow-warning loop | 75 |
| `find_filter_in` | 8 |
| The eight stages, minus `Lossiness` | ~100 |
| `strip_ansi` + `truncate` | 17 |
| Wiring into the `exec` adapter | ~30 |
| A test harness that runs the 154 inline cases | ~40 |
| **Total** | **~385** |

Add `Lossiness` if we want the overflow-file link — about 45 more, and we already have an
overflow file from ticket 02, so this is likely worth it. Call it **385-430 lines**.

**Other numbers.** 0 new crates. 74 KB / 63 files of vendored data. 154 test cases
inherited as executable data, which is the real prize — they are a conformance suite we
did not write and did not have to translate. Build script optional (§5): one
pre-concatenated file works.

**What we would deliberately not implement:** `replace` and `head_lines`, used by zero
built-in filters (§3). That drops ~35 lines and one whole stage. If a future upstream
filter uses them, the `deny_unknown_fields` behaviour would reject the file loudly rather
than silently mis-apply it — an acceptable failure.

### F — vendor the Rust source into `src-tauri` and cut the tail

**Copied:** 1,968 lines, of which 804 are production and 1,164 are tests. Plus 17 lines
from `utils.rs`.

**Cut:** ~290 production lines —

| Cut | Lines |
|---|---|
| `hooks::trust` plumbing in `load` / `extend_with_trusted` | 36 |
| `collect_match_patterns` trust branch | 21 |
| `run_filter_tests` + `collect_test_outcomes` (rewrite for us) | 118 |
| `RUST_HANDLED_COMMANDS` + `is_rtk_reserved_command` | 58 |
| Shadow-warning loop in `compile_filter` | 12 |
| `REGISTRY` singleton + env-var switches | 45 |

**Written:** ~60 lines of our own registry and loader.

**Net production Rust in our tree: ~510 copied + ~60 written = ~570.**

**What breaks:** at compile time, nothing, once the `hooks::trust` and `constants`
imports go. §2 established the transform path has no other internal dependency. Of the 65
unit tests, the handful that exercise the registry or the shadow warning break; the rest
port unchanged and are worth keeping.

**What it costs:** Apache-2.0 §4(b) attaches — we must mark every modified file as
changed. And we own a permanent diff against a file that moved +330/-59 in two months
(§6). Every upstream fix arrives as a merge, not a file copy.

### C' — fork upstream and add a `lib.rs`

**Less viable than the ticket assumed, and now measurably so.**

Adding `src/lib.rs` re-exporting `core::toml_filter` does not give a small library. Cargo
compiles the crate, not the module. That means:

- All 20 direct dependencies, including **`rusqlite` with `bundled`** — a C compile of
  SQLite inside our Tauri build — plus `ureq`, `flate2`, `quick-xml`, `clap`, `chrono`,
  `sha2`, `getrandom`, `which`, `ignore`, `walkdir`, `colored`, `tempfile`. The engine
  needs 3 of the 20.
- Crate-level settings we would inherit or fight: `[profile.release] panic = "abort"`,
  `[lints.rust] warnings = "deny"`, `rust-version = "1.91"`.
- `automod` in the module tree, so visibility widening is not a one-line change.
- A fork tracked against `develop`, which is three minor versions ahead of the newest
  tag and carries an unreleased rc.
- The telemetry code compiled in, dead but present, which is a question we would have to
  answer every time someone reads our `Cargo.lock` (§7).

C' is worse than F on every axis and better on none. F is C' with the tail already cut
and no build-graph cost. **Rule C' out for good.**

### Which I would pick

**E.**

The margin over F is thin — 385-430 lines written versus 510 copied plus 60 written.
That thinness is itself the finding: **the engine is small enough that "write it" and
"vendor it" cost nearly the same.** So the tie breaks on what we own afterwards, and
there the numbers are not close:

| | E | F |
|---|---|---|
| Rust we maintain | ~400 lines we wrote | ~570 lines, ~510 of them someone else's |
| Tracks a contract that changed in the last 9 releases | No — schema frozen since ≤ v0.36.0 | **Yes — engine +330/-59 in two months** |
| Apache-2.0 §4(b) modified-file marking | No | Yes |
| New crates | 0 | 0 |
| New upstream filter arrives as | a file copy | a file copy |
| Conformance suite | 154 inherited cases | 154 inherited cases + 65 unit tests |

E vendors the frozen thing and writes the moving thing. F vendors the moving thing.
Given §6, that is the whole argument.

E also keeps ticket 11's structural claim intact: the filter runs **after** the command,
inside our `exec`, so the user approves the exact command that runs, and there is no
external binary to be absent.

### Where I am uncertain

1. **The `~100 lines` for the eight stages is an estimate**, not a measurement. Upstream's
   164 lines include `Lossiness` bookkeeping interleaved with the stages. Untangling them
   by eye gives ~100, but I did not write the code. If it comes out at 140 the E-vs-F
   margin closes further and F becomes defensible.
2. **I did not verify how much of the headline saving the 63 TOML filters actually
   deliver.** Ticket 11 already measured that `git status` savings come from the
   `cmds/` half, which E does not take. None of the 63 built-ins covers `git`, `cargo`,
   `npm`, `docker`, or `kubectl` — those names are in `RUST_HANDLED_COMMANDS`
   (`src/core/toml_filter.rs:250-300`), meaning a TOML filter for them would never fire.
   **So E covers gradle, terraform, helm, rsync, shellcheck and friends — not the commands
   a coding agent runs most.** This is the strongest argument against doing E at all, and
   it is an argument about value, not about cost. It deserves its own measurement before
   anyone writes the 400 lines.
3. **I did not re-check crates.io.** Ticket 11's name-collision finding is carried
   forward unverified.
4. **`develop` is not a release.** I read `develop` and confirmed `toml_filter.rs` and
   `src/filters/` are byte-identical to `v0.44.2`, so the citations are safe. I did not
   audit what else differs.
5. **No NOTICE file exists today.** If upstream adds one, §4(d) attaches retroactively to
   any vendored copy we ship after that point.
