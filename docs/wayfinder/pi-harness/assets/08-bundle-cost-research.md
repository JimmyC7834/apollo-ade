# What pi costs in the bundle — measured

Research asset for [ticket 08](../tickets/08-bundle-cost.md). All figures below are
**measured** on this machine (Windows 10, Node v24.16.0, esbuild 0.28.1, pi monorepo at
`pi/`, version 0.83.0) unless a line says otherwise. Anything not measured is in the
[Not verified](#not-verified) section.

## Verdict

**Acceptable — comfortably. Do not reopen the sidecar.**

The threshold set before measuring: **disqualifying** if pi more than doubles the
shipped bundle or adds >1 MB gzip; **borderline** at 300 KB–1 MB gzip; **acceptable**
under ~200 KB gzip, which is <20% of what Monaco already costs.

The realistic import shape — `pi-agent-core` plus one explicitly-imported provider —
lands at **98 KB gzipped (357 KB minified)**. This app already ships **1.107 MB gzipped
of Monaco alone**. pi is **+8.8%** on the existing bundle. Three providers is 193 KB
gzip (+17%).

There is one real trap, and it is cheap to avoid: **never import
`@earendil-works/pi-ai/compat` or `@earendil-works/pi-ai/providers/all`.** Either one
pulls all 37 provider catalogs (472 KB of JSON) and all five vendor SDKs, taking the
bundle to **436–448 KB gzip / 2.4 MB minified** — 4.6× the selective number. pi's own CI
already guards this for its own smoke entry; **we must adopt the same guard in this
repo** (see [Recommendations](#recommendations)).

## Baseline: this repo's current frontend bundle

Command: `npm run build` (repo root, after `rm -rf dist`).

| Artifact | Raw | Gzip |
| --- | --- | --- |
| `dist/assets/index-*.js` (the one big chunk) | 4,282.40 kB | 1,121.91 kB |
| All `dist/**/*.js` on disk (93 files, incl. 89 Monaco language chunks) | 12,595,638 B | not measured |
| Whole `dist/` on disk | 13,033,664 B | not measured |
| **Monaco alone**, bundled standalone with esbuild (`import * as m from "monaco-editor"`, minified) | 4,260,572 B JS + 260,794 B CSS | 1,106,563 B JS + 87,401 B CSS |

Monaco is **~99% of the main chunk** (1.107 MB of the 1.122 MB gzip). Build wall time:
**26.7 s** (`✓ built in 26.69s`, `real 0m30.259s`). Vite already warns the chunk exceeds
500 kB.

## pi bundle sizes

esbuild, `platform: "browser"`, `format: "esm"`, `bundle: true`, `metafile: true`,
resolving through the built `dist/` of `@earendil-works/pi-ai` and
`@earendil-works/pi-agent-core` (i.e. the same thing an npm consumer gets).

| Scenario | Raw | Minified | Gzip | Catalog JSON files pulled | Vendor SDKs pulled |
| --- | ---: | ---: | ---: | ---: | --- |
| `Agent` only (no provider) | 549,219 | 220,261 | **61,621** | 0 | none |
| `pi-ai` barrel only (`export * from "@earendil-works/pi-ai"`) | 494,500 | 197,838 | **53,496** | 0 | none |
| **`Agent` + `providers/anthropic` (the realistic shape)** | 904,345 | 356,748 | **97,878** | 1 (5,960 B) | `@anthropic-ai/sdk` |
| `Agent` + anthropic + openai + google | 2,010,464 | 799,413 | **193,309** | 3 (32,578 B) | +`openai`, `@google/genai` |
| `Agent` + `providers/all` | 5,313,264 | 2,399,043 | **448,351** | 38 (475,886 B) | all 5 |
| `pi-ai/compat` only | 5,225,549 | 2,359,608 | **435,692** | 37 (472,433 B) | all 5 |
| Barrel + compat (mirrors `scripts/browser-smoke-entry.ts`) | 5,318,673 | 2,398,980 | **450,629** | 37 (472,433 B) | all 5 |

Relative to the current app (1,121.91 kB gzip main chunk):

| Import shape | Δ gzip | % increase |
| --- | ---: | ---: |
| One provider | +95.6 kB | **+8.8%** |
| Three providers | +188.8 kB | +17.2% |
| `providers/all` / `compat` | +437.8 kB | +40.0% |

## Metafile: top contributors

### `Agent` + `providers/anthropic` (904,345 B raw, 670 input files)

| # | Bytes in output | Input |
| ---: | ---: | --- |
| 1 | 37,227 | `node_modules/typebox/build/type/script/parser.mjs` |
| 2 | 35,946 | `packages/ai/src/api/anthropic-messages.ts` |
| 3 | 28,812 | `node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs` |
| 4 | 26,956 | `node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs` |
| 5 | 23,402 | `node_modules/@anthropic-ai/sdk/client.mjs` |
| 6 | 17,327 | `node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs` |
| 7 | 17,069 | `node_modules/typebox/build/schema/engine/schema.mjs` |
| 8 | 16,486 | `packages/agent/src/agent-loop.ts` |
| 9 | 16,094 | `node_modules/typebox/build/type/script/mapping.mjs` |
| 10 | 15,510 | `node_modules/ignore/index.js` |
| 11 | 13,761 | `packages/ai/src/models.ts` |
| 12 | 13,040 | `packages/agent/src/agent.ts` |
| 13 | 9,492 | `node_modules/@anthropic-ai/sdk/core/streaming.mjs` |
| 14 | 9,401 | `node_modules/yaml/browser/dist/stringify/stringifyString.js` |
| 15 | 7,773 | `node_modules/partial-json/dist/index.js` |
| 16 | 7,374 | `node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs` |
| 17 | 7,258 | `packages/ai/src/utils/validation.ts` |
| 18 | 6,868 | `node_modules/typebox/build/type/engine/instantiate.mjs` |
| 19 | 6,016 | `node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs` |
| 20 | 5,994 | `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs` |
| 21 | 5,960 | `packages/ai/src/providers/data/anthropic.json` (the *only* catalog file) |
| 22 | 5,705 | `node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs` |

By package: `typebox` 388,630 · `@anthropic-ai/sdk` 248,886 · `yaml` 70,392 ·
`ignore` 15,510 · `partial-json` 9,083 · **node_modules total 732,501**.

By source group: `packages/agent/src` **31,645 B** · `packages/ai/src` **98,164 B** ·
node_modules **732,718 B**. **pi's own ~21,000 lines of `pi-ai` contribute under 100 KB
raw.** The weight is third-party: TypeBox (the schema engine) and the Anthropic SDK.
The map's "prime suspect: pi-ai" is, on the evidence, **wrong** — pi-ai treeshakes down
to almost nothing; its *dependencies* are the cost, and they are per-provider.

### `providers/all` / `compat` (5.3 MB raw, 2,135 input files) — what to avoid

| Bytes | Input |
| ---: | --- |
| 704,130 | `node_modules/@google/genai/dist/web/index.mjs` |
| 186,284 | `node_modules/@opentelemetry/semantic-conventions/.../index-incubating.js` |
| 159,306 | `node_modules/@opentelemetry/semantic-conventions/.../experimental_attributes.js` |
| 115,651 | `node_modules/zod/v3/types.js` |
| **111,036** | `packages/ai/src/providers/data/openrouter.json` |
| **65,556** | `packages/ai/src/providers/data/vercel-ai-gateway.json` |
| 57,126 | `node_modules/zod/v4/core/schemas.js` |
| 52,250 | `node_modules/@opentelemetry/semantic-conventions/.../experimental_metrics.js` |
| **46,565** | `packages/ai/src/providers/data/amazon-bedrock.json` |
| 46,472 | `packages/ai/src/api/openai-codex-responses.ts` |
| 45,146 | `packages/ai/src/api/openai-completions.ts` |
| **26,025** | `packages/ai/src/providers/data/opencode.json` |

By package: `@mistralai/mistralai` **1,459,035** · `@google/genai` **704,130** ·
`zod` 570,386 · `@opentelemetry/semantic-conventions` 419,043 · `typebox` 390,019 ·
`openai` 297,023 · `@anthropic-ai/sdk` 249,262 · `zod-to-json-schema` 47,601 ·
`@opentelemetry/api` 36,634.

Mistral's SDK alone (1.46 MB raw) is a third of this bundle and would be pure dead
weight.

## Treeshaking

- `@earendil-works/pi-client` — `"sideEffects": false`.
- `@earendil-works/pi-ai` — **`"sideEffects"` is an allow-list, not `false`**:
  `["./dist/compat.js", "./dist/images.js", "./dist/providers/images/register-builtins.js"]`.
  Everything else is declared side-effect-free. This is a deliberate, correct
  declaration: the three listed files are exactly the ones that register providers
  globally as a side effect.
- `@earendil-works/pi-agent-core` — **no `sideEffects` field at all.** It still treeshook
  fine under esbuild (31,645 B of agent source in the one-provider bundle), but a
  bundler that honours the field conservatively gets no help. This is the one small
  upstream gap worth reporting.
- `@earendil-works/pi-protocol` — no `sideEffects` field.

It treeshakes well **in practice**, but only because the *import path* is narrow. The
`sideEffects` metadata is not what saves you here; module granularity is.

### What pi's `check-browser-smoke.mjs` actually asserts

Two builds. The first (`scripts/browser-smoke-entry.ts`) only proves the code **compiles
for `platform: "browser"`** with no Node-only imports — it makes no size claim, and it
is the one that imports `/compat` and therefore pulls all 37 catalogs.

The second (`scripts/agent-treeshake-smoke-entry.ts`) is the size-shaped guard, and it
asserts exactly three things against the metafile:

1. The bundle must **not** contain `packages/ai/src/compat.ts`,
   `packages/ai/src/models.generated.ts`, or `packages/ai/src/providers/all.ts`.
2. Exactly **one** file from `packages/ai/src/providers/data/` may contribute bytes, and
   it must be `anthropic.json`.
3. Exactly **one** vendor SDK may be present, and it must be `@anthropic-ai/sdk` — not
   `@aws-sdk/client-bedrock-runtime`, `@google/genai`, `@mistralai/mistralai`, or
   `openai`.

So upstream has already identified this exact failure mode and pinned it in CI. Our
measurements confirm the guard is load-bearing: violating it costs 4.6× gzip.

## The model catalog

- 37 generated JSON files, **470,300 B** total on disk in
  `packages/ai/src/providers/data/` (plus a 3,353 B `.manifest.json`). Not present in a
  fresh checkout — produced by `npm run hydrate:model-data`.
- 82 provider `.ts` modules in `packages/ai/src/providers/` (the "~45 providers" figure
  in `docs/RESEARCH-agent-harnesses.md` undercounts modules; 37 have catalog data).
- **A narrower import path exists and works.** `@earendil-works/pi-ai/providers/*` is a
  first-class export subpath. Importing `providers/anthropic` pulls **one** catalog file
  (5,960 B). Importing three pulls three (32,578 B). Importing `providers/all` or
  `compat` pulls **all 37 (472,433 B)** because `all.ts` statically imports every
  provider module *and* `data/.manifest.json`.
- Catalog cost scales linearly and per-provider. The worst individual offenders are
  `openrouter.json` (109,895 B on disk) and `vercel-ai-gateway.json` (65,140 B) — both
  aggregator catalogs we would have no reason to ship.

**This is the cheap fix the ticket predicted, and it is already available upstream — no
patch needed, only import discipline.**

## Build / dev-server impact

| Measurement | Value |
| --- | --- |
| Repo `npm run build` today | 26.7 s vite build (30.3 s wall) |
| esbuild bundle of `Agent` + anthropic, minified, cold | **177 ms** |
| esbuild bundle of the full barrel + compat, minified | **423 ms** |
| `pi/packages/ai` build (`npm run build:offline`, data already hydrated) | 7.7 s |
| `pi/packages/agent` build (`npm run build`) | 2.1 s |

pi adds well under a second of bundler work at the selective import shape. Against a
26.7 s Monaco-dominated build this is noise.

## Recommendations

1. **Import providers explicitly**, one subpath at a time:
   `@earendil-works/pi-ai/providers/anthropic`. Never `/compat`, never `/providers/all`.
   This is also the shape upstream's own treeshake smoke uses, so it stays supported.
2. **Add a bundle guard in this repo** mirroring the three assertions in
   `pi/scripts/check-browser-smoke.mjs` — no `compat.ts`, no `providers/all.ts`, no
   `models.generated.ts`, and an allow-list of catalog JSON + vendor SDKs. It is ~40
   lines of esbuild metafile inspection and it is the only thing standing between us and
   a 4.6× regression from one careless import.
3. **Treat the provider set as a product decision.** Each additional provider costs
   roughly 50–100 KB gzip (google is the expensive one at ~700 KB raw; mistral at 1.46 MB
   raw is the worst). This interacts directly with the profile data model — a profile
   naming a model implies its provider is bundled.
4. **Consider lazy-loading providers** via dynamic `import()` if more than two or three
   are ever wanted. `pi-ai`'s subpath exports make this straightforward and it would take
   the fixed cost back to the 62 KB gzip `Agent`-only floor. Not needed now.
5. **Nothing here justifies reopening the sidecar.** The map's rejection stands on the
   measured evidence.

## Commands run

```sh
# baseline
cd <repo> && rm -rf dist && npm run build

# pi setup (pi/ is an untracked clone; node_modules and provider JSON were absent)
cd pi && npm install --ignore-scripts
npm run hydrate:model-data                 # materializes packages/ai/src/providers/data/*.json
cd packages/ai    && npm run build:offline
cd ../agent       && npm run build

# measurement: esbuild platform:"browser", format:"esm", bundle, metafile,
# once unminified (for the metafile) and once minified (gzipped with node:zlib).
# Scripts lived in the scratchpad and in pi/.tmp-measure*.mjs; both removed afterwards.
```

Scenario entry points used (verbatim):

```ts
// agent-core-only
import { Agent } from "@earendil-works/pi-agent-core"; export { Agent };

// selective-anthropic  (mirrors pi's own agent-treeshake-smoke-entry.ts)
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

// compat-only
export * from "@earendil-works/pi-ai/compat";

// agent-plus-all-providers
import * as all from "@earendil-works/pi-ai/providers/all";
```

## Not verified

- **pi was not bundled through this repo's actual Vite config.** Doing so would require
  importing pi from tracked `src/`, which this ticket is not permitted to modify. All pi
  figures are esbuild, matching the technique pi's own CI uses. Rollup/Vite output would
  differ somewhat (different minifier, chunking, and `sideEffects` handling) — the
  *ordering* of the scenarios is what should be trusted, not the last digit.
- **The delta to `npm run build` and to dev-server cold start with pi actually imported
  by the app** was not measured, for the same reason. The 177 ms standalone esbuild
  figure is a lower bound, not the vite delta.
- **`npm run tauri build`** was not run at all. The Rust side is unaffected by frontend
  bundle size beyond the bytes embedded in the binary; no measurement taken.
- **Gzip figures for the repo's `dist/` as a whole** — only the per-chunk gzip numbers
  vite itself prints were captured.
- **Runtime cost** (parse/eval time of the extra bytes in a WebView) was not measured;
  only transfer/disk size.
- **Whether every provider actually treeshakes to its own catalog file.** Verified for
  `anthropic` (1 file) and for anthropic+openai+google (3 files); inferred, not measured,
  for the remaining providers.
- The `~21,000 lines / ~45 providers` claim in `docs/RESEARCH-agent-harnesses.md` was not
  re-counted; 82 provider `.ts` modules and 37 catalog JSON files were counted directly.
