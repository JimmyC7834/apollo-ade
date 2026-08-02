# How this repo depends on pi — research

Asset for [ticket 07](../tickets/07-pi-dependency.md). All figures below were produced
by commands run on 2026-08-01 against the live npm registry and the local clone at
`pi/` (`aa0ec808b`). Network **was** available; nothing here is estimated.

---

## Recommendation

1. **Depend via npm, on `@earendil-works/pi-agent-core` only, pinned to an exact
   version** (`"0.83.0"`, no caret). Do not add `@earendil-works/pi-ai` to our
   `package.json` — it arrives transitively and pinning it separately invites a
   version skew that `pi-agent-core`'s own `^0.83.0` range would otherwise prevent.

2. **The ticket's central worry is weaker than it looked.** The browser-safety gate is
   not only a CI check — pi's root `prepublishOnly` is
   `clean && build && check`, and `check` includes `check:browser-smoke`
   (`pi/package.json:18-19,39`). Every published version ran the gate against the exact
   tree that produced its `dist`. A submodule buys us the ability to re-run a check
   that already ran. See [Distribution options](#distribution-options).

3. **Instead, add our own bundle-level guard here.** The check we actually need is not
   pi's, it is ours: assert that our production bundle contains no `node:` builtin
   import and none of `@aws-sdk/client-bedrock-runtime`, `@google/genai`,
   `@mistralai/mistralai`, `openai`. That is ~20 lines against our own bundler's
   metafile, it survives pi upgrades, and it catches the failure mode that actually
   hurts us (a transitive regression *plus* our own bundler config drifting). Feeds
   [08-bundle-cost](../tickets/08-bundle-cost.md).

4. **Posture: pin and upgrade deliberately.** Not track-and-absorb. Roughly **half of
   pi's minor releases carry documented breaking changes**, and `ExecutionEnv`'s wiring
   already broke once in the last six weeks. Every upgrade is a task that starts by
   reading `packages/agent/CHANGELOG.md`'s `### Breaking Changes`.

5. **Keep `pi/` as a reading copy; `.gitignore` it; record the commit.** Do not make it
   a submodule. Add `pi/` to this repo's `.gitignore` and record the pinned commit
   (`aa0ec808b`) in the map, so the line-number citations in tickets 01 and 04 stay
   checkable.

6. **Attribution: neither tarball ships a LICENSE file.** Both packages are MIT
   (`license` field), but `files: ["dist","README.md"]` excludes the repo's `LICENSE`.
   If we ship binaries we must copy pi's MIT text ourselves. See [License](#license-and-attribution).

### Surprises that bear on the map

- **`pi/` at `aa0ec808b` is *ahead of* published `0.83.0`.** Its
  `packages/agent/CHANGELOG.md` `[Unreleased]` section replaces `SessionStorage`,
  `SessionRepo` and per-session persistence with `SessionRepository` + caller-owned
  `SessionStore`. Every ticket reading session APIs out of `pi/` is reading an
  **unreleased** API. Directly hits [09-session-store](../tickets/09-session-store.md).
- **`ExecutionEnv` was already de-wired in 0.82.0** (2026-07-24, five days before
  0.83.0): *"Replaced `AgentHarness`'s `ExecutionEnv` dependency and context-free
  `AgentTool` inputs with application-defined `toolContext` values and context-aware
  `AgentHarnessTool` definitions."* The interface still exists
  (`pi/packages/agent/src/harness/types.ts:372`) but the map's framing — "implement
  `ExecutionEnv`, hand it to the harness" — is one release out of date.

---

## Is it published, and at what cadence?

`npm view @earendil-works/pi-agent-core --json` and the same for `@earendil-works/pi-ai`.

Both are published, both at `0.83.0` on `latest`, both with a second dist-tag
`legacy-node20: 0.74.2`. Publishes come from GitHub Actions OIDC
(`_npmUser: GitHub Actions <npm-oidc-no-reply@github.com>`) with SLSA provenance
attestations — a meaningful supply-chain signal.

| | `pi-agent-core` | `pi-ai` |
|---|---|---|
| `latest` | 0.83.0 | 0.83.0 |
| versions on registry | 39 | 39 |
| first publish | 2026-05-07 | 2026-05-07 |
| latest publish | 2026-07-29 | 2026-07-29 |
| tarball | 269.0 KB | 676.7 KB |
| unpacked | 1,421,650 B (142 files) | 3,693,688 B |
| license field | MIT | MIT |
| `engines.node` | `>=22.19.0` | `>=22.19.0` |

The two packages version in lockstep — identical version lists, publishes seconds
apart. `pi-agent-core` depends on `@earendil-works/pi-ai: ^0.83.0`; that is the **only**
`@earendil-works` package in its dependency tree.

### Cadence

39 releases across 83 days (2026-05-07 → 2026-07-29) — a release every **~2.1 days**.
Ten minor lines (0.74 → 0.83) in twelve weeks — roughly **a minor a week**.

Note the registry's `time` map is not monotonic: `0.74.2` was published 2026-05-21,
*after* `0.75.4`. They backport onto the `legacy-node20` line. Also, `0.80.0` and
`0.80.4` were never published.

### Do breaking changes land in minors?

Yes, routinely. From `packages/agent/CHANGELOG.md`, the releases carrying a
`### Breaking Changes` section:

```
awk '/^## \[/{v=$0} /^### Breaking Changes/{print v}' packages/agent/CHANGELOG.md
```

`[Unreleased]`, `0.82.0`, `0.81.0`, `0.80.0`, `0.77.0`, `0.75.0`, `0.69.0`, `0.65.0`,
`0.32.0`, `0.31.0`.

In the window we care about (0.74 → 0.83, ten minors), **five carried breaking
changes**, and a sixth is already staged in `[Unreleased]`. `packages/ai/CHANGELOG.md`
is worse still — it lists breaking changes even in *patch* releases (`0.80.7`,
`0.80.8`, `0.75.5`).

Concrete breaking changes touching our surface, from the changelog:

- `0.82.0` — `AgentHarness` no longer takes `ExecutionEnv`; `toolContext` +
  `AgentHarnessTool` instead.
- `[Unreleased]` — the `SessionStorage`/`SessionRepo` → `SessionRepository`/`SessionStore`
  rewrite described above.
- earlier — `ExecutionEnvExecOptions` renamed to `ShellExecOptions`
  (`packages/agent/CHANGELOG.md:108`).

**Conclusion: 0.x here means what it says. Treat every minor as potentially breaking.**

---

## The generated model catalog: shipped, not built

**The published tarball ships the JSON.** Verified directly:

```
npm pack @earendil-works/pi-ai@0.83.0
tar tzvf earendil-works-pi-ai-0.83.0.tgz | grep providers/data
```

38 files under `package/dist/providers/data/`, **481,153 bytes** raw, including
`.manifest.json`, `openrouter.json` (122 KB), `vercel-ai-gateway.json` (64 KB),
`amazon-bedrock.json` (46 KB), `anthropic.json` (5.9 KB).

The mechanism is `packages/ai/package.json`:

- `files: ["dist", "README.md"]`
- `build:offline` ends with
  `shx rm -rf dist/providers/data && shx cp -r src/providers/data dist/providers/data`
- `prepublishOnly: "npm run clean && npm run build"`, and `build` = `generate-models`
  (hydrates `src/providers/data` from upstream catalogs) `&& build:offline`.

So: **generated at publish time, shipped as data.** `npm install` needs no build step,
no network beyond the registry, and no hydration. The
*"fresh checkouts do not materialize provider JSON"* comment in
`pi/scripts/check-browser-smoke.mjs:11` describes **source checkouts only** —
`packages/ai/src/providers/data/` is gitignored upstream (`pi/.gitignore:11`, confirmed
untracked via `git ls-files`). It is a statement about submodules, not about npm.

### Bundle consequence

481 KB of JSON is on disk in `node_modules`, but it is **not** all in our bundle,
provided our bundler treeshakes as well as esbuild does. pi asserts exactly this in
`check-browser-smoke.mjs:84-108`, using `scripts/agent-treeshake-smoke-entry.ts`:
with a selective provider import (`@earendil-works/pi-ai/providers/anthropic`),
**only `anthropic.json` (5.9 KB) contributes to the output**, and of the five vendor
SDKs only `@anthropic-ai/sdk` is pulled in.

Caveat we own: `pi-agent-core`'s `dist` imports the **root barrel**
`"@earendil-works/pi-ai"` (four import sites — `agent-loop.js`, `agent.js`,
`harness/agent-harness.js`), not subpaths. The small bundle depends on our bundler
treeshaking that barrel, and on *us* using the selective
`@earendil-works/pi-ai/providers/<name>` import for providers. Hand this to
[08-bundle-cost](../tickets/08-bundle-cost.md) as a measurement, not an assumption.

---

## Distribution options

### npm dependency — recommended

- Cost: `node_modules` gains ~5.1 MB unpacked across the two packages (plus vendor
  SDKs, which are `pi-ai`'s dependencies and install regardless).
- `engines.node: ">=22.19.0"` is declared on both. This is advisory (npm's
  `engine-strict` is off by default) and irrelevant at runtime for us, but it will warn
  under `npm ci` on older Node and it signals upstream feels free to use recent Node
  APIs in code paths we must keep out of the bundle.
- The browser-safety guarantee is **not** lost: see below.

### Git submodule

- Genuine benefit: pins an exact commit, makes the line-number citations in
  tickets 01 and 04 reproducible for anyone who clones.
- The stated benefit — "lets us run their `check-browser-smoke` ourselves" — **does not
  survive contact with what the script needs**:
  - It bundles `scripts/browser-smoke-entry.ts`, which imports `@earendil-works/pi-client`
    and `@earendil-works/pi-protocol` alongside the two packages we ship. It gates pi's
    whole browser-facing surface, not our subset.
  - Running it requires `npm ci` across pi's **entire** monorepo (nine workspaces plus
    six example-extension workspaces) — including native build deps: pi's own CI installs
    `libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep`
    before it can install (`.github/workflows/ci.yml:26-30`). On Windows that is a
    project unto itself.
  - It requires hydrated model data (`npm run hydrate:model-data`, a network fetch of
    upstream model catalogs) or `npm run build` first — otherwise `check:model-data`
    fails.
  - And it would tell us what pi's own `prepublishOnly` already told us, on the same
    tree, before it published.
- Verdict: **the asymmetry the ticket names is real in principle and near-zero in
  practice**, because the gate is a publish gate, not only a PR gate
  (`pi/package.json:39`: `"prepublishOnly": "npm run clean && npm run build && npm run check"`).

### Vendored copy

Rejected as a distribution mechanism for the same reason the map rejected it as a
destination, plus one specific to this codebase: vendoring `dist` means we own
re-generating `providers/data`, which is a network hydration against models.dev and
friends. That is a build-time external dependency we do not want and do not currently
have.

---

## Posture when pi breaks us

**Pin and upgrade.** Specifically:

- Exact version in `package.json` (`"@earendil-works/pi-agent-core": "0.83.0"`), so an
  `npm install` never moves us.
- Upgrades are deliberate work items, opened by reading
  `packages/agent/CHANGELOG.md` → `### Breaking Changes` for every version in the span.
  pi's changelogs are unusually good; they are the upgrade guide.
- Track upstream reading-copy commits separately from the pinned npm version, and expect
  them to diverge — right now the reading copy is ahead of `latest`.

`ExecutionEnv` (`pi/packages/agent/src/harness/types.ts:372`) is the one interface this
whole map rests on, and upstream owes it nothing. It has already moved once in six
weeks. Two mitigations worth writing into the design:

1. **Do not implement `ExecutionEnv` directly in the Tauri adapter.** Define our own
   filesystem/shell interface (which `context.md` already requires — "feature code
   consumes domain interfaces") and write a thin, single-file adapter that shapes it
   into whatever pi currently wants. The adapter is the blast radius; keep it small
   enough that a breaking rename costs an hour.
2. **Treat the rest of pi's surface the same way.** The fallback if this gets untenable
   is preserved and named in the map — [rust-harness](../../rust-harness/map.md).

---

## License and attribution

Both shipped `@earendil-works` packages declare **MIT** (`license` field on the
registry, and `packages/agent/package.json` / `packages/ai/package.json`). pi's repo
root `LICENSE` is the MIT text. There are **no other `@earendil-works` packages in the
tree** — `pi-agent-core` → `pi-ai` and that is the end of it.

**What this repo owes:**

- **Neither tarball ships a LICENSE file.** Confirmed:
  `tar tzf … | grep -i licen` returns nothing for both, because `files` is
  `["dist","README.md"]`. Standard MIT attribution requires the copyright notice and
  permission text to accompany distribution — so if we ship a Tauri binary, **we must
  copy pi's MIT text into our own third-party notices ourselves**; it will not be in
  `node_modules` for a license-scanner to find.
- Transitive vendor SDKs pulled in by `pi-ai` are a mix, all permissive, none copyleft:

  | package | license |
  |---|---|
  | `@anthropic-ai/sdk` | MIT |
  | `@aws-sdk/client-bedrock-runtime` | Apache-2.0 |
  | `@google/genai` | Apache-2.0 |
  | `@mistralai/mistralai` | Apache-2.0 |
  | `openai` | Apache-2.0 |
  | `typebox`, `ignore`, `partial-json` | MIT |
  | `diff` | BSD-3-Clause |
  | `yaml` | ISC |

  Apache-2.0 §4 requires retaining NOTICE files if present — relevant only for whatever
  actually ends up in the shipped bundle. If the treeshaking holds, only
  `@anthropic-ai/sdk` (MIT) ships.

---

## Should the reading copy stay?

**Yes — keep it, gitignore it, record the commit.**

Current state, re-verified: `pi/` is untracked (`git check-ignore -v pi` → no match,
and it does not appear in this repo's `.gitignore`), there is no `.gitmodules`, and
`package.json` does not reference it. It also has `packages/ai/src/providers/data/`
materialized locally (38 JSON files) despite being gitignored upstream, so someone ran
a hydration or build in it — worth knowing, because it means `pi/` is not a pristine
checkout.

- **Gitignore, not submodule.** A submodule pins the commit but drags pi's full history
  into every clone and adds a `git submodule update` step to a repo that has one
  contributor. The value we want from pinning — stable line numbers for tickets 01 and
  04 — is delivered just as well by writing the commit hash down.
- **Leaving it untracked-and-unignored is the one bad option**, which is the state
  today: it shows up in every `git status` and one careless `git add .` commits an
  entire second repository.

Suggested: add `pi/` to `.gitignore`, and add a line to the map recording that the
reading copy is `github.com/earendil-works/pi` at `aa0ec808b`, **ahead of the pinned npm
version** — so nobody mistakes a citation for shipped API.

---

## Commands run

```
npm view @earendil-works/pi-agent-core --json
npm view @earendil-works/pi-ai --json
npm view <each transitive dep> license
npm pack @earendil-works/pi-ai@0.83.0 @earendil-works/pi-agent-core@0.83.0
tar tzvf earendil-works-pi-ai-0.83.0.tgz | grep providers/data
tar tzf  earendil-works-pi-agent-core-0.83.0.tgz | grep -i licen     # (no matches)
grep -rl 'from "node:' <agent-core>/dist --include=*.js               # → only harness/env/nodejs.js
git -C pi log --oneline -5
git -C pi ls-files packages/ai/src/providers/data                     # (empty — untracked)
awk '/^## \[/{v=$0} /^### Breaking Changes/{print v}' pi/packages/agent/CHANGELOG.md
git check-ignore -v pi                                                # (no match)
```

Files read: `pi/package.json`, `pi/packages/agent/package.json`,
`pi/packages/ai/package.json`, `pi/packages/agent/CHANGELOG.md`,
`pi/packages/ai/CHANGELOG.md`, `pi/scripts/check-browser-smoke.mjs`,
`pi/scripts/agent-treeshake-smoke-entry.ts`, `pi/scripts/browser-smoke-entry.ts`,
`pi/packages/ai/scripts/check-model-data.ts`, `pi/.github/workflows/ci.yml`,
`pi/packages/agent/src/harness/types.ts`.

---

## Not verified

- **Actual bundle size of our app with pi in it.** Everything above about treeshaking is
  read off pi's own assertions and its dependency graph; nothing was bundled here. That
  measurement belongs to [08-bundle-cost](../tickets/08-bundle-cost.md).
- **Whether Vite/Rollup treeshakes the `@earendil-works/pi-ai` barrel as well as esbuild
  does.** pi only ever asserts it under esbuild. This is the single most load-bearing
  unverified claim in this document.
- **Whether `pi-agent-core`'s browser-safe surface is genuinely free of `node:` at
  runtime.** Static grep of the published `dist` found `node:` imports in exactly one
  file (`dist/harness/env/nodejs.js`, reachable only via the `./node` export), which
  matches the map's note. Not executed, not bundled.
- **The `[Unreleased]` session-store rewrite's final shape.** It is unreleased; it may
  change again before it lands.
- **Whether older releases (pre-0.74) were also gated by `check:browser-smoke` on
  publish.** Only the current `pi/package.json` was read; the gate's introduction date
  was not traced.
- **Download counts / real-world adoption of these packages.** Not queried.
- **`legacy-node20` dist-tag policy** — whether it is still maintained or frozen at
  0.74.2 (last published 2026-05-21, ~10 weeks stale, which suggests frozen).
