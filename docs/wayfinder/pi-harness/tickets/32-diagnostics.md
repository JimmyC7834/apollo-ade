# 32 — Diagnostics, without a protocol

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent.

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

- [ ] Errors and warnings for open files appear in a problems surface, grouped by file.
- [ ] Selecting one opens the file at that position.
- [ ] The count updates as the file is edited, without a manual refresh.
- [ ] The scope — open files only, or wider — is decided, stated in the UI, and recorded
      here.
- [ ] The panel is reachable by keyboard and its rows are announced; recorded as
      structural in `OPEN-ISSUES.md` like every other accessibility claim here.
- [ ] No new dependency and no new bundle weight. If either is needed, that is a sign this
      belongs in ticket 33 instead.
