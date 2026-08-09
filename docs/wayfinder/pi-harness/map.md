---
label: wayfinder:map
title: pi as the ADE's built-in agent
---

# pi as the ADE's built-in agent

## Destination

`@earendil-works/pi-agent-core` running **in-process in the WebView** as the ADE's
built-in agent, with a **Tauri `ExecutionEnv`** behind it so Rust stays the only
filesystem and process authority — plus two features pi's core does not have:
**profiles** (a named preset of model / tools / system prompt / rtk policy that a
session runs under and can switch to mid-run), a **permission gate** on tool calls, and
**user-authored tools** — the user can add their own, as pi's native agent allows.

The map is done when every decision needed to *build* that is made — not when it is
built.

That line held: all seventeen charted tickets closed. Two things it did not anticipate
followed. [Ticket 18](tickets/18-tool-reaches-the-gate.md) is a decision charting could
not have raised, because it fell out of *building* — now closed.
[Ticket 19](tickets/19-model-entries.md) is the opposite failure and the more instructive
one: the map stated the obligation plainly in its own Notes and no ticket ever owned it,
so it survived seventeen closures by belonging to none of them. Both are now closed. A
closed map is not a finished one — and "every decision is made" is only true of the decisions
something was accountable for making.

## Notes

- **Domain**: TypeScript, Tauri/Rust, agent harness architecture.
- **Planning only.** Every ticket resolves a decision. The one prototype ticket exists
  to falsify a contract, not to ship the harness.
- **Skills**: `/grilling` and `/domain-modeling` are the default for every ticket.
  `/prototype` for the spike, `/research` for the two research tickets.
- **Reference material already in-repo:**
  - `pi/packages/agent/src/harness/types.ts` — the `ExecutionEnv` contract being
    implemented. Read before any adapter ticket.
  - `pi/scripts/check-browser-smoke.mjs` — the CI gate that makes this whole plan
    viable. Read it to know exactly what pi guarantees is browser-safe.
  - `pi/packages/coding-agent/examples/extensions/preset.ts` (392 lines) and
    `permission-gate.ts` — **reference implementations, not importable** (see below).
  - `pi/docs/` — `extensions.md` (117KB), `rpc.md` (40KB), `sdk.md` (35KB),
    `compaction.md`, `security.md`.
  - `docs/RESEARCH-zed-harness.md` — Zed's profile feature, the closest shipped prior
    art. Read before any profile ticket. **The Zed source itself is checked out at
    `../../zed`** relative to this repo — `crates/agent_settings/src/agent_profile.rs`
    and `crates/settings_content/src/agent.rs` are the profile definition, confirmed
    first-hand rather than via the research doc.
  - `docs/RESEARCH-agent-harnesses.md`, `docs/claude-code-how-it-works.md`.
  - `context.md` — this repo's standing rules. They bind.
- **Standing constraints from `context.md`** (deviate only in the open, and record it):
  - Rust is the only filesystem/process authority; it stays root-confined.
  - Feature code consumes domain interfaces; it never calls Tauri directly.
  - Every native capability gets a deterministic browser implementation, so the UI runs
    under `npm run dev` with no native process. **Revised by
    [ticket 10](tickets/10-browser-mode-env.md):** this map originally promised the
    scripted `AgentProvider` in `src/agent.ts` would survive as that implementation. It
    is now **deleted** — dev mode runs the *real* harness against a canned
    `ProviderStreams` and an in-memory `ExecutionEnv`, which satisfies the rule better
    because the browser path exercises the real mapping code rather than a parallel
    fiction. The revision is recorded rather than taken quietly.
- **⚠ Correction — the charting below is one release stale. Read this first.**
  [How this repo depends on pi](tickets/07-pi-dependency.md) established two things that
  undercut how several tickets are worded. Neither changes the destination; both change
  what the tickets are looking at.
  - **`ExecutionEnv` may no longer be the seam.** pi **0.82.0** — five days before the
    0.83.0 we are pinning — "replaced `AgentHarness`'s `ExecutionEnv` dependency with
    application-defined `toolContext` values and context-aware `AgentHarnessTool`
    definitions." Tickets 01, 02, 09 and 10 are all written as "implement
    `ExecutionEnv`." **The first job of [ticket 01](tickets/01-execution-env-surface.md)
    is now to establish what the seam actually is in the pinned version.** The shape of
    the work — Rust holds the authority, TypeScript adapts to it — is unaffected.
  - **The `pi/` clone is *ahead* of what we would install.** `aa0ec808b` sits past
    published 0.83.0: its `[Unreleased]` section replaces `SessionStorage`/`SessionRepo`
    with `SessionRepository` plus a caller-owned `SessionStore`. **Every line number
    cited on this map points at possibly-unreleased API.** Verify against the pinned
    tarball before relying on any of them.
  - **Upstream moves fast and breaks things**: 39 releases in 83 days (~one every 2.1
    days), and five of ten minor lines carry documented breaking changes, with a sixth
    staged. `pi-ai` breaks in *patches*. This is why the resolution says pin, and why it
    says wrap pi's interfaces in our own rather than implementing them directly.
  - **Getting the pinned source to read.** Neither the clone nor the tarballs are
    committed — a published npm version is immutable, so they are reproducible rather
    than worth storing:

    ```bash
    npm pack @earendil-works/pi-agent-core@0.83.0 @earendil-works/pi-ai@0.83.0
    ```

    Unpack and read `dist/`. **Read the tarball, not `pi/`** — that is the whole point of
    the bullet above.
