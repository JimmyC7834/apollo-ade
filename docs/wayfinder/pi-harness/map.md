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

That line held: all seventeen charted tickets closed. Two things it did not anticipate,
both open under "Not yet specified". [Ticket 18](tickets/18-tool-reaches-the-gate.md) is
a decision charting could not have raised, because it fell out of *building*.
[Ticket 19](tickets/19-model-entries.md) is the opposite failure and the more instructive
one: the map stated the obligation plainly in its own Notes and no ticket ever owned it,
so it survived seventeen closures by belonging to none of them. A closed map is not a
finished one — and "every decision is made" is only true of the decisions something was
accountable for making.

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

## Decisions so far

<!-- one line per closed ticket -->

- **The walking skeleton closed, and nothing upstream reopened.**
  [Thinnest end-to-end turn](tickets/12-walking-skeleton.md)
  closed a real loop against DeepSeek in the native window — streamed prose, a `read` tool
  call, tool result, grounded answer — so the eleven-kind event contract and the
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
  additional resolver.

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

- **What the app knows about a model** — [ticket 19](tickets/19-model-entries.md),
  **open**. The obligation the ⚠ note above stated and no ticket ever owned. `reasoning`
  is guessed from the model id (`/reason|think/i`), and the guess is not cosmetic:
  `clampThinkingLevel` reads it, so a mislabelled model silently answers with thinking
  `off` and nothing errors. Existence may already be answered — we advertise no model
  list, so a dead id fails as the provider's own error — and cost is deliberately zeroed
  while nothing displays it. Three questions, one of them actually wrong today.
- **How a tool asks a question** — [ticket 18](tickets/18-tool-reaches-the-gate.md),
  **open**. It did not come from charting; it fell out of *building* ticket 13, which is
  why it arrives after the other seventeen closed.
  A user tool that hits the deny list refuses rather than asks, because `createGate` is
  built per turn and reached through the `tool_call` hook while a tool's `execute()` has
  no handle on either. Safe and honest, and it makes a legitimate tool — `["rm", "-rf",
  "{dir}"]` for a build directory — permanently dead rather than merely gated. The
  ticket settles whether a tool should be able to ask at all, and by what mechanism if
  so. Worth landing alongside **approval memory** below, since a tool that can ask is a
  second caller for whatever that becomes.
- **Profiles as subagent definitions.** The same payload (tools + prompt + model)
  configures both a session and a spawned child. Claude Code unifies them; whether
  pi's core even supports subagent forking is unverified. Blocked behind the profile
  data model.
- **Skills: composition with profiles.** pi loads skills into the system prompt up
  front and ships `formatSkillsForSystemPrompt`. How a profile adds, removes, or
  overrides them is unspecifiable until the profile exists. The *loading* half is
  solved and deliberately not adopted yet — see the skills entry below.
- **Prompt-change mode as a setting** — append vs replace chosen *per profile* rather
  than fixed. [Ticket 17](tickets/17-system-prompt-assembly.md) settled append as the
  rule; this is the question of whether that is a default or a ceiling. Listed so that
  choosing append does not later read as never having considered replace.
- **Worker-hosted user scripts.** Deferred by
  [How a user adds their own tool](tickets/13-user-authored-tools.md) as the largest
  single piece of work on this map: a capability protocol over `postMessage`, worker
  lifecycle, and handling hangs, timeouts and errors in code we did not write. A Web
  Worker has no `window` and therefore no Tauri IPC, so the isolation is real — this is a
  known-good route, not an open question, but it is its own effort.
- **Extension beyond tools** — hooks exposed to users, custom renderers, ADE chrome.
  The *tools* half of this graduated into
  [How a user adds their own tool](tickets/13-user-authored-tools.md) when the dev named
  it a requirement. What stays fog is everything pi's extension API does *besides*
  defining tools, which is most of its breadth and most of what makes it a Node-and-TUI
  artifact.
- **Rich agent output.** Deferred by the dev while settling the event contract: previews,
  markdown attachments, and other content types an agent might emit beyond text and tool
  results. The eleven-kind contract does not preclude them — a new kind, or structured
  content inside `text`, are both open — but which of the two, and what the ADE renders,
  is unspecified. Revisit once the transcript has real content in it.
- **Approval memory** — allow-once vs allow-for-session vs persistent rules. Moot while
  auto is the default policy; becomes live when the `careful` profile is specified.
  Deferred deliberately by [What stops a tool call](tickets/03-permission-gate.md).
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
  [ticket 15](tickets/15-core-already-does-this.md). Its builtin half is a lookup table
  over harness methods that now exist; its user half is one `promptFromTemplate` call.
  Nothing in it is a decision, so it ships alongside
  [ticket 16](tickets/16-compaction.md) rather than being planned.
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
- **How rtk is obtained, and which seam it applies at.** Deferred with the evidence
  gathered — see the amendment on
  [How rtk becomes a profile setting](tickets/11-rtk-in-profile.md). Five routes, priced:
  PATH lookup, bundled sidecar, library dependency (**ruled out — no lib target, and the
  crates.io name belongs to an unrelated project**), fetch-on-enable, and vendoring the
  TOML filter data. The two numbers that decide it: rtk is **3.9 MB gzipped against a
  3.1 MB gzipped frontend**, and its filter half is **data, not code**. Blocks nothing
  else; `rtk: boolean` already round-trips on the profile.
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
- **Skills: which profile composes them.** Loading is solved —
  [ticket 15](tickets/15-core-already-does-this.md) put `loadSkills` and
  `formatSkillsForSystemPrompt` in the adopt list but **deferred them**, because skills
  compose with profiles and profiles do not exist yet. Returns with profiles.

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
