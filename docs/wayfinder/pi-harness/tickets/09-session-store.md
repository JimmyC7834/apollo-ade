---
label: wayfinder:grilling
title: Where sessions are stored when there is no Node
parent: ../map.md
blocked-by: [01-execution-env-surface.md]
assignee: jc4649
status: closed
---

# Where sessions are stored when there is no Node

## Question

> **⚠ Read before starting.** Two findings from
> [How this repo depends on pi](07-pi-dependency.md) change what this ticket is looking
> at. (1) pi **0.82.0** replaced `AgentHarness`'s `ExecutionEnv` dependency with
> application-defined `toolContext` values and context-aware `AgentHarnessTool`
> definitions — so `ExecutionEnv` may not be the seam in the 0.83.0 we are pinning.
> (2) The `pi/` clone (`aa0ec808b`) is **ahead of published 0.83.0**, so every line
> number cited below may point at unreleased API. Verify against the pinned tarball
> first. The *shape* of the work is unchanged: Rust holds the authority, TypeScript
> adapts to whatever the current seam is.

The paused map asked whether the session log should be a tree or a line. That question
is **answered by adoption** — pi's log is an append-only tree with `parentId` on every
entry and branch summarization on navigation, and taking pi as a dependency takes its
format. What is left is a smaller, sharper question: where the bytes go.

The constraint: pi's SQLite backend deliberately lives in a **separate package**,
`@earendil-works/pi-storage-sqlite-node`, so that `pi-agent-core` "does not pull in
runtime builtins or native SQLite dependencies by default" (`packages/agent/README.md`).
It is Node-only and therefore unavailable. What *is* browser-safe is
`createInMemorySessionStore` and `createSessionRepository` — both appear in the browser
smoke entry. In-memory means sessions die with the window.

**This ticket is the one most exposed to the version skew above.** The `pi/` clone's
`[Unreleased]` section replaces `SessionStorage`/`SessionRepo` with `SessionRepository`
plus a **caller-owned `SessionStore`** — i.e. the exact seam this ticket wants to
implement was reshaped *after* the 0.83.0 we are pinning. Establish which API the pinned
tarball actually exposes before designing against either.

Settle:

- **What backs the store.** The obvious answer is a `SessionStore` implementation over
  the same Rust filesystem authority as
  [the ExecutionEnv](01-execution-env-surface.md) — which is why this is blocked behind
  it; the error mapping and containment decisions there should not be made twice.
  Confirm the `SessionStore` interface is small enough for that to be cheap.
- **Where on disk.** pi writes to `~/.pi/agent/sessions/<encoded-cwd>/`. Rust is
  root-confined to the workspace, so a global session directory is *outside* the root —
  the same tension [temp files](01-execution-env-surface.md) raise. Decide whether
  sessions live in the workspace (visible, gitignorable, per-project by construction)
  or in a user directory (survives moving the project, requires an exemption from root
  confinement).
- **Whether v1 persists at all.** In-memory is a legitimate v1: it is free, it is
  already browser-safe, and resumption is not obviously on the critical path to
  answering "is this window better." Say so deliberately if that is the choice, because
  the alternative is discovering it by losing a session.
- **Session size.** Claude Code caps reads at 50MB; pi's tree with branch summaries has
  no such cap in evidence. Worth a number.
- **What browser mode does.** Overlaps [What the agent does under `npm run dev`](10-browser-mode-env.md)
  — in-memory is the natural answer there regardless.

Do **not** settle what a mid-session profile switch records here; it is in the map's
fog and graduates once this ticket establishes whether custom entry types can be
appended to pi's session tree at all. Noting that answer is in scope; designing the
switch is not.

---

## Resolution

**JSONL through the Rust filesystem, stored inside the workspace and gitignored. A
profile switch is recorded by name.**

### Facts, from the pinned 0.83.0 tarball

The version-skew warning was justified — the clone's names are not the release's:

- **0.83.0 ships `SessionStorage` and `SessionRepo`.** `SessionRepository` plus a
  caller-owned `SessionStore` is the *unreleased* rename visible in `pi/`. Code against
  the pinned names.
- **`JsonlSessionStorage` needs only four filesystem methods**:
  `Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">`
  (`harness/session/jsonl-storage.d.ts`). It is constructed by
  `JsonlSessionStorage.open(fs, filePath)` / `.create(fs, filePath, {cwd, sessionId,
  parentSessionPath?, metadata?})` — so persistence is a *narrow* dependency on the same
  adapter [ticket 01](01-execution-env-surface.md) already builds, not a new subsystem.
- **`InMemorySessionRepo` ships browser-safe**, with `create` / `open` / `list` /
  `delete` / `fork`. Dev mode is covered with no work, per
  [browser mode](10-browser-mode-env.md).
- **Forking is supported** at the repo level: `fork(metadata, {entryId?, position?, id?})`.
- **`CustomEntry<T> { type: "custom", customType: string, data?: T }` exists in the
  `SessionTreeEntry` union**, alongside `ModelChangeEntry`, `ThinkingLevelChangeEntry`
  and `ActiveToolsChangeEntry`. Arbitrary typed entries are first-class, and
  `appendEntry` is public.

### Decisions

1. **Sessions persist as JSONL, backed by the Rust filesystem adapter.** Only four
   methods are needed, all of which the adapter has for other reasons. There is no case
   for in-memory-only persistence when the cost is this small.
2. **Files live inside the workspace, gitignored** — e.g. `.ade/sessions/`. Decisive
   reason: it is reachable by the root-confined resolver with **no exemption**, unlike a
   `~/.ade/` location which would need a second confined area and its own resolver. It is
   also inspectable in the editor being built, and per-project by construction. The
   accepted costs: sessions do not follow a project that is moved or re-cloned, and the
   gitignore entry must actually be added.
3. **A mid-session profile switch records the profile *name*, not a resolved snapshot.**
   The consequence must be stated rather than discovered: **a later edit to a profile
   changes what history claims to have run under, and a deleted or renamed profile makes
   an old session unreplayable.**

   What makes this defensible is consistency with
   [the profile data model](04-profile-data-model.md), which already decided a dangling
   reference **refuses activation** rather than degrading silently. The same posture
   applies on replay: refuse and say what is missing, rather than reconstruct something
   plausible. A session that cannot be replayed honestly is better than one replayed
   wrongly.
4. **Most of a switch is recorded by entries pi already ships.** `model_change`,
   `thinking_level_change` and `active_tools_change` cover three of the eight profile
   fields with no custom type at all. A single `CustomEntry` with
   `customType: "profile_switch"` and `data: { name }` carries the rest.
5. **Session size gets a cap.** Claude Code caps reads at 50 MB; pi's tree with branch
   summaries has no cap in evidence. Pick a number and surface exceeding it as the
   `error` kind rather than discovering it as a hang.

### Fog graduated

The map's **mid-session switch** item is partly resolved here — the mechanism exists and
the snapshot-vs-reference question is answered. What remains is genuinely separate and
becomes [What a profile switch leaves behind](14-switch-aftermath.md).