- **Facts established before charting** (verified in-repo, not assumed):
  - pi splits cleanly. `packages/agent/src/node.ts` is **88 bytes** — it exports
    `NodeExecutionEnv` and re-exports the browser-safe index. That one class is the
    *entire* Node surface of the agent core.
  - `ExecutionEnv = FileSystem & Shell` (`types.ts:373`): 16 filesystem methods plus
    `cwd`, and one `exec`. Operation methods **must never throw or reject** — every
    failure is a `Result`.
  - **pi's extension layer is not available to us.** `preset.ts` and
    `permission-gate.ts` live in `pi-coding-agent`, and the extension host
    (`src/core/extensions/`) imports `pi-tui` four times plus `node:module`,
    `node:fs`, `node:url`, `node:path` — `node:module` because it dynamically requires
    extension files off disk. They are prior art to read, not code to import. Profiles
    and the gate are built here, against the React UI.
  - **Corrected by [ticket 01](tickets/01-execution-env-surface.md): only the extension
    *host* is unavailable, not the hook substrate.** `pi-agent-core` ships a 22-event
    hook system in the browser-safe core, eight events returning values that change
    behaviour — including `tool_call -> ToolCallResult { block?, reason? }`, which is
    exactly what the TUI layer's `permission-gate.ts` returns. What is Node-bound is the
    loader that reads user scripts off disk, not the seam they plug into.
- **Decisions already taken, before any ticket:**
  - pi is a **dependency**, not a design reference and not a sidecar. The alternative
    routes — porting the harness to Rust, and driving `pi-coding-agent` as a Node
    subprocess over its RPC surface — were both considered and set down.
  - rtk is a **per-profile setting**, not a transparent wrapper and not a model-facing
    tool. This blocks rtk behind the profile data model.
  - Profile switching is **non-retroactive**: a switch applies to subsequent calls;
    prior history is never rewritten. (Zed independently arrived at the same rule —
    `docs/RESEARCH-zed-harness.md` §3.)
  - **Take as much from pi's packages as they will give.** A standing preference, stated
    by the dev while grilling skills and applying backwards to everything already built:
    where pi ships the machinery, adopt it rather than write a parallel one — and read
    `pi-coding-agent` as well as the core, because the client has already met most of
    these problems. This is [ticket 15](tickets/15-core-already-does-this.md)'s "machinery
    in, entries ours" promoted from a finding to a rule. It has a hard limit and only one:
    where pi's mechanism assumes something this app does not have — chiefly a filesystem
    with no boundary — the mechanism does not transfer and the *data* still does.

    **Audited against every export, once, after the rule was written.** The built-in
    tools, the gate's `tool_call` hook, `clampThinkingLevel`, `shouldCompact`,
    `loadSkills`, both formatters and every harness setter were already taken. Three
    places were not, and all three were reuse *missed* rather than reuse rejected:
    - `calculateContextTokens` — `events.ts` read `usage.totalTokens` raw. pi falls back
      to `input + output + cacheRead + cacheWrite`, so a provider that omits the total
      reported **zero** context tokens: the meter sat at 0% and auto-compaction could
      never fire. The comment claiming the fallback was not "a richer number" was right
      about the arithmetic and wrong about what happens when the field is missing.
    - `truncateTail` / `sanitizeBinaryOutput` — a **user tool** calls `agent_exec`
      directly, so pi's bash tool is not in the path and neither was its 2000-line /
      50 KB cap. The only limit left was Rust's 8 MiB transport guard, which is a
      transport guard and not a context-window one. A tool that ran a build printed the
      whole log into the model's context. Now capped by pi's own numbers, keeping the
      end, which is where a failing command says why.
    - `loadSourcedSkills` — [ticket 20](tickets/20-skills.md) called `loadSkills` once
      per directory and said pi's result "carries no provenance", in a file whose own
      header cites `loadSourcedSkills` as existing for exactly this. One call now tags
      both skills and diagnostics.

    Two things were unused and neither was a rewrite. **`loadPromptTemplates`** and its
    four companions — adopted whole in Slice 35; see the command-system entry below. And **`steer` / `followUp` /
    `nextTurn`**, which is the larger of the two and is now
    [ticket 22](tickets/22-steering.md): the composer is dead for the whole of a turn
    while pi ships three queues, a `queue_update` event and two queue modes. Nothing
    else in the two packages is something this repo has written a second time.

## Decisions so far

<!-- one line per closed ticket -->

- **The walking skeleton closed, and nothing upstream reopened.**
  [Thinnest end-to-end turn](tickets/12-walking-skeleton.md)
  closed a real loop against DeepSeek in the native window — streamed prose, a `read` tool
  call, tool result, grounded answer — so the twelve-kind event contract and the
  `ExecutionEnv` adapter both survived contact. Since verified against Google as a second
  provider, which is what exposed two defects a single provider had hidden. Still open:
  `usage` and `compacted` never fire because the spike's UI adapter drops them, and
  `thinking` is inconclusive for the same reason. **Local models could not
  run it at all** — they emit tool calls as prose, which is a template limitation, not a
  pi one, and it constrains any offline story.
- **The credential path is built and measured.**
  [Who holds the API key](tickets/06-credentials-and-http.md) is confirmed: Rust makes the
  HTTPS call, the key never enters JavaScript, and streamed bytes cross the IPC
  incrementally — 14 chunks over 722 ms, not one buffered lump. The injection point turned
  out to be `options.fetch` rather than `ProviderStreams.stream`, which makes the whole
  integration small with pi unmodified. **Amended by a second provider**: the seam is
  `globalThis.fetch` scoped by host, not `ProviderStreams` — the Google adapters refuse an
  injected `fetch` and accept only the global. Verified against DeepSeek and Google; still
  an environment variable rather than `keyring`.
