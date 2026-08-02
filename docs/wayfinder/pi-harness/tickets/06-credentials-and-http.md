---
label: wayfinder:grilling
title: Who holds the API key, and who makes the HTTPS call
parent: ../map.md
blocked-by: []
assignee:
status: closed
---

# Who holds the API key, and who makes the HTTPS call

## Question

New with this destination, and larger than it sounds. Moving the agent into the WebView
moves the *model client* into the WebView too — unless we decide otherwise, and this is
where that gets decided.

pi's design makes it decidable: the entire LLM surface is one injected function,
`StreamFn`, contracted never to throw and to encode failures in the stream. `packages/ai`
supplies implementations (`streamSimple`, `complete`, `getModel`, `getProviders` are all
in the browser-safe export), but nothing forces us to use them as-is.

Three shapes, and they are genuinely different architectures:

- **WebView fetches directly.** Simplest, and pi's providers work untouched. The key
  must then reach the renderer, where any bug or injected content in the page can read
  it. Nothing else in this app has ever put a secret there.
- **Rust proxies the HTTP.** The key never leaves Rust; the WebView calls a Tauri
  command that streams bytes back. Preserves the pattern the rest of the app follows,
  and Rust already holds every other authority. Costs a streaming IPC path and means
  pi's provider implementations are bypassed or wrapped.
- **Rust injects credentials into a request the WebView composed.** Middle ground,
  and usually the worst of both — the renderer still controls the destination URL.

Settle:

- **Which shape**, and say the threat model out loud rather than implying it. The
  WebView loads only local content today; if that stays true the first option is less
  alarming than it sounds, and if it might not, it is disqualifying.
- **Where the key is stored at rest.** Tauri has no secret store of its own worth
  relying on. OS keychain, a file with restrictive permissions, or environment — decide,
  and decide what the first-run experience is when there is no key.
- **Whether the browser-mode build can talk to a model at all.** `context.md` requires
  `npm run dev` to work with no native process. If Rust holds the key, dev mode has no
  key. That is either fine (dev mode uses the scripted provider — see
  [What the agent does under `npm run dev`](10-browser-mode-env.md)) or it is not, but
  it should not be discovered later.
- **Which provider v1 speaks.** Now a much smaller question than on the paused map,
  where porting a provider layer was the risk. Here they arrive as a dependency; the
  decision is only which one is wired and defaulted first.

---

## Resolution

**Rust makes the HTTPS call via an injected `fetch`. The credential is an API key
resolved in Rust behind a resolver seam, so its storage is swappable without touching
TypeScript.**

### Facts established, from the published `pi-ai` 0.83.0

- **A WebView can call Anthropic directly.** `api/anthropic-messages.js:659,663` already
  passes `dangerouslyAllowBrowser: true` and the
  `anthropic-dangerous-direct-browser-access: "true"` header. CORS is solved upstream, so
  the renderer route was technically available — it was rejected on trust grounds, not
  capability.
- **`fetch` is a public, first-class injection point**: `StreamOptions.fetch?:
  FetchFunction` where `FetchFunction = typeof globalThis.fetch`
  (`pi-ai/dist/types.d.ts:41,57`). The Anthropic adapter threads it into the client
  (`createClient(model, apiKey, …, fetch, …)`), so it is honoured on the path we care
  about.
- **`StreamOptions.apiKey?: string`** is equally public — a per-request key is supported
  as an alternative to environment resolution.
- **pi supports Claude Code OAuth**: it detects `sk-ant-oat` tokens and sends the
  `oauth-2025-04-20` and `claude-code-20250219` betas.

### Decisions

1. **Inject a Rust-backed `fetch`; the key never enters JavaScript.** The deciding
   factor is one that post-dates this ticket's charting: the dev has since made
   [user-authored tools](13-user-authored-tools.md) a requirement, which puts code we did
   not write in the same renderer as the secret. A key in renderer memory is defensible
   while everything in the renderer is ours; it stops being defensible the moment that
   is untrue, and building the cheap version first would leave a migration nobody is
   scheduled to do.
