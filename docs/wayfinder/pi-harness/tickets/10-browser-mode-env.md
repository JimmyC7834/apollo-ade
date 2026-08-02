---
label: wayfinder:grilling
title: What the agent does under `npm run dev`
parent: ../map.md
blocked-by: [01-execution-env-surface.md]
assignee: jc4649
status: closed
---

# What the agent does under `npm run dev`

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

`context.md` is unambiguous: *"Every native capability gets a deterministic browser
implementation so the UI runs under `npm run dev` with no native process."* The agent is
about to become a native capability. This ticket says what the browser side of it is,
before the rule gets broken by accident.

The rule has teeth in this repo — the browser pane at `localhost:5190` is how most of
the UI work gets done, and `context.md` also warns it is *not* equivalent to the native
window. And there is an existing answer already written down: the map's Notes record
that the scripted `AgentProvider` in `src/agent.ts` **is** the browser implementation
and does not get deleted.

Settle:

- **Is the scripted provider still the answer, or does browser mode get a real agent?**
  Two coherent positions. Keeping the script means dev mode never talks to a model —
  cheap, deterministic, and it keeps the existing `.check.ts` tests meaningful. Giving
  browser mode a real agent means implementing `ExecutionEnv` a second time against the
  File System Access API, which the repo already has provider code for (and which
  `docs/OPEN-ISSUES.md` flags as first-run code past the picker).
- **If the script stays, does it have to keep up?** This is the sharp part. If
  [the event contract](05-event-contract.md) grows to carry real tool calls, the
  scripted provider must grow too or it stops implementing the interface — and the rule
  quietly dies while appearing to be satisfied. Decide who is responsible for that and
  how it is checked. A `.check.ts` asserting both providers satisfy the same contract is
  the obvious mechanism; this repo already writes those.
- **A third option worth pricing:** an in-memory `ExecutionEnv` — pi's contract is a
  plain interface, so a fake filesystem backed by a `Map` is genuinely small, and it
  would let the *real* pi loop run in dev mode against fake files with a fake
  `streamFn`. That tests far more of the real code path than a script does, and it is
  deterministic. It is also a third implementation to maintain.
- **What `exec` does in browser mode.** There is no honest browser implementation of
  running a process. Decide whether it errors, returns a canned result, or the tool is
  absent from the tool set — and note that "absent" interacts with profiles.

---

## Resolution

**Dev mode runs the *real* pi loop against a fake provider and an in-memory filesystem.
The scripted provider is deleted.**

### Why this became the obvious answer

Three closed tickets pushed the same direction, none of them intending to:

- [The event contract](05-event-contract.md) grew the seam to **eleven kinds**. Faking
  eleven kinds convincingly by hand is substantially harder than faking five, and a
  hand-written script drifts from the real mapping silently.
- [Credentials](06-credentials-and-http.md) put the key in Rust, so **dev mode has no key
  and cannot reach a model** regardless. A fake model is not a compromise here; it is the
  only thing that can run.
- That same ticket's correction found the seam: `createProvider({ api: ProviderStreams })`
  where `ProviderStreams` is two methods returning an `AssistantMessageEventStream`
  (`pi-ai/dist/types.d.ts:161`). **A Rust-backed provider and a canned provider are two
  implementations of one small interface.** Dev mode is not a special case in the
  architecture — it is the second implementation of a seam we already have to build.

### The shape

```
native:   AgentHarness + ProviderStreams->Rust->model API + ExecutionEnv->Tauri->Rust
dev:      AgentHarness + ProviderStreams->canned stream   + ExecutionEnv->Map
```

Real harness, real tools, real event mapping, real profile and gate logic. Only the
model and the filesystem are fake, and each behind an interface that has to exist anyway.

### Decisions

1. **Delete the scripted provider in `src/agent.ts`.** It was written when there was no
   real harness to run, and it earned its place then — the comment about cancellation and
   approval being the hard parts was correct and shaped the contract we kept. It is now
   the weaker option on every axis: more code, less coverage, and a second thing to keep
   in step with an eleven-kind contract.

   **This revises a standing promise.** The map's Notes and `context.md`'s spirit both
   record that this file *is* the deterministic browser implementation and is not
   deleted when pi lands. That promise is being revised deliberately and in the open, as
   `context.md` requires: the rule was "every native capability gets a deterministic
   browser implementation", and this satisfies it **better**, because the browser path
   now exercises the real code. The map's Notes must be updated, not quietly left
   contradicting this.
2. **The in-memory `ExecutionEnv` is backed by a `Map`.** pi's contract is a plain
   interface with a documented never-throw invariant, so a fake filesystem is small — and
   it is genuinely useful beyond dev mode, as the substrate for tests of anything that
   touches files.
3. **The canned `ProviderStreams` must be deterministic**, in the sense the deleted
   script was: the same prompt yields the same stream. That property is what made
   cancellation and approval reasoning tractable, and it should not be lost along with
   the file that had it.
4. **`exec` in dev mode returns a `shell_unavailable` `ExecutionError`.** There is no
   honest browser implementation of running a process, and
   [`exec`](02-exec-not-terminal.md) already established `shell_unavailable` as a real
   runtime state rather than a theoretical code — so this path gets exercised in dev
   rather than only on a machine without Git Bash. Faking success would teach the agent
   things that are not true.
5. **A `.check.ts` asserts both providers satisfy the same contract.** This repo already
   writes those, and it is the mechanism that keeps the two `ProviderStreams`
   implementations honest as the eleven kinds evolve.

### What this costs

The fake provider and in-memory env are new code that did not exist before, so this is
not a pure deletion — roughly 140 lines removed against somewhat more added. The
argument is not that it is smaller; it is that the added code is **on the real path**,
where a bug in the mapping layer surfaces in `npm run dev` instead of only in the native
window, which `docs/OPEN-ISSUES.md` shows is the harder place to observe anything.