- **⚠ pi's bundled model catalogs go stale, and pinning does not help.** Probing Google
  turned up that `gemini-2.5-flash` — which pi 0.83.0 ships in `GOOGLE_MODELS` — returns
  `404: no longer available to new users` for a newly issued key, and `googleProvider()`
  passes no `fetchModels` to refresh it. **A new user's key cannot call the models pi
  advertises.** This is a different failure from the churn
  [ticket 07](tickets/07-pi-dependency.md) guards against: pinning protects us from
  upstream changing, not from the world moving underneath a frozen catalog. Whatever ships
  needs a live model list or an honest failure when a catalogued model is gone.
  **Now assigned** — [ticket 19](tickets/19-model-entries.md). This obligation sat
  unowned through seventeen closed tickets because it reads as one problem and is three:
  *existence* (probably already answered, since we advertise no list), *capability*
  (`reasoning` is guessed from the model id, and a wrong guess silently clamps thinking
  to `off`), and *cost* (zeroed, and honestly so while nothing displays it).

- [What pi costs in the bundle](tickets/08-bundle-cost.md) — acceptable: one provider
  adds **8.8% gzip** over a build Monaco already dominates. The ~21k-line `pi-ai` was
  the wrong suspect; it treeshakes. Import providers **by subpath, never the barrel** —
  `/compat` is a 4.6× regression — and add a repo-side bundle guard. **Amended:** the
  dev ruled all providers in scope (448 kB gzip acceptable); dynamic `import()` per
  subpath delivers that at the 62 kB floor, and the static-vs-dynamic choice belongs to
  the profile data model.
- [How this repo depends on pi, and what happens when pi moves](tickets/07-pi-dependency.md)
  — **exact-pinned npm dependency**, not a submodule (browser-safety is a *publish*
  gate, so every published version already passed it). Pin and upgrade deliberately;
  wrap pi's interfaces in our own; gitignore `pi/`; ship pi's MIT text ourselves.

- [What the Tauri ExecutionEnv actually implements](tickets/01-execution-env-surface.md)
  — **take pi's built-in tools**; the harness itself has no filesystem opinion, so
  `ExecutionEnv` is opt-in and buys read/write/edit/bash. Implement **9 methods, not
  16**; stub the rest. Containment through one guarded Rust resolver; `canonicalPath`
  refuses to resolve outside the root.

- [How `exec` runs a command without becoming the terminal](tickets/02-exec-not-terminal.md)
  — one-shot Rust command, **cwd-confined but not command-confined** (an open, recorded
  deviation from `context.md`; containment moves to the gate). Detect the shell,
  prefer Git Bash. Stream over a Tauri v2 `Channel`; abort kills the process *tree*;
  overflow temp file lives inside the workspace so `read` can reach it.

- [What stops a tool call](tickets/03-permission-gate.md) — **auto by default**, with a
  floor auto cannot cross (writes outside root refused in Rust; a short deny list for the
  irreversible, documented as a foot-gun guard and *not* a boundary) plus a **git
  checkpoint per turn** as the real safety net. TypeScript asks, Rust enforces — forced
  by user-authored tools. The ask path ships in v1 even though the default never fires
  it. Gate policy is a profile field.

- [What is a profile, concretely?](tickets/04-profile-data-model.md) — **eight fields**
  (name, model, thinkingLevel, tools, instructions, skills, rtk, gatePolicy). `tools` is
  a **map**, not a list, following Zed — it degrades correctly as pi's tool set moves.
  Dangling references **refuse activation**. All fields are mutable mid-session; pass
  `systemPrompt` as a **callback**, since there is no setter. Providers bundle
  statically. Ship built-in profiles users override. **Now shipped** as
  `src/agent/profile.ts` with three built-ins and a `/profile` command, verified live:
  `plan` leaves the model holding `read, bash` mid-session, and a switch to `careful`
  makes the very next turn ask. **Now complete**: profile files ship as a global
  `profiles.json` behind its own one-fixed-path Rust command — the workspace resolver
  refuses everything above the root — plus `ade.profiles.json` at the project root,
  merged field by field with the project winning, and **Rust refuses agent writes to
  it**, because profile membership is the trust act for tools and `gatePolicy` is a
  profile field. Read-only by choice; there is no editor. `setModel` on switch landed
  with them, which exposed that only the *active* provider had ever been registered
  with pi's model registry — a profile on a second provider would have failed a turn
  after the switch rather than at it.

- [Where pi's event stream meets the ADE](tickets/05-event-contract.md) — `activity` is
  retired for a **structured tool lifecycle**; **eleven kinds** (text, thinking,
  tool_start/update/end, approval, usage, compacted, error, complete, cancelled). The
  transport question dissolved — pi runs in the renderer, so the mapping is in-process.
  The seam stays ours; providers adapt down to it.

- [Who holds the API key, and who makes the HTTPS call](tickets/06-credentials-and-http.md)
  — **Rust makes the call** via an injected `StreamOptions.fetch`; the key never enters
  JS. Forced by user-authored tools sharing the renderer. Pin `transport: "sse"` (a
  custom fetch does not cover websockets). **API key** behind a Rust resolver seam, so
  env-var now and OS keychain later needs no TypeScript change. OAuth is a later
  additional resolver. **The keychain is deferred, not now** (grill): it becomes worth
  doing when a second person runs the app, and the resolver seam means waiting costs
  nothing.

- [What the agent does under `npm run dev`](tickets/10-browser-mode-env.md) — dev mode
  runs the **real pi loop** against a canned `ProviderStreams` and a `Map`-backed
  `ExecutionEnv`; `exec` returns `shell_unavailable`. **The scripted provider is
  deleted** — a revision of this map's own promise, made in the open.

- [Where sessions are stored when there is no Node](tickets/09-session-store.md) —
  **JSONL through the Rust adapter**, files **inside the workspace, gitignored** (no
  containment exemption needed). Only four FS methods required. A switch records the
  profile **name**, not a snapshot — consistent with refusing dangling references rather
  than reconstructing history. `CustomEntry` is confirmed, so custom entries are
  first-class.

- [How rtk becomes a profile setting](tickets/11-rtk-in-profile.md) — **`rtk: boolean`**,
  applied in the bash tool's `prepare` hook (not `commandPrefix`, which is a preamble
  line). pi's ordering means **the gate sees the original command and rtk rewrites after
  approval** — defensible only while rtk is semantically transparent. Absent or failing
  rtk falls back to the raw command and says so once. **Amended, and the mechanism is
  deferred**: the field shape stands, but rtk is **binary-only and not on crates.io**
  (that name is the collision), and it splits into a Rust half that *spawns and
  reformats* and **97 declarative TOML filters** that only strip noise from output
  already captured. Five routes are on the ticket with their costs; the one that needs no
  distribution or security question settled first is **vendoring the filter data and
  running it in our own exec adapter**, which moves rtk from before the command to after
  it and dissolves the approval mismatch.