2. **Pin `transport: "sse"` for any model going through the injected fetch.** pi
   documents that a custom `fetch` "does not affect WebSocket transports", so a websocket
   transport would silently bypass Rust and take the key with it. This is a quiet
   failure mode and must be asserted, not assumed — a check that the resolved transport
   is `sse` belongs next to the injection.
3. **Evaluate Tauri's official HTTP plugin before hand-rolling the shim.** The hard part
   is returning a `Response` whose body is a live `ReadableStream` fed from Rust; the
   plugin exists for approximately this purpose. *Unverified* — it is not currently a
   dependency (`src-tauri/Cargo.toml` has only `tauri-plugin-dialog`), and whether its
   streaming behaviour suits an SSE model response needs checking before it is assumed.
   Falling back to a `Channel`-fed `ReadableStream` is the known-good alternative, and
   `Channel` is already the decided mechanism for [`exec`](02-exec-not-terminal.md).
4. **API key, not OAuth, as the v1 credential.** It is the only universal option: every
   provider was bundled by
   [What pi costs in the bundle](08-bundle-cost.md), and OAuth is Anthropic-only. OAuth
   becomes an *additional resolver* later — worth wanting, since it authenticates a
   Claude subscription rather than a metered key — not a replacement.
5. **Storage sits behind a Rust credential-resolver seam**, shaped roughly as
   `resolve(provider) -> Option<Secret>`. Because decision 1 keeps the secret entirely
   inside Rust, **the backing store is an implementation detail with no TypeScript
   consequences.** So v1 may back it with an environment variable and add an OS keychain
   (Windows Credential Manager) later with no migration above the seam. This is the
   answer to "less effort *and* extensible": the effort is staged, the interface is not.
6. **Failure has to be a real path, not a panic.** No key configured is the ordinary
   first-run state. It surfaces as the `error` kind from
   [the event contract](05-event-contract.md) — pi already has an `auth`
   `AgentHarnessErrorCode` — and the ADE needs somewhere to put a key. That UI is out of
   this ticket's scope but must exist.

### Consequence for browser mode

`context.md` requires `npm run dev` to work with no native process. Rust holds the key,
so **dev mode has no key and cannot reach a model** — which is fine, and is now an
explicit input to [What the agent does under `npm run dev`](10-browser-mode-env.md)
rather than a surprise. It strengthens that ticket's in-memory-`ExecutionEnv`-plus-fake-
`streamFn` option: with no credential available, a fake `streamFn` is not a compromise,
it is the only thing that can run.

### Correction — the injection point is a custom provider, not `StreamOptions.fetch`

Decision 1 above named `StreamOptions.fetch` as the seam. **That does not work through
`AgentHarness`**, and the error was asserting the seam without checking it was
forwarded:

- `AgentHarnessStreamOptions` carries `transport`, `timeoutMs`, `maxRetries`,
  `maxRetryDelayMs`, `headers`, `metadata`, `cacheRetention` — **no `fetch`, no
  `apiKey`**.
- `createStreamFn` (`agent-harness.js:319-341`) calls `this.models.streamSimple(...)`
  with an explicit allowlist of options. `fetch` is not among them, so a custom fetch
  cannot reach the provider by this route.

**The real seam is `models`.** `AgentHarnessOptions.models` is a `Models` collection, and
`createProvider({ …, api: ProviderStreams })` lets us supply the API implementation
outright. `ProviderStreams` is two methods (`pi-ai/dist/types.d.ts:161`):

```ts
interface ProviderStreams {
  stream(model, context, options?): AssistantMessageEventStream;
  streamSimple(model, context, options?): AssistantMessageEventStream;
}
```

A provider whose `ProviderStreams` calls Rust achieves everything decision 1 wanted, and
more cleanly: Rust performs auth *and* the HTTPS request, so the key never enters JS by
any path — rather than being kept out of one particular call. pi documents this route at
length (`pi/docs/custom-provider.md`, 27 KB) with a worked
`examples/extensions/custom-provider-anthropic`.

**Consequences for the decisions above:**

