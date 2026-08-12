# 32 — Diagnostics, without a protocol

**Blocked by:** none — can start immediately.
**Status:** **landed.** See [Landed](#landed).

## Why this is separate from LSP

The dev listed diagnostics and an LSP adaptor together. They are kept apart here on
purpose, and the reason is a measurement rather than a preference: **for TypeScript,
diagnostics is not an LSP feature at all.**

`ts.worker` is already in the bundle — 6,045 kB of it, the single largest asset this app
ships — and it is already computing exactly these markers for every open file, because
that is how Monaco underlines a type error today. The work is a listener and a place to
put them.

That buys diagnostics for the language this repo is written in, at close to no cost, with
no server to launch and nothing to install. [Ticket 33](33-lsp-adaptor.md) is what buys
Rust and everything else, and it is much larger. **This one must not wait for it.**

## What to build

A problems surface: errors and warnings for the workspace, grouped by file, clicking one
opens the file at the line.

The catch worth knowing before starting: Monaco's TS worker only knows about **models that
are open**. A file nobody has opened has no markers, so "problems in the workspace" is
really "problems in what you have looked at" unless models are created for more than the
open tabs. Decide which of those two this is and say so in the UI — a problems panel that
silently reports on a subset is worse than one that says what it covers.

## What it is worth beyond the human

The agent currently learns about type errors by running `tsc` through `bash` and reading
the output. Markers the app already has are cheaper and more precise. Exposing them to the
agent is **not** in this ticket — but do not build a surface that makes it awkward later.

## Acceptance criteria

- [x] Errors and warnings for open files appear in a problems surface, grouped by file.
- [x] Selecting one opens the file at that position.
- [x] The count updates as the file is edited, without a manual refresh.
- [x] The scope — open files only, or wider — is decided, stated in the UI, and recorded
      here.
- [x] The panel is reachable by keyboard and its rows are announced; recorded as
      structural in `OPEN-ISSUES.md` like every other accessibility claim here.
- [x] No new dependency and no new bundle weight. If either is needed, that is a sign this
      belongs in ticket 33 instead.

## Landed

**The scope is open files, and the panel says so in its first line.** That is the
decision the ticket asked to have made and recorded, so here is the reasoning
rather than only the answer.

The alternative — creating a Monaco model for every file in the tree so the TS
worker sees the whole project — was rejected, not skipped. It would parse and
typecheck the entire project inside the WebView on every workspace open, hold
every file in memory for as long as the window is up, and still produce wrong
answers for files whose imports the worker cannot resolve. That is
[ticket 33](33-lsp-adaptor.md)'s job, done properly by a server outside the
renderer, and a worse version of it here would make the honest one harder to
arrive at.

The wording matters more than the fact: *"Nothing else has been looked at — a
file no editor has opened is not checked."* The useful reading of an empty
problems list is "nothing is wrong", and without that sentence it would be a lie.

**No new dependency and no new bundle weight**, which the ticket set as the test
of whether this belonged here at all. `ts.worker` was already computing these
markers — that is how a type error gets underlined — so the work was a listener
and somewhere to put the results.

**The one thing that needed building was identity.** Markers arrive addressed by
model URI, and a model's URI here is whatever Monaco generated
(`inmemory://model/3`). Giving models a URI derived from the file id is the
obvious fix and does not work: the same file can be open in the Modal Workbench
and pinned in the dock at once, and `createModel` throws on a duplicate URI. So
`modelRegistry` records the mapping instead, many-to-one, and `groupProblems`
deduplicates the identical markers that two models over one path produce.

**Not done, deliberately:** exposing markers to the agent, which the ticket
explicitly placed out of scope. `problems.ts` imports no Monaco and takes
severities as numbers, so a second source — or a consumer that is not the UI —
adds no shape it does not already have.

**Verified live** in browser mode: an empty file, then a type error typed into it
(count 0 → 1), then a second edit that added two more (1 → 3, no refresh), then a
correction (3 → 0). Clicking a problem opened the file at its line.