- [How a user adds their own tool](tickets/13-user-authored-tools.md) — **built.** A
  **declarative manifest** for v1 (schema + argv array), versioned with a `runtime`
  discriminator so Worker-hosted scripts slot in later. Renderer scripts are out on
  evidence: Tauri capabilities are per-*window*, so any renderer code reaches every
  command. **Tools are not gated — profile membership is the trust act — and the gate
  moves below the tool layer onto commands and destructive actions.** Trust does not lift
  the floor: the deny list is checked against the resolved argv. **Amended**: the manifest
  declares **argv, not a command string** — parameters fill whole argv slots and are never
  shell-parsed, closing an injection hole. Rewriting pi's built-ins into the same format
  was considered and rejected; what is shared is the Rust floor, not the tool format.
  Shipping corrected one thing: ticket 04's "an unmentioned tool is on" is right for
  tools pi adds and wrong for tools a user writes, so **user tools are opt-in** and a
  manifest on disk is not a trust decision. Manifests live in the profile files, so the
  tool and the profile that names it are authored together.
- [What the system prompt is made of](tickets/17-system-prompt-assembly.md) —
  **`instructions` appends, only appends**, and the order is base → instructions →
  skills → **shell and workspace facts last**. That inverts the ticket's own premise:
  pi protects the floor by putting it last, not first. Grilling turned up that pi answers
  this at *three* layers — a pure builder, a chaining hook over extensions, and a
  per-turn override that is cleared — and that `preset.ts` appends after the facts only
  because an extension cannot reach the builder. A profile can, so it composes there.
  `before_agent_start` is wired as the **extension** point, with our own chaining runner,
  because core's `emitHook` hands every handler the same string and keeps only the last.

- [What a profile switch leaves behind](tickets/14-switch-aftermath.md) — **tolerate the
  debris**: history is never filtered (filtering is rewriting), narrowing is never
  refused, and pi is confirmed to pass history through untouched. The active profile is
  **derived from the entry stream, not session metadata**, which is what makes mid-session
  `fork` inherit it correctly. A switch renders as a visible transcript divider;
  compaction records the profile it ran under in `CompactionEntry.details`. Whether
  providers actually reject an orphaned `tool_use` is left as a **probe** on
  [the walking skeleton](tickets/12-walking-skeleton.md) rather than guessed.

## Not yet specified

**How to read this list, set by the dev in the grill.** The entries are not one kind of
thing, and listing them flat hides which ones need him. Group them three ways when
reporting them:

- **Deferred, not now** — decided in principle, and the work waits. `rtk`, the OS
  keychain, subagents, worker-hosted user scripts. Do not re-ask these. Report them as
  one group and move on.
- **Not decided** — the answer is genuinely open and blocks the work. These are the ones
  worth a grill.
- **Closed, kept for the record** — struck through, so that a settled answer does not
  later read as never having been considered.

- **What the app knows about a model** — [ticket 19](tickets/19-model-entries.md),
  **closed**. The obligation the ⚠ note above stated and no ticket ever owned. One table
  in `src/agent/models.ts` — `contextWindow`, `reasoning`, `thinkingLevelMap` — copied at
  author time from pi's bundled catalog data, **from the file for the provider we
  actually talk to**: the same id carries different numbers in different catalogs, and
  `gemini-2.5-pro` is 1,048,576 in `google.json` against 128,000 in `github-copilot.json`.
  `thinkingLevelMap` is the half the ticket did not know to ask for and the one that was
  most wrong: we were offering `medium` on a Gemini that has no medium and cannot stop
  thinking, and clamping Opus 5 down from a `max` it supports. Unknown answers
  `undefined` and the caller defaults it to `false` — safe rather than tidy, because
  every thinking branch in pi's adapters is gated on the flag, so guessing low fails
  quietly and guessing high can fail hard. Existence needed no fix, only recording:
  `requireProvider` never consults a provider's model list, so we advertise nothing and a
  dead id fails as the provider's own error. Cost stays absent while nothing displays it.
- **How a tool asks a question** — [ticket 18](tickets/18-tool-reaches-the-gate.md),
  **closed**. It did not come from charting; it fell out of *building* ticket 13, which
  is why it arrives after the other seventeen closed. `gate.confirm` is the door: the
  gate became runner-scoped like the asker, and a user tool whose resolved argv trips the
  deny list now raises the same approval card `bash` does instead of throwing.
  What settled it was not the mechanism but an argument the ticket had not made.
  Refusing never stopped anyone deleting the directory — it made them write
  `["python3", "cleanup.py"]`, where the deny list cannot read the command and never asks
  at all. Strictness bought indirection and cost the one case a foot-gun guard is any use
  for. Still worth landing **approval memory** below beside it: a tool that can ask is a
  second caller for whatever that becomes.
