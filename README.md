# tauri-ade-prototype

An **ADE** — agent development environment. A code editor whose first-class inhabitant
is an agent, not a plugin bolted onto one.

It is a Tauri app: a Rust process that owns the filesystem, the processes and the
network, and a WebView that draws. **It uses the WebView the operating system already
has.** No bundled browser, no bundled Node.

**6.4 MB to download. ~17 MB installed.**

## Size

Measured on Windows x64, release build, at `9d66f8a`.

| | |
| --- | --- |
| Installer (NSIS `-setup.exe`) | **6.4 MB** |
| Installer (MSI) | 8.6 MB |
| Installed — one `.exe`, frontend embedded | **16.9 MB** |
| Runtime dependency | WebView2, already on Windows 10/11 |

The frontend inside that binary is 14 MB of assets, and most of it never loads:

| Asset | Raw | When it loads |
| --- | --- | --- |
| `index.js` — the whole workbench and the agent | 4.8 MB (1.35 MB gz) | at start |
| `index.css` | 197 KB (33 KB gz) | at start |
| `ts.worker.js` — Monaco's TypeScript service | 5.8 MB | first `.ts` file opened |
| `css` / `json` / `html` workers | 1.6 MB | first file of that kind |
| ~80 syntax files, one per language | 1–16 KB each | first file of that language |

So a cold window pays about **5 MB**, and pays for TypeScript only if you open
TypeScript. Nothing is fetched at runtime; the assets are read out of the binary.

### Why it stays this size

- **The OS WebView is the renderer.** A shell that ships its own Chromium starts near
  100 MB before any of your code exists. This one starts at zero.
- **17 production dependencies.** React, Monaco, xterm, four Radix primitives, Tailwind,
  codicons, `@tauri-apps/api`, and pi's agent core. Everything else is the platform.
- **No test framework, no bundler config, no lint config.** Checks are plain `.ts` files
  run under bare node — 6.5k lines of them — and Rust tests live beside the code they
  test.
- **The governing rule is in [`context.md`](context.md): every wanted feature ships, and
  nothing around it does.** No abstraction with one implementation, no configuration for
  a constant, no scaffolding for a future that has not arrived.

26k lines of TypeScript, 6.2k lines of Rust, 6.5k lines of checks.

## What it does today

- **Editor** — Monaco, real files, diff view, a modal editor workbench.
- **Workspace** — explorer, search and replace, problems, git source control with
  staging and diffs, an integrated terminal on a real PTY.
- **Language servers** — LSP over stdio: diagnostics, hover, definitions, references,
  rename across a workspace.
- **An agent, in-process** — `@earendil-works/pi-agent-core` running inside the WebView,
  with a Tauri execution environment behind it so **Rust stays the only filesystem and
  process authority**. API keys are set as environment variables and read in Rust; they
  never enter JavaScript.
- **Profiles** — a named preset of model, tools, system prompt and policy that a session
  runs under and can switch to mid-run.
- **A permission gate** below the tool layer, on shell commands and destructive actions.
- **Your own tools** — a manifest declares an argv array, never a shell string.
- **Sessions** — several at once in one window, in different folders, running in the
  background, reopened at launch.
- **Browser tabs** — a real child webview in a dock tab, which the agent can drive.
- **Plugins** — six asynchronous messages: `invoke`, `on`, `claim`, `panel`, `relay`,
  `theme`. A plugin adds a command or a tool, draws its own page, and changes the chrome.
  See [ADR 0005](docs/adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md) and
  [the hello plugin](docs/examples/hello-plugin/README.md).

## Roadmap

Everything charted is built. What follows is grouped the way this repo groups it.

### Next — verification, not features

The plugin system (tickets 71–76) has never been driven in the native window. Nobody has
watched a plugin tool reach a model, `plugin://` serve a page, a relay make the round
trip, or a theme go on and come back off. `docs/examples/hello-plugin/` exercises all six
messages and exists to be driven. [`docs/OPEN-ISSUES.md`](docs/OPEN-ISSUES.md) is the
live list of what else is unseen.

### Deferred, not now — decided, waiting

- **The OS keychain** for credentials, in place of environment variables.
- **Worker-hosted user scripts** — a capability protocol over `postMessage`, so a user
  script is isolated rather than trusted. The largest single piece on the map.
- **Approval memory** — allow-once, allow-for-session, persistent rules. Moot while the
  gate runs on `auto`; live the day it does not.
- **Rich agent output** — previews and attachments beyond text and tool results.
- **Cancellation below the event boundary** — mid-stream, mid-tool, mid-process.

### Not decided — open questions

- **Browser tabs on arbitrary hosts.** Today: localhost and `file:` only. What is missing
  is not the mechanism but the rules a public web makes necessary — what an untrusted
  page may do to the agent's context, and whether a host list is a per-profile trust
  surface.
- **Extension beyond tools and chrome** — custom renderers, and the rest of what pi's
  extension API does.

## Build and check

```bash
npm run build
```

```bash
npm run check
```

`check` is types, the node check files, and the Rust tests. The dev server is on port
5190; the browser pane serves no animation frames, so anything about focus, Monaco layout
or animation has to be looked at in the native window.

## Documents

| | |
| --- | --- |
| [`context.md`](context.md) | Working rules and the glossary. Read first. |
| [`docs/DEVLOG.md`](docs/DEVLOG.md) | Append-only history, one entry per slice. |
| [`docs/OPEN-ISSUES.md`](docs/OPEN-ISSUES.md) | What is broken and what is unverified. |
| [`docs/adr/`](docs/adr/) | Decisions that were hard to reverse. |
| [`docs/wayfinder/pi-harness/map.md`](docs/wayfinder/pi-harness/map.md) | The agent work: every decision and every ticket. |
