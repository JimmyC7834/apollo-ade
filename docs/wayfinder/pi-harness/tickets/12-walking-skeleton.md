---
label: wayfinder:prototype
title: Thinnest end-to-end turn
parent: ../map.md
blocked-by: [01-execution-env-surface.md, 05-event-contract.md, 06-credentials-and-http.md]
assignee: jc4649
status: open
---

# Thinnest end-to-end turn

## Question

A throwaway spike to test whether the contracts agreed upstream survive contact with a
real turn. **Not** the beginning of the harness — delete it afterward. This map is
planning-only; the prototype exists to falsify decisions, not to ship.

One prompt from the ADE chat panel → a real streamed model response → one tool call
(`read`) → tool result fed back → final text rendered in the panel. No sessions, no
compaction, no profiles, no permissions, no rtk.

What it is trying to falsify:

- **Does the `AgentEvent` contract from [Where pi's event stream meets the ADE](05-event-contract.md)
  actually carry a real streamed turn**, or does it need fields nobody predicted? This
  is the main event. A contract designed against a scripted provider has never seen a
  model change its mind mid-stream.
- **Does the `ExecutionEnv` from [ticket 01](01-execution-env-surface.md) satisfy pi's
  never-throw invariant under a real tool call** — including the failure path. Point it
  at a file that does not exist and confirm a `Result` comes back rather than a rejected
  `invoke` bubbling into pi's loop.
- **Does the credential shape from [ticket 06](06-credentials-and-http.md) actually
  stream?** If Rust proxies the HTTP, this is the first time streamed bytes cross the
  IPC, and it is the riskiest thing on that ticket.
- **Does Rollup treeshake pi as well as esbuild did?** Carried here by
  [What pi costs in the bundle](08-bundle-cost.md), which measured under esbuild only.
  `pi-agent-core` declares no `sideEffects` field and its dist imports pi-ai's *barrel*
  rather than subpaths, so this is the first honest test through the real Vite config.
  Record the gzip delta against the pre-pi baseline of 1,122 kB.
- **What do providers do with an orphaned `tool_use` block?** Added by
  [What a profile switch leaves behind](14-switch-aftermath.md), which established that pi
  passes history through unfiltered and therefore cannot answer this for us. Once a tool
  call has completed, re-send the same history with that tool removed from the request
  schema and record what each provider does — Anthropic, OpenAI and Google may differ, and
  all three are bundled. This is the cheapest possible probe *given a turn that already
  works*, which is why it lives here rather than in its own ticket. It is a measurement,
  not a feature: it does not make the spike grow.
- **Does the renderer keep up?** `context.md` warns the browser pane serves no animation
  frames and is not equivalent to the native window. A fast token stream into React is
  exactly the case that differs, so **this must be run natively** —
  `docs/OPEN-ISSUES.md` documents the WebView2 debugging port.

Explicitly out of the spike: making it good, making it survive, or letting it grow a
second feature. If it works, record what it proved and delete the code. If it fails,
that is a better outcome — reopen whichever ticket it falsified.

One caution from `docs/OPEN-ISSUES.md` worth reading first: a hand-rolled
`plugin:event|listen` payload wedges the IPC, after which every `invoke` hangs while the
renderer keeps running — indistinguishable from the command under test deadlocking. An
hour has already been lost to that once.

---

## Progress — the spike is built; the live run has not happened

`src/spike/` holds it: `env.ts`, `events.ts`, `provider.ts`, `events.check.ts`. It is
wired in `WorkbenchController.tsx` behind `readSpikeConfig()`, so it takes over only when
`VITE_SPIKE_BASE_URL` and `VITE_SPIKE_MODEL` are both set. With them unset the scripted
provider runs exactly as before. **Deleting the spike is `rm -r src/spike` plus one
ternary.**

### Settled without a model

- **Rollup treeshakes pi at least as well as esbuild did.** Main chunk went
  1,121.91 → **1,192.96 kB gzip (+71.05 kB)**, plus a **40.15 kB gzip** code-split
  `openai-completions` chunk that only loads on the first stream. Total **+111.2 kB gzip**
  against esbuild's predicted +95.6 kB — but the two are not measuring the same thing:
  esbuild measured `Agent` + one provider, while this is the whole `AgentHarness`, the
  session tree, the `read` tool, `typebox`, `diff`, `yaml` and `ignore`. **More code for
  16% more bytes is a good result, and the `lazyApi` dynamic import survives Rollup as a
  real chunk** — which the flat esbuild measurement could not have shown.
  [What pi costs in the bundle](08-bundle-cost.md)'s guard holds.
- **The eleven-kind contract type-checks against pi's real event union**, and
  `events.check.ts` runs green in `npm run check`. That is not falsification — fixtures
  prove only that the mapping does not drop what it claims to carry.
- **`ExecutionEnv` is 12 filesystem methods, `exec`, *and* `cleanup()`.** `cleanup` is
  declared on both `FileSystem` and `Shell` and was missed by every survey in
  [ticket 01](01-execution-env-surface.md), which is now amended. It is the third time
  that method list has been wrong, and the third time in the same direction.
- **`read` needs only three env methods**: `absolutePath`, `exists`, `readBinaryFile`
  (plus `cwd`). It reaches them through `resolveReadToolPath`, which tries five Unicode
  normalisation variants of the path before giving up.
- **pi's own tools break the never-throw invariant on purpose.** `path-utils.js` wraps
  `absolutePath` and `exists` in `getOrThrow`. So the invariant binds the *env*, and pi
  converts to exceptions one layer up, catching them in the tool executor. Our adapter
  still must never throw; we simply do not get to assume pi propagates `Result` all the
  way.
- **The path namespace can stay root-relative.** The spike's env roots at `/` and passes
  root-relative ids to `WorkspaceProvider`, so the renderer never learns the OS path and
  commit 639ce9a's boundary survives contact with pi. A model asking for `C:\Users\...`
  gets a miss, not a read.
- **Keyless auth is expressible without a fake key.** `resolve: async () => ({ auth: {} })`
  is enough; returning `undefined` would mark the provider unconfigured and make its
  models unavailable. Run two replaces exactly this function and nothing else.

### Settled by a live run

**DeepSeek (`deepseek-chat`, served as `deepseek-v4-flash`), in the native window, 2 Aug
2026.** Confirmed by the dev at the keyboard; the renderer was not instrumented, so what
follows is an observation rather than a measurement, and the two probes below that need
instrumentation are still open.

- **The loop closes.** One prompt → streamed response → a `read` tool call → tool result →
  a final answer grounded in the file. pi's harness runs in the WebView, and
  `ExecutionEnv` over `WorkspaceProvider` satisfies `createReadTool` against a real call.
- **`AgentEvent` survived contact with a real stream.** The tool call rendered as an
  activity line carrying its path, prose rendered as prose, and nothing leaked through as
  raw JSON — which is what a dropped or mis-mapped event kind would have looked like. The
  eleven-kind contract from [ticket 05](05-event-contract.md) stands, unamended.
- **The renderer keeps up.** Text streamed smoothly, natively, with no visible chunking.
  This is the question `context.md` says the browser pane cannot answer, and it is now
  answered.

**The route was not the planned one.** Local-then-DeepSeek was designed so the API key
would be the only variable between two runs. That fell through — see below — so the
credential was neutralised with a dev-server proxy instead, and DeepSeek was the only run.

### Local models could not run the spike at all

Worth recording, because it will come up again the moment anyone tries to work offline.
**Every local model on this machine emits tool calls as prose, not as structured calls.**

| Model | Result |
|---|---|
| `qwen2.5-coder:7b` | `{"name": "read", "arguments": {...}}` as message **content** |
| `qwen2.5-coder:14b` | the same, wrapped in a ```json fence — worse |
| `codestral:22b` | `does not support tools`, refused by Ollama outright |

The first two declare a `tools` capability in `ollama show`. The capability flag says the
template *accepts* tool definitions, not that it *parses* calls back out. Identical on
`/v1/chat/completions` and `/api/chat`, so it is the model's chat template, not Ollama's
OpenAI shim.

**This is not a pi problem and not a spike bug** — pi needs a `toolCall` content block, and
prose that looks like JSON renders as prose. The consequence for
[browser mode](10-browser-mode-env.md) is real: a local model is not a drop-in substitute
for a hosted one, and any offline story has to name models whose templates parse tool
calls, not merely accept them.

### Not settled — still needs work

Three things the happy path could not answer. All three want the WebView2 debugging port
(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`), because they are
about what the event stream contains rather than what the transcript shows.