- **Profiles as subagent definitions** — [ticket 24](tickets/24-subagents.md), **built in
  Slice 36.** The premise holds: a profile is the whole payload a child
  needs, plus one field. The precondition this entry named is answered, and **the
  conclusion it drew from it was wrong**. pi has no subagent concept — zero hits for
  `subagent`, `spawnAgent`, `forkSession` or `childAgent` across `dist` — and the effort
  does *not* grow, because the harness is already the unit of one agent. `AgentHarness`'s
  constructor takes plain options with no registry, no singleton and no global state, so
  **a second agent is one `new`**. pi also already models parentage: `JsonlSessionRepo`
  writes `parentSessionPath` and a free-form `metadata` object and returns both from
  `list()`. What pi does have and must not be confused with this is session **branching**,
  which is one conversation splitting in two. The decisions: the **model** spawns through
  a `task` tool listed in a profile's `tools`; `subagent: boolean` plus a required
  description makes a profile delegable, and a missing description drops it with a warning
  as Slice 35's shadowing rule already does; a child starts from the parent's prompt and
  no history; four at once, depth 3 including the main agent, fifteen minutes each; the
  **child's own** `gatePolicy` decides and its approvals queue to the user — which is what
  made the gate hold a queue rather than one pending slot; compaction was decided per child
  and turned out to have nothing to fire on, because a child runs one turn and pi compacts
  only an idle harness; **one checkpoint per parent turn** covers all of them, because children share
  one working tree and per-child checkpoints are not separable; tokens counted separately
  so auto-compaction keeps an honest denominator; and it crosses the seam as **no new
  event kind at all** — a delegation is a tool call, and `tool_update`'s partial output
  carries `profile - label - [latest event]`. Child sessions live in the same directory
  and start-up skips them, which is why they carry `metadata.delegatedFrom` and not only
  `parentSessionPath` — the latter would also hide a fork. **Deferred and written down**:
  the child chat view, which is the largest single piece and reopens the session-picker
  question, plus steering a child, child tokens in the main meter, and making the three
  constants configurable. The line-only version ships without any of them.
