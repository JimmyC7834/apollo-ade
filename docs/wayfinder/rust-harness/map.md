---
label: wayfinder:map
title: Rust agent harness for the ADE
status: paused
---

# Rust agent harness for the ADE

> **Paused.** The dev redrew the approach: pi becomes a *dependency* rather than a
> design reference, so the harness is no longer something this repo writes in Rust.
> Superseded by a new map — see [the wayfinder index](../README.md). No ticket here
> was resolved before the pause; several questions survive the change and are expected
> to be re-cut against the new destination rather than reused verbatim. Nothing here
> is deleted: if the pi dependency is later rejected, this is the fallback route.

## Destination

A **Rust agent harness living in `src-tauri`**, owned by this repo, design-referenced
from pi and Claude Code — agent loop, tools, session persistence, compaction, skills
and system-prompt assembly — with **profiles** as a first-class feature: a user-defined
preset of skills / tools / system prompt / extensions that a session starts under and
can switch to mid-run.

The ADE's chat panel is its first consumer. The map is done when every decision needed
to *build* that harness is made — not when the harness is built.

## Notes

- **Domain**: Rust, Tauri, agent harness architecture.
- **Reference material already in-repo — read before charting anything new:**
  - `docs/RESEARCH-agent-harnesses.md` — pi vs. Claude Code teardown, cited to source.
  - `docs/claude-code-how-it-works.md` — Claude Code internals, cited to source.
  - `docs/RESEARCH-zed-harness.md` — **Zed's Rust harness**, read from source at commit
    `f86d898`. The closest prior art by a distance: a Rust harness in a desktop app that
    already ships the profile feature. Read this before any ticket touching profiles,
    tool schemas, or the UI boundary.
  - `pi/packages/agent/src/harness/` — the 8,187-line TS harness being referenced.
  - `context.md` — this repo's standing architecture rules. They bind.
- **Skills**: `/grilling` and `/domain-modeling` are the default for every ticket here.
  `/prototype` for the spike.
- **Standing constraints from `context.md`** (these are not up for quiet renegotiation;
  deviate only in the open and record it):
  - Rust is the only filesystem/process authority; it stays root-confined.
  - Feature code consumes domain interfaces; it never calls Tauri directly.
  - Every native capability gets a deterministic browser implementation, so the UI
    runs under `npm run dev` with no native process. **The existing scripted
    `AgentProvider` in `src/agent.ts` is that implementation — it does not get deleted
    when the real harness lands.**
- **Design decisions already taken, before any ticket:**
  - Destination is the *harness as artifact* (B), not "make the chat panel real by any
    means". Shelling out to `pi` or `claude -p` is therefore ruled out.
  - Profile switching is **non-retroactive**: a switch applies to subsequent calls only;
    prior history is never rewritten. Zed independently arrived at the same rule —
    only the current profile id is persisted, and superseded tool calls stay verbatim
    in the transcript (`docs/RESEARCH-zed-harness.md` §3).
  - **The profile wanted here is a superset of Zed's.** Zed's profile carries tool
    toggles and a default model only — no system prompt, no skills, no extensions, no
    permissions. Three of the four things this effort wants in a profile are things Zed
    deliberately left out, and that gap is where the cost lives. "Like Zed's profile" is
    the right *shape*, not the right *scope*.
- **Planning only.** Every ticket resolves a decision. The one prototype ticket exists
  to answer a design question, not to ship the harness.

## Decisions so far

<!-- one line per closed ticket -->

_None yet._

## Not yet specified

- **Extension mechanism.** Deliberately deferred by the dev. The choice — embedded
  script runtime (Rhai / Lua / QuickJS / `deno_core`), WASM components, subprocess +
  JSON protocol à la Claude Code hooks, or native `dylib` — is the largest unknown on
  this map, and it collides head-on with the root-confinement rule in `context.md`:
  an in-process extension mechanism punches straight through that sentence. Profiles
  reference extensions, so this cannot stay fog forever; it graduates once the profile
  data model exists to say *what* an extension plugs into.
- **Skills: format, discovery, and loading.** pi loads skills into the system prompt up
  front; Claude Code loads bodies only on invocation and can discover them dynamically
  during file operations. Which model applies here depends on the compaction decision.
- **System-prompt assembly.** What composes into it, in what order, and how a profile
  overrides vs. appends. Blocked behind the profile data model.
- **Cancellation and abort semantics** below the UI boundary — mid-stream, mid-tool,
  mid-bash-child. Sharp once the harness/UI boundary is settled.
- **Run caps.** pi ships none; Claude Code has `maxTurns` and `maxBudgetUsd`. Whether
  this harness has any, and whether they are per-profile.
- **Session fork / branch as a user-facing feature.** Distinct from the storage question
  of whether the log is a tree; this is about whether the ADE surfaces it at all.

## Out of scope

<!-- ruled beyond the destination; never graduates -->

- **Porting pi's `packages/ai` wholesale** (~21,000 lines, ~45 providers, 10 wire APIs).
  That is a second product, not a harness. The provider *seam* is in scope; the provider
  *library* is not. Exact v1 breadth is settled by
  [How many providers does v1 speak?](tickets/03-provider-scope.md).
- **MCP support.** pi omits it deliberately; adding it is its own effort.
- **Remote / multi-client sessions** (pi's `packages/server` + `packages/client`, marked
  experimental upstream).
- **A TUI.** The ADE is the surface.