1. **The failure path.** Point `read` at a file that does not exist and confirm a `Result`
   comes back rather than a rejected `invoke` reaching pi's loop. Note that pi's
   `path-utils` wraps `exists` in `getOrThrow`, so the throw is *expected* one layer up —
   what must hold is that our adapter never throws and the tool executor catches. A
   passing happy path says nothing about this.
2. **The orphaned `tool_use` probe**, carried here from
   [ticket 14](14-switch-aftermath.md). Re-send a history containing a completed tool call
   with that tool removed from the request schema, and record what each provider does.
   Only DeepSeek is currently reachable; Anthropic and Google still need one call each.
3. **Which event kinds never fired.** `thinking`, `usage`, `compacted` and `error` are all
   in the contract and none were exercised — the UI adapter drops the middle two before
   they could be seen, and `deepseek-chat` is not a reasoning model. The contract is
   *unfalsified*, not *confirmed*, on those four.

**The credential path is still not built, and this run did not test it.**
`import.meta.env` inlines its values into the build output, so a real key there would be
baked into `dist/`. The Vite proxy sidesteps that by attaching the header in Node — but no
streamed bytes crossed the Tauri IPC, which is the single riskiest thing on
[ticket 06](06-credentials-and-http.md) and the reason it wanted this spike. **That work is
untouched and is the obvious next move.**