- **Which profile composes the skills** — [ticket 20](tickets/20-skills.md), **closed**.
  The map carried this as two entries and they were one question; the duplication is why
  nobody went back for it once profiles landed. **`profile.skills` is a default-off list
  of names** — ticket 04's default-on exists for tools *pi* adds upstream, where the
  author never had the chance to mention one, and a skill is ticket 13's case instead:
  naming it in a profile is the trust decision. **Both entry points ship, because pi ships
  both and says why** — the `<available_skills>` listing for the model, `/skill <name>`
  for the user, and pi's own doc concedes the first is unreliable. They cannot be merged:
  `AgentHarness.skill()` throws `busy` unless the harness is idle, so it can never be
  reached from inside a turn and the model's only route is `read`. **Two directories**,
  `.skills` (global) and `.agents/skills` (project — *not* `.ade/skills`, which is
  gitignored and hidden from the tree, for the reason the profiles file already records).
  **Project wins a collision, and a collision warns rather than refuses**: pi merges the
  other way on a trust argument that stops applying once membership *is* the trust act,
  and one merge rule for both file pairs beats agreeing with upstream. The decision that
  took longest was **how the model gets a body**. Serving it from memory looked smaller —
  `loadSkills` already returns `content` — until the standard's own shape settled it: a
  skill is a *directory*, so a body without its `references/` is a half-working skill that
  reads as a model failure rather than an app refusal. The read boundary therefore widens,
  by a **fixed read-only mount** rather than by a list the renderer supplies. Skills are
  the [Agent Skills standard](https://agentskills.io/specification) and not pi's format,
  which is what makes adopting it cost nothing.
- **Typing while the agent is running** — [ticket 22](tickets/22-steering.md),
  **closed in Slice 32**: Enter is a follow-up, `/steer` is the other verb, and the
  queues cross the seam as a thirteenth event kind.
  Raised by the reuse audit rather than by charting, which is [ticket 18](tickets/18-tool-reaches-the-gate.md)'s
  pattern again: it was invisible while the map was being drawn because the map names
  what the agent *is*, not what the composer does while it thinks. pi ships `steer`
  (lands inside the running turn), `followUp` (lands after it) and `nextTurn` (lands
  after the run), plus the `queue_update` event that renders them and the `abort` event
  that says which ones a cancel threw away. The open decision is not the mechanism, which
  is free — it is **what Enter means while a turn is running**, because a steer meant as
  a follow-up derails a turn that was working, and guessing wrong is worse than not
  having the feature.
- ~~**Prompt-change mode as a setting**~~ — **closed in the grill: append is the rule,
  not a default.** [Ticket 17](tickets/17-system-prompt-assembly.md) settled that a
  profile appends. This entry asked whether replace should ever be offered per profile.
  It should not. pi puts the shell facts and the workspace facts **last** on purpose, and
  a profile that replaces the prompt deletes them. The question stays recorded so that
  append does not read as never having considered replace.
- **Worker-hosted user scripts.** Deferred by
  [How a user adds their own tool](tickets/13-user-authored-tools.md) as the largest
  single piece of work on this map: a capability protocol over `postMessage`, worker
  lifecycle, and handling hangs, timeouts and errors in code we did not write. A Web
  Worker has no `window` and therefore no Tauri IPC, so the isolation is real — this is a
  known-good route, not an open question, but it is its own effort.

  **Condition, from the grill.** This is where hook order stops being theoretical.
  [Ticket 03](tickets/03-permission-gate.md) records that pi has no deny-precedence, and
  the grill made the behaviour exact: `emitHook` **runs every handler** and keeps the
  **last non-undefined result**. A handler with no opinion returns `undefined` and
  changes nothing, which is why one gate handler is safe today. A user script that
  installs a second `tool_call` handler and returns an object replaces the gate's
  `{ block: true }`. So whatever hosts user scripts either denies them the `tool_call`
  hook, or runs the handlers through a chaining runner with deny-precedence — the same
  shape `systemPrompt.ts` already uses for `before_agent_start`, and for the same reason.
- **Extension beyond tools** — hooks exposed to users, custom renderers, ADE chrome.
  The *tools* half of this graduated into
  [How a user adds their own tool](tickets/13-user-authored-tools.md) when the dev named
  it a requirement. What stays fog is everything pi's extension API does *besides*
  defining tools, which is most of its breadth and most of what makes it a Node-and-TUI
  artifact.
- **Rich agent output.** Deferred by the dev while settling the event contract: previews,
  markdown attachments, and other content types an agent might emit beyond text and tool
  results. The twelve-kind contract does not preclude them — a new kind, or structured
  content inside `text`, are both open — but which of the two, and what the ADE renders,
  is unspecified. Revisit once the transcript has real content in it.
- **Approval memory** — allow-once vs allow-for-session vs persistent rules. Deferred
  deliberately by [What stops a tool call](tickets/03-permission-gate.md), on the
  grounds that it is moot while auto is the default and becomes live once `careful` is
  specified. `careful` then shipped, so that condition was met and nobody noticed —
  **the dev closed the gap in the grill: he always runs `auto`.** So this stays deferred
  on a fact rather than on an expired argument. It becomes live if a second person runs
  the app, or if `careful` stops being a profile nobody selects.
- **Cancellation semantics below the event boundary** — mid-stream, mid-tool,
  mid-child-process. Sharp once the event contract and `exec` are settled.
- **Whether pi's compaction defaults need touching.** pi's is the more carefully
  engineered of the two references and it comes free. Likely nothing to decide; listed
  so it is not silently forgotten. **Now answerable** —
  [What pi-agent-core already does that we are reimplementing](tickets/15-core-already-does-this.md)
  found `shouldCompact`, `calculateContextTokens`, `findCutPoint` and
  `DEFAULT_COMPACTION_SETTINGS` all exported from the browser-safe core. **Closed
  provisionally** by that ticket: ship the defaults untouched, reopen on the first
  session that compacts badly. *Who calls `shouldCompact`* is a different question and
  is now [ticket 16](tickets/16-compaction.md) — core never calls it itself.
- ~~**A command system for the agent chat.**~~ **Deleted from the queue** by
  [ticket 15](tickets/15-core-already-does-this.md), and **both halves have now shipped**.
  Its builtin half is a lookup table over harness methods, which is
  [`src/agent/commands.ts`](../../../src/agent/commands.ts); its user half was one
  `promptFromTemplate` call, made in Slice 35 —
  [`src/agent/promptTemplates.ts`](../../../src/agent/promptTemplates.ts) reads `.md`
  files from `.agents/commands` and the composer runs one. The two decisions it did
  contain, and ticket 15 could not have known about: a template is **not gated by a
  profile** (a skill is listed to the model, where a template only reaches it when the
  user types the name — the typing is the trust act), and a built-in **wins a name
  clash** and says so.
- ~~**Session forking and a session picker.**~~ **Decided: no UI in v1**
  ([ticket 15](tickets/15-core-already-does-this.md)). The data model is in and costs
  nothing to carry; a branch view, picker and fork affordance are three UI surfaces for
  a feature nobody has asked for twice.
- **Which model catalog is authoritative.** **Decided: machinery in, entries ours**
  ([ticket 15](tickets/15-core-already-does-this.md)) — take `calculateCost`,
  `getSupportedThinkingLevels`, `clampThinkingLevel`; keep hand-written entries, because
  0.83.0's catalog **does not contain `deepseek-reasoner`**, the model this repo runs.
  The consequence that remained — [ticket 16](tickets/16-compaction.md) needing a true
  `contextWindow` per entry, against a `provider.ts` that hard-coded `128_000` for every
  model — **is now shipped**: `CONTEXT_WINDOWS` in `src/agent/compaction.ts` holds the
  entries, every number but DeepSeek's copied from pi's own catalog data rather than
  remembered. An unlisted model still has an *unknown* window, which is the answer that
  keeps auto-compaction from firing against a fabricated denominator.
- **How rtk is obtained, and which seam it applies at.** **Deferred, not now** — the
  grill offered vendoring the filter data or removing the field, and the dev chose to
  defer both. `rtk: boolean` stays on the profile and stays inert. Deferred with the
  evidence gathered — see the amendment on
  [How rtk becomes a profile setting](tickets/11-rtk-in-profile.md). Five routes, priced:
  PATH lookup, bundled sidecar, library dependency (**ruled out — no lib target, and the
  crates.io name belongs to an unrelated project**), fetch-on-enable, and vendoring the
  TOML filter data. The two numbers that decide it: rtk is **3.9 MB gzipped against a
  3.1 MB gzipped frontend**, and its filter half is **data, not code**. Blocks nothing
  else; `rtk: boolean` already round-trips on the profile.
  **Amendment 2 read the source and moved the blocker.** The cost question is answered
  and is small — the engine is one pure file, `apply_filter(&CompiledFilter, &str) ->
  String`, 804 production lines, needing `regex`, `serde` and `toml`, all three already
  in our `Cargo.lock`, so **zero new crates**. A sixth route appeared: **F**, vendoring
  the engine source into `src-tauri`, which needs no lib target and which Amendment 1
  never priced. E ≈ 385–430 lines written against F ≈ 510 copied; **E wins on what we own
  after** — the TOML schema is frozen across three releases while the engine moved
  +330/−59 in two months. What opened instead is a **value** question that decides the
  ticket: `RUST_HANDLED_COMMANDS` holds 49 names, including `git`, `cargo`, `npm`,
  `docker` and `tsc`, and **no TOML filter can ever fire for any of them**. They belong to
  the `cmds/` half, which does not travel — it re-invokes the tool itself, so it is a
  second process-spawning path that bypasses everything [ticket 02](tickets/02-exec-not-terminal.md)
  built. E therefore buys `gradle`, `terraform`, `helm`, `make` and similar, and this
  repo runs none of them. **Measure our own turns before writing the 400 lines.**
  **Amendment 3 read it per command, and the seam is now built.** The (a)/(b) split was
  too coarse — it is four classes, and the middle one carries the answer: **~34 commands
  keep the user's argv and only reformat**, so their *noise-dropping* half is extractable
  even though their rendering is not. `cargo` is one of them; it **injects nothing** and
  declines `--message-format=json` on purpose. Three of our four commands are
  argv-preserving, which is a materially different picture from "E buys nothing", and it
  opens **route G — take the engine, ship almost none of upstream's 63 filters, write our
  own**, with no Apache-2.0 obligation because the filters would be ours. What is **built**
  is the seam alone: `src/agent/crop.ts`, a pure post-filter in the exec adapter, after raw
  bytes have streamed to the UI and before pi's positional cap, carrying rtk's own
  `never_worse` guard and announcing every crop. **One rule ships, `npm`**, transcribed
  from source rather than invented. Three corrections to Amendment 2 are on the ticket:
  **eight pipeline stages not nine**, **73,240 bytes of filter data not 261 KB**, and
  **`RUST_HANDLED_COMMANDS` is not the routing table — Clap is**, which leaves five shipped
  filters dead on rtk's own hook path. The blocker is unchanged but smaller: upstream's
  `savings_pct` figures are hard-coded constants rather than measurements, and the seam is
  what finally measures ours.
- ~~**Where profiles are stored.**~~ **Answered and built** — see the shipped section on
  [What is a profile, concretely?](tickets/04-profile-data-model.md). The global file has
  its own narrow Rust command, the project file sits at the workspace root where it is
  visible and committable, and the agent may not write it. What is *left* is smaller and
  named there: the first model still comes from an env var, because the
  canned-versus-native decision is made before the files are read.
- **Whether a profile is editable from the UI.** Deliberately not built: profile files
  are hand-authored, which is what kept the storage half small — Zed's selector UI is
  about 3× its model layer, and this map's own warning about profile scope applies to the
  chrome as much as the fields. Nothing is foreclosed; an editor writes the same file the
  reader already reads. Listed so that "no editor" reads as a decision rather than an
  oversight.
- ~~**Skills: which profile composes them.**~~ **Merged upward** into the single skills
  entry above and closed as [ticket 20](tickets/20-skills.md) — it was the same question
  asked twice, and the duplication is why the answer sat unowned once profiles landed.
- **Completing a slash command and its argument** — [ticket 21](tickets/21-command-autocomplete.md),
  **closed in Slice 33**. Deferred out of ticket 20 by the dev. The separator turned out not to decide
  it: a menu entry may hold a space, so `/skill grilling` completes exactly as well as
  pi's `/skill:grilling`. What is open is that `AgentChat.tsx` parses commands with a
  chain of `startsWith`, so there is no list of commands to complete *from*.
  **Amended by the reuse audit above:** pi already ships the missing half of that list.
  `loadPromptTemplates` reads user-authored `.md` commands the same way `loadSkills`
  reads skills, `parseCommandArgs` splits an argument string on shell quoting where
  `AgentChat` splits on whitespace, and `substituteArgs` +
  `formatPromptTemplateInvocation` + `AgentHarness.promptFromTemplate` run one. This map
  deleted "a command system for the agent chat" from the queue as *"one
  `promptFromTemplate` call"* and nothing has yet made it — so the user-command half is
  unbuilt rather than rewritten, and whoever builds the completion list should build it
  over pi's loader rather than over the `startsWith` chain.

### Queued by the dev after Slice 38

Nine items, accepted as a batch, now written up as **tickets 25–36**. They are **not**
"deferred, not now" — that group means decided and waiting, and these are decided and
*next*.

**26, 27 and 30 landed in Slice 39** — the three that were unblocked, needed no new
subsystem, and turned out to be joins between parts that already existed. Six remain, of
which 29 is the only one still gated (on 25) and 36 is still a question rather than work.

Twelve tickets for nine items, because three things came out of slicing them:

- **[25](tickets/25-confirm-primitive.md) is a prefactor nobody asked for.** The
  two-consumer rule for extracting a UI primitive is already satisfied — `ConfirmDiscard`
  and the revert confirm in `ChangesView` — and ticket 29 makes a third. Doing it first is
  cheaper than writing a third hand-rolled overlay. Drop it if the dev disagrees; nothing
  else depends on it but 29.
- **LSP is three tickets, not one.**
  [33](tickets/33-lsp-adaptor.md) is a tracer bullet — one server, one capability, all the
  way through — then [34](tickets/34-lsp-navigation.md) and
  [35](tickets/35-lsp-rename.md). Rename is last because it is the first LSP capability
  that *writes*.
- **[36](tickets/36-acp-direction.md) has no acceptance criteria**, deliberately. Closing
  it means writing down a direction, not building anything.

The grouping that matters here is not the three above but **what the workbench already
has**. Three of these are wiring existing parts together and three are new subsystems, and
sequencing them by that rather than by appeal is the whole value of writing them down.

**Nearly free — the machinery exists and is being discarded**

- **Cost** — [ticket 26](tickets/26-cost.md). **Landed, Slice 39.** pi already computes it. `usage.cost` is `{input, output, cacheRead, cacheWrite,
  total}` on every `message_end`, and `Model.cost` carries the rates plus request-wide
  pricing tiers. `events.ts:113` reads `usage.input` and `usage.output` and drops `cost`
  on the floor one line away from where it is needed. Ticket 19 closed with *"cost stays
  absent while nothing displays it"* — that is now the only thing missing, and the meter
  that would display it already renders beside the token counts.
- **File mention / `@ref`** — [ticket 27](tickets/27-file-mention.md). **Landed, Slice 39, and the decision went to a path.** Both halves are built and have never been introduced:
  `commands/fuzzy.ts` is the fuzzy file filter the command palette uses, and
  `agent/completion.ts` is the inline completion the slash commands use. The work is a
  trigger character and a decision about what an `@` expands to in the prompt sent to the
  model — a path, or the file's contents inlined. **That decision is the whole ticket**;
  the mechanism is a join.
- **Session undo** — [ticket 28](tickets/28-session-undo.md). `git_checkpoint` already runs once per turn and nothing in the UI has
  ever exposed it. The open question is not how to rewind the tree but what happens to the
  *transcript* when you do — pi's session is append-only JSONL, so a tree rewind that
  leaves the conversation intact desynchronises the two, and truncating the session is a
  different operation from `git reset`.

**Small, self-contained, no new subsystem**

- **Explorer file operations** — [ticket 29](tickets/29-explorer-file-operations.md). Create, rename, delete. Note the asymmetry this closes:
  Rust already exposes `agent_write_file`, `agent_create_dir` and `agent_append_file`, so
  **the agent can create files the human cannot**. Rename and delete have no Rust command
  at all and both must land under `contained()` like everything else.
- **Replace across files** — [ticket 30](tickets/30-replace-across-files.md). **Landed, Slice 39** — literal, case-insensitive, per file, previewed as a `replace:` diff tab. `search_workspace` finds; nothing writes back. The
  interesting half is preview-and-confirm, not the substitution, and it wants the same
  diff surface as the gate below.
- **Multi-workspace switching** — [ticket 31](tickets/31-workspace-switching.md). Recent roots, and a switcher.

  **A correction to what this map's author told the dev.** He was cautioned against this
  on the grounds that `workspace.rs` treats one root as the confinement boundary and
  multi-root reopens that decision. **That caution was about multi-root and he asked for
  switching**, which is a different feature: one root is still the boundary, it is merely
  a different root than a minute ago. Nothing about containment is reopened. He called it
  a must-have and he is right — `set_workspace` already exists, and the missing parts are
  a persisted recent list and deciding what a switch does to open editors, the terminal's
  cwd, and a running agent turn.

**New subsystems — sequence these apart from each other**

- **Diagnostics** — [ticket 32](tickets/32-diagnostics.md). Listed by the dev alongside LSP and **deliberately kept separate from
  it here**, because for TypeScript it is not an LSP feature at all: `ts.worker` is
  already in the bundle at 6 MB and already computing exactly these markers for the open
  file. Surfacing them costs a listener and a panel. That buys diagnostics for the
  language this repo is written in without a protocol, and it is the honest first slice.
- **LSP adaptor** — tickets [33](tickets/33-lsp-adaptor.md), [34](tickets/34-lsp-navigation.md), [35](tickets/35-lsp-rename.md). What diagnostics-via-`ts.worker` cannot buy: Rust, Python, anything
  else, and everything beyond markers — definitions, references, rename, hover. This map
  previously argued against it as *"a subsystem, not a feature"*. That argument was about
  cost, not value, and the dev has weighed it. It stands as the larger of the two and
  should not be the thing blocking diagnostics from shipping.
- **ACP adaptor** — [ticket 36](tickets/36-acp-direction.md). **Recorded as an open question at the dev's direction, not scheduled.**
  Nothing is built until the fork below is settled, and the fork is genuine:

  - *We host other agents (client).* The workbench speaks ACP outward, and pi becomes one
    implementation behind an interface rather than the only one. The codebase is unusually
    ready for this — `src/agent/**` is 5,326 lines with zero React imports and
    `AgentProvider` is already the seam. What it would cost is that the gate, profiles and
    skills have to mean something for an agent that has no such concepts.
  - *Others drive our agent (server).* A transport over the harness we already have.
    Much smaller, and it makes our front end optional — which cuts directly against the
    destination this map exists to reach.

  Neither is started. ACP appears nowhere in pi — `@earendil-works/*` mentions it not at
  all — so either direction is entirely ours to write.

## Out of scope

<!-- ruled beyond the destination; never graduates -->

- **A Rust agent harness.** The previous destination. Preserved, paused, and not
  deleted — see [Rust agent harness for the ADE](../rust-harness/map.md). It is the
  fallback if the pi dependency is rejected.
- **ACP as the ADE's agent boundary.** ACP is a protocol for driving *external* agent
  processes over stdio; this destination is a *built-in* agent. Driving Claude Code or
  Codex from the ADE is a coherent and appealing effort, but it is a different one, and
  it would not use pi. Returns only if the destination is redrawn.
- **Running `pi-coding-agent` as a sidecar.** Would deliver presets, the permission
  gate, and the extension system for almost no agent work, over a supported RPC
  surface. Rejected because it reintroduces the Node runtime, and because pi's own
  `ExecutionEnv` would then do the file I/O — ending Rust's sole authority.
- **Porting pi's `packages/ai`.** Dissolved rather than ruled out: as a dependency it
  simply comes along. Its *bundle* cost is in scope — see
  [What pi costs in the bundle](tickets/08-bundle-cost.md).
- **MCP support.** pi omits it deliberately; adding it is its own effort.
- **Remote / multi-client sessions** (pi's `packages/server` + `packages/client`,
  marked experimental upstream).
- **A TUI.** The ADE is the surface.
