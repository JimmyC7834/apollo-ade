---
label: wayfinder:prototype
title: Thinnest end-to-end turn
parent: ../map.md
blocked-by: [01-execution-env-surface.md, 05-event-contract.md, 06-credentials-and-http.md]
assignee: jc4649
status: closed
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

## Resolution

**Everything the spike set out to falsify held. Nothing upstream reopens.** The one
finding that changes a plan is about local models, and it belongs to
[browser mode](10-browser-mode-env.md), not to any decision made here.

| What it tried to falsify | Outcome |
|---|---|
| Does `AgentEvent` carry a real streamed turn? | **Held**, unamended |
| Does `ExecutionEnv` satisfy never-throw under a real tool call, including failure? | **Held** |
| Does the credential shape actually stream? | **Held** — 14 chunks over 722 ms |
| Does Rollup treeshake pi as well as esbuild? | **Yes**, and better than measured |
| What do providers do with an orphaned `tool_use`? | DeepSeek: accepts. Others deferred |
| Does the renderer keep up? | **Yes**, natively |

Three things were learned that no amount of reading would have produced, and all three are
about the same failure mode — **the code that only runs when something goes wrong**:

1. `ExecutionEnv` has a `cleanup()` that three separate grep-based surveys missed. Found
   by type-checking an implementation, which is what the third survey's own correction had
   prescribed.
2. pi's tools convert `Result` back into exceptions via `getOrThrow`, so the never-throw
   contract binds our adapter and not pi's internals.
3. The adapter rendered tool failures as `[object Object]`, and it took a real failure to
   notice — which happened by accident, because the open workspace was a different project
   than the one being asked about.

**The spike has not been deleted.** The ticket says to delete it, and that instruction
stands; it is left in place only until the decision to start the real slice is made, so
that the slice can be written against something running rather than against this document.
`rm -r src/spike` plus one ternary in `WorkbenchController.tsx` removes it. The Rust
`provider_stream` command is the exception — it is ticket 06's design rather than spike
scaffolding, and it stays.

Deferred, and tracked where they belong rather than here: the orphan probe against
Anthropic and Google ([ticket 14](14-switch-aftermath.md)), `keyring` storage and
per-provider auth dispatch ([ticket 06](06-credentials-and-http.md)).

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

### Settled by instrumentation — the credential path and the failure path

Second run, DeepSeek through **Rust**, driven over the WebView2 debugging port so the
numbers are measured rather than observed.

**Streaming across the IPC works, and it is genuinely incremental.** One request through
`provider_stream`:

| | |
|---|---|
| status | 200 |
| head arrived | 428 ms |
| chunks | **14** |
| spread first→last chunk | **722 ms** |
| bytes | 12,002 |
| `[DONE]` seen | yes |
| key present anywhere in JS | **no** |

Fourteen chunks over 722 ms is the whole point: a buffered response would have arrived as
one chunk at the end, and the transcript would have looked identical. **This was the
riskiest item on [ticket 06](06-credentials-and-http.md) and it holds.**

**The failure path holds too**, which the happy path could never have shown. `read` on a
missing file produced a `Result`, pi turned it into an error tool result carrying
`not found`, the model was told, and it recovered and explained itself in a following
turn. No rejected `invoke` reached pi's loop. **The never-throw invariant from
[ticket 01](01-execution-env-surface.md) survives a real failing tool call**, including the
part where pi's own `getOrThrow` converts back to an exception one layer up.

**The loop is multi-turn, not single-shot.** tool → error → model continues → answer, with
several successful reads in the same session.

**One defect found and fixed in the adapter**, worth recording because it is the failure
mode this kind of code has: `tool_end` rendered its reason with `String(result)`, and
`AgentToolResult` is an object, so the transcript said `[object Object]` and threw the
diagnostic away. The first real tool failure was therefore unreadable. Tool results carry
their message in `content[].text`; anything mapping them must go and get it.

**The Vite proxy is gone.** It existed to remove the credential as a variable while the
loop was unproven. The loop is proven and Rust now makes the call, so keeping both would
have been a second way to do the same thing.

### Settled by a second provider — Google, and two defects it exposed

Running the same spike against `gemini-3.5-flash` was meant to be a free stand-in for the
Anthropic run. It found more than the Anthropic run would have, because **a second provider
is what exposes the assumptions a first provider let you keep.**

**The turn works**: 7 progressive render steps, a `read` call through Google's
`functionCall` format, and an answer grounded in the file's real contents. So
`google-generative-ai` streaming through pi through Rust holds, and so does the
per-provider credential path — `x-goog-api-key`, bare rather than bearer.

**Two defects, both invisible to a single provider:**

1. **The `options.fetch` seam does not generalise.** The Google adapters reject an injected
   `fetch` and accept only `globalThis.fetch`. Interception moved to the global, scoped by
   host. Recorded on [ticket 06](06-credentials-and-http.md), which had named
   `ProviderStreams` as the seam — right for two shapes of three.
2. **The shim silently dropped non-string request bodies.** The OpenAI SDK passes a string;
   `@google/genai` does not. Google requests went out empty and returned `500 INTERNAL`,
   which reads as the provider's fault. A direct `curl` returning 200 is what proved
   otherwise.

**`error` fired for the first time**, by accident: Google's free tier allows five requests
per minute, and the 429 travelled Rust → channel → pi → `mapEvent` → transcript intact.
That is the kind a user meets on a dropped connection or a quota wall, and it was the last
unexercised kind that mattered.

**Incidental, and a constraint on any Gemini-based testing:** the free tier's 5 rpm is low
enough that an agent loop with a couple of tool calls can exhaust it inside one turn.

### Not settled — still needs work

1. **The orphaned `tool_use` probe** is done for DeepSeek and Google — both accept orphans
   without complaint, across two structurally different API shapes. **Anthropic is
   deferred** (no free tier) and is the strict case. Results and the two incidental
   findings from that run are on [ticket 14](14-switch-aftermath.md), which owns the
   question.
2. **`usage` and `compacted` have never fired.** Both are in the contract; the UI adapter
   drops them before they could be seen, so exercising them needs a consumer that does not.
   `thinking` is *inconclusive* rather than unfired — Gemini emits reasoning content and
   `mapEvent` maps `thinking_delta`, but the adapter renders it as ordinary prose, so the
   transcript cannot distinguish it. **`error` is now confirmed** (below).
3. **Key storage is still an environment variable.** `resolve_api_key()` in
   `src-tauri/src/provider.rs` reads `DEEPSEEK_API_KEY`. [Ticket 06](06-credentials-and-http.md)
   settled `keyring` for v1, and that function is the entire swap.
4. **The proxy is hardcoded to one provider.** `provider_stream` always attaches a DeepSeek
   bearer token; nothing dispatches on which provider is being called. Fine for a spike,
   wrong the moment a second provider exists.

Also worth carrying forward, though neither is this ticket's job: `ProviderEvent::Chunk`
serialises bytes as a JSON array of numbers, which is several times the payload size — it
did not matter at 12 kB and will matter later. And `spikeFetch` is exposed on `globalThis`
under `import.meta.env.DEV` purely so the debugging port can reach it.
