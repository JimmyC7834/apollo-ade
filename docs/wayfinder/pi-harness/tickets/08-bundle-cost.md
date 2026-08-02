---
label: wayfinder:research
title: What pi costs in the bundle
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# What pi costs in the bundle

## Question

The cheapest ticket that could kill the destination, which is why it is on the frontier
rather than deferred. In-process means *in the bundle*, and this app already ships
Monaco.

What is known: pi's own CI proves the code **can** be bundled for the browser —
`scripts/check-browser-smoke.mjs` esbuilds `Agent`, the session repository, skills,
prompt templates, tools, and the CBOR protocol with `platform: "browser"`, and fails on
any Node-only import. It does not prove the result is a sensible size. The suspicious
part is `pi-ai`: the paused map cited this repo's own research doc putting it at
roughly 21,000 lines across ~45 providers and 10 wire APIs, plus a generated model
catalog of JSON data files.

Research and settle:

- **Measure it.** Bundle `pi-agent-core` through this repo's actual Vite config and
  report the number, not an estimate. The smoke script is a working template — it even
  has a `metafile`-style input inspection (`findInput`, `includesNodePackage`) to prove
  what did and did not get pulled in.
- **Does it treeshake?** `pi-client` sets `"sideEffects": false`; check whether `pi-ai`
  and `pi-agent-core` do too. The smoke script bundles an *agent treeshake* output
  separately (`pi-agent-treeshake-smoke.js`), which suggests upstream cares — find out
  what that check actually asserts.
- **The model catalog.** Whether all ~45 providers' JSON lands in the bundle or only
  what is imported. If it is all of them, whether a subset import exists. This is the
  most likely source of dead weight and the most likely to have a cheap fix.
- **What this means for `npm run tauri build`** and for dev-server startup, which is a
  daily-friction question rather than a shipping one.
- **The threshold.** Decide in advance what number would be a problem, so the answer is
  judged rather than rationalized.

If the number is bad, say so plainly — the map's **Out of scope** section records that
the sidecar route was rejected, and an unacceptable bundle is exactly the evidence that
would justify reopening the destination.

Produce a short markdown summary as a linked asset, including the measured figures.

---

## Resolution

**Acceptable. The destination stands; the sidecar stays out of scope.**

Full evidence: [08-bundle-cost-research.md](../assets/08-bundle-cost-research.md).

Measured with esbuild `platform:"browser"`, gzip via `node:zlib`:

| Bundle | Raw | Minified | Gzip |
|---|---:|---:|---:|
| Repo today (`dist/assets/index-*.js`) | — | 4,282 kB | **1,122 kB** |
| └ Monaco alone | — | 4,261 kB | 1,107 kB (~99%) |
| `Agent`, no provider | 549 kB | 220 kB | **62 kB** |
| `Agent` + `providers/anthropic` | 904 kB | 357 kB | **98 kB (+8.8%)** |
| `Agent` + 3 providers | 2,010 kB | 799 kB | 193 kB (+17%) |
| `providers/all` or `/compat` | 5,313 kB | 2,399 kB | **448 kB (+40%)** |

**The prime suspect was wrong.** pi-ai's own source contributes 98 KB raw to a selective
bundle and pi-agent-core 32 KB — the ~21,000 lines treeshake away. The weight is
third-party: `typebox` (389 KB), `@anthropic-ai/sdk` (249 KB), and those are
*per-provider*. Against Monaco's 1,107 kB gzip, one provider costs 8.8%.

**The model catalog is per-provider and the narrow import path already exists.**
`providers/anthropic` pulls one JSON (5,960 B); `providers/all` and `/compat` pull all
37 (472 KB) plus five vendor SDKs (`@mistralai/mistralai` alone is 1.46 MB raw). The fix
is import discipline, not a patch.

**`sideEffects` metadata:** `pi-client` is `false`; `pi-ai` is a correct 3-entry
allow-list; **`pi-agent-core` and `pi-protocol` declare none at all.** They treeshake
under esbuild anyway, but the gap is real and matters for Rollup — see *Residual risk*.

**Decisions this produces:**

1. **Import providers by subpath, never the barrel.** `@earendil-works/pi-ai/compat` is
   a 4.6× gzip regression, and pi's own *browser*-smoke entry imports it, so it looks
   blessed. It is not, for us.
2. **A repo-side bundle guard**, mirroring what upstream's treeshake smoke asserts: the
   metafile contains no `compat.ts` / `models.generated.ts` / `providers/all.ts`,
   exactly one catalog JSON, and exactly one vendor SDK. ~40 lines of metafile
   inspection. Upstream already found this failure mode and pinned it; we inherit the
   lesson, not the check.
3. **The provider set is a bundle decision, not only a config one.** Each provider is
   ~50–100 KB gzip. This couples to
   [What is a profile, concretely?](04-profile-data-model.md) — a profile naming a model
   implies bundling its SDK. Beyond two or three providers, dynamic `import()` per
   subpath returns the fixed cost to the 62 KB floor.

**Residual risk, not closed by this ticket:** pi was bundled with esbuild, not through
this repo's actual Vite/Rollup config — that needs importing pi from tracked `src/`,
which a planning ticket may not do. Combined with the missing `sideEffects` field on
`pi-agent-core`, and the fact that its dist imports pi-ai's *barrel* rather than
subpaths, **Rollup may not treeshake as well as esbuild did.** Confirm in
[Thinnest end-to-end turn](12-walking-skeleton.md), which bundles for real. Trust the
ordering of these scenarios, not the last digit.

### Amendment — all providers are in scope

The dev ruled the full-provider figure acceptable: 448 kB gzip against a 1,122 kB
baseline. So **v1 is not restricted to one provider family**, and the "which provider is
wired first" sub-question on
[Who holds the API key](06-credentials-and-http.md) is about ordering, not exclusion.

This settles *capability scope*, not *delivery*. Two ways to have all providers:

- **Static, via the barrel or `/compat`** — the measured 448 kB gzip, paid by everyone
  on first load, including users who only ever touch one model.
- **Dynamic `import()` per provider subpath** — the same capability with the fixed cost
  back at the 62 kB floor, each provider's ~50–100 KB arriving only when a profile
  actually selects it.

The second delivers the ruling at a fraction of the cost, so the recommendation stands
that it is preferred — but the choice belongs to
[What is a profile, concretely?](04-profile-data-model.md), because it is really a
question about when a profile's model field is resolved.

**The bundle guard survives this amendment**, with its assertions loosened: it should
still fail on `node:` builtins reaching the bundle, and still fail on an *accidental*
`/compat` import if the dynamic route is chosen. Its job was never to enforce one
provider — it was to stop a one-line import silently multiplying the bundle.