- Decisions 1, 4, 5 and 6 stand unchanged in substance.
- **Decision 2 (pin `transport: "sse"`) is retired.** It existed because a custom
  *fetch* does not cover websocket transports. A custom *provider* owns the transport
  outright, so there is nothing to bypass.
- **Decision 3 (evaluate Tauri's HTTP plugin) weakens but survives.** We no longer need a
  `fetch`-shaped shim, so the plugin is optional rather than load-bearing. Rust still has
  to stream an SSE response back into an `AssistantMessageEventStream`, and a `Channel`
  remains the known-good mechanism.
- **`CreateModelsOptions.credentials?: CredentialStore` is a lighter alternative** worth
  weighing: it injects credential *resolution* while leaving pi to make the request. It
  is much less work, but the key does then enter JS — so it is the right answer only if
  the trust argument that drove decision 1 is abandoned. Recorded so the cheaper option
  is a choice rather than an oversight.

---

## Confirmed by the spike — the design works, and the seam is smaller than expected

Built and measured on 2 Aug 2026; details in
[Thinnest end-to-end turn](12-walking-skeleton.md).

**The integration point is not `ProviderStreams.stream` itself — it is `options.fetch`.**
pi's `StreamOptions` accepts a custom `fetch`, and `openai-completions` passes it straight
to the official SDK. `AgentHarnessStreamOptions` does *not* forward one, so the harness
cannot inject it; wrapping `ProviderStreams` to add it can. That wrapper is six lines, pi
is unmodified, and every provider request goes through Rust.

**Streaming across the IPC holds.** 14 chunks over 722 ms for a 12 kB response, head
delivered at 428 ms — incremental, not buffered. This was the ticket's riskiest claim.

Three things worth keeping:

- **Never return `Err` from the streaming command.** A rejected `invoke` surfaces inside
  pi's stream plumbing as a thrown promise with no useful origin. Transport failures go
  back as an `error` *event* on the channel instead.
- **The renderer must still present a key to pi.** `getClientApiKey` throws outright
  unless it sees an api key or an authorization header, so the provider resolves a
  placeholder. Rust discards any `Authorization` header it is handed and attaches the real
  one, so the placeholder never travels.
- **CORS stops existing**, which was not the motivation but is the larger practical win —
  a request issued from Rust has no browser origin, and pi's `dangerouslyAllowBrowser`
  escape hatch becomes irrelevant.

Still open: the key is an environment variable, not `keyring`, and the command hardcodes
one provider's auth.

## Amendment — where the key is stored

Decision 1 settled that Rust makes the call; it left *storage* behind a "Rust resolver
seam" without picking an implementation. Picked now, because
[the walking skeleton](12-walking-skeleton.md) needs one:

**Environment variable for the spike, OS keychain (`keyring` crate) for v1.**

- The env var is ~3 lines and no UI, which keeps the spike aimed at the risky part — SSE
  bytes crossing the IPC — rather than at settings screens. Its limits are real and
  accepted for a throwaway: plaintext in a shell profile, no in-app way to set it.
- `keyring` is ~20 lines and maps to Windows Credential Manager, macOS Keychain and
  libsecret, so it is cross-platform without per-OS code. Swapping the env var for it is a
  one-function change behind the resolver seam, which is what the seam was for.

**Rejected**: `tauri-plugin-stronghold` (a heavy dependency for a single secret, and it
still needs a password) and a hand-rolled encrypted file (rolling our own crypto to
reimplement the keychain badly). The OS already solves this.

## Amendment — the OpenAI-compatible path is not the whole test

`Model.baseUrl` is a plain field and `compat` is auto-detected from it, so any
OpenAI-compatible endpoint is a two-string change: a local Ollama or LM Studio server
needs no key at all, and DeepSeek adds one without changing anything else. That makes
local → DeepSeek an unusually clean experiment — **the key is the only variable that
differs**, which is exactly what this ticket needs falsified.

It proves the `openai-completions` path only. Anthropic's `anthropic-messages` API has
different streaming framing and its own `cache_control` handling, so **one real Anthropic
call is still required** before this ticket counts as tested against the providers we
ship. Not part of the spike; not to be forgotten either.
