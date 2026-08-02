---
label: wayfinder:research
title: How this repo depends on pi, and what happens when pi moves
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# How this repo depends on pi, and what happens when pi moves

## Question

The destination turns pi from something we read into something we ship. That changes
what `pi/` is, and right now it is nothing formal.

Current state, verified: `pi/` is a **plain clone of `github.com/earendil-works/pi` at
`aa0ec808b`**, untracked by this repo's git, not a submodule (there is no
`.gitmodules`), not in `.gitignore`, and not referenced from `package.json`. It is a
reading copy left over from the paused map — appropriate then, meaningless as a
dependency now.

Research and settle:

- **Is `@earendil-works/pi-agent-core` published, and at what cadence?**
  `packages/agent/README.md` documents `npm install @earendil-works/pi-agent-core`, and
  the workspace is at **0.83.0** — pre-1.0, so semver promises little. Establish the
  actual release rhythm and whether breaking changes land in minors.
- **npm dependency, git submodule, or vendored copy.** Each has a real cost here. An
  npm dep is cleanest but the browser-safety guarantee we are relying on is enforced by
  *their CI*, not by anything we can see at install time. A submodule pins a commit and
  lets us run their `check-browser-smoke` ourselves. Vendoring means owning merges,
  which the map already rejected as a destination but is a different question as a
  distribution mechanism.
- **Which packages are actually depended on.** `pi-agent-core` pulls `pi-ai`, and
  `pi-ai` carries a generated model catalog — `check-browser-smoke.mjs` has a plugin
  stubbing `packages/ai/src/providers/data/*.json` because *"fresh checkouts do not
  materialize provider JSON until model data is hydrated."* Find out whether a
  published tarball ships that data or whether a build step generates it, because it
  changes both install and bundle. Overlaps [What pi costs in the bundle](08-bundle-cost.md).
- **What we do when pi breaks us.** Not hypothetical at 0.x. Decide the posture: pin
  and upgrade deliberately, or track and absorb. Note that upstream has no obligation to
  keep `ExecutionEnv` stable, and it is the one interface this entire map depends on.
- **License and attribution.** pi is MIT per the package manifests; confirm across the
  packages actually shipped and record what this repo owes.
- **Whether the reading copy stays.** Even with an npm dependency, having the source
  checked out is useful — several tickets on this map cite line numbers in it. Decide
  whether it becomes a submodule, is gitignored, or is removed once it is a real
  dependency.

Produce a short markdown summary as a linked asset.

---

## Resolution

**npm dependency, exact-pinned. Not a submodule, not vendored.**

Full evidence: [07-pi-dependency-research.md](../assets/07-pi-dependency-research.md).
Network was available; everything below is verified against the live registry and the
local clone.

**Decisions:**

1. **Depend on `@earendil-works/pi-agent-core` at an exact version (`"0.83.0"`, no
   caret).** `pi-ai` arrives transitively and is the only other `@earendil-works`
   package involved.
2. **Not a submodule.** The ticket's central asymmetry — "their CI enforces
   browser-safety and an npm install can't re-run it" — largely dissolves: pi's root
   `prepublishOnly` is `clean && build && check`, and `check` includes
   `check:browser-smoke` (`pi/package.json:18-19,39`). It is a **publish** gate, so
   every published version already passed it. Re-running it from a submodule needs a
   full monorepo `npm ci` (upstream CI installs cairo/pango/librsvg first) plus network
   model-data hydration, to learn what we already know.
3. **Our own bundle guard instead** — assert no `node:` builtins and none of
   aws-sdk/genai/mistralai/openai reach our production bundle. Same conclusion the
   bundle ticket reached from the other direction; build it once.
4. **Posture: pin and upgrade deliberately.** Never track-and-absorb — see the release
   data below.
5. **Do not implement pi's interfaces directly.** Put them behind our own domain
   interface with a thin adapter, so an upstream rename has a bounded blast radius.
   This also satisfies `context.md`'s rule that feature code consumes domain
   interfaces.
6. **`pi/` gets gitignored and its commit recorded.** Untracked-and-unignored — today's
   state — is the one bad option.

**Facts worth carrying forward:**

- **Model catalog ships in the tarball.** Verified by `npm pack` + `tar tzvf`: 38 JSON
  files, 481,153 bytes under `dist/providers/data/`. No build step, no install-time
  hydration. The "fresh checkouts do not materialize" comment in
  `check-browser-smoke.mjs` is about *source* checkouts — the directory is gitignored
  upstream. Consistent with the bundle ticket's finding that it treeshakes per-provider.
- **Neither tarball ships a LICENSE file** (`files: ["dist","README.md"]`). pi is MIT,
  but a scanner will not find the text in `node_modules`. If the ADE ships as a binary,
  we must copy pi's MIT text into third-party notices ourselves.

**Residual risk:** whether Vite/Rollup treeshakes pi-ai's root barrel as well as esbuild
does. pi only ever asserts it under esbuild, and `pi-agent-core`'s dist imports the
barrel rather than subpaths. Same risk the bundle ticket flagged, reached
independently; it is carried by [Thinnest end-to-end turn](12-walking-skeleton.md).
