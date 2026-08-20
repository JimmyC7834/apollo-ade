# 0005 — A plugin is injected, and the API is a promise rather than a fence

**Status:** accepted, not yet implemented.
**Date:** 2026-08-19.
**Context:** settled in a grill; slices ticketed as 71–76.
**Relates to:** [0004](0004-a-browser-tab-is-a-child-webview.md), whose child webview is the
plugin panel; `src/agent/userTools.ts`, whose opt-in rule plugin tools inherit.

## Context

The dev asked for a **plugin** system — the word is settled in `CONTEXT.md`, and it means
a thing a user adds to the ADE. The stated goal was "as diverse as possible": plugins
should be able to add features *and* change the look and behaviour of the workbench, and
installing one should be as casual as copying a folder in. The audience is "everyone", but
with no registry, no publishing and no version resolution.

The grill was started once before and stopped one round in, on the question **name three
plugins you actually want**. That question was deferred again here, deliberately, which
removes the evidence gate `CONTEXT.md` normally requires — no abstraction with one
implementation. It is replaced by a different gate, recorded below: the surface grows one
message at a time, and only when something real needs one.

**What already exists.** The only extension point today is the declarative tool manifest —
a schema plus an argv array, running no foreign code by design. Artifacts, renderers and
glyphs are closed unions. `pi-agent-core` ships a 22-event hook system in the browser-safe
core (`harness/types.d.ts:550`), eight events returning values that change behaviour,
including `tool_call -> { block?, reason? }`, which is what our permission gate is built
on. What pi keeps in its Node/TUI layer is the extension *host*, not the hook substrate.

## The decision

**A plugin is injected into the ADE's own document, and it has the ADE's full authority.
On top of that we publish a small asynchronous API, which is a compatibility promise and
not a permission boundary.**

Said in one line: **full injection with a supported subset.**

- A plugin runs in our renderer, at boot, before React mounts. Nothing sandboxes it.
- Six messages are declared, asynchronous, and carry data only. Use them and a plugin
  survives our refactors. Go around them — `invoke`, our DOM, whatever it finds — and the
  plugin works today with no promise about tomorrow.
- The API cannot fence anything, and it is not pretending to. `invoke` is on the global
  whether we expose it or not.

### The six messages

Chosen at a granularity that keeps the list short. A new capability becomes a `kind`
inside `claim` or a command reachable through `invoke`, not a seventh message.

| Message | What it carries |
| --- | --- |
| `invoke(command, args)` | Every Rust command the ADE has. Root-confined, like every other caller. |
| `on(event, handler)` | All 22 harness hooks, through the chaining runner below. |
| `claim(kind, spec)` | Every chrome contribution — command, strip item, dock tab, notification, menu entry — drawn by **our** components. |
| `panel(url)` | A child webview in a dock slot. Unlimited pixels, the plugin's own markup. |
| `relay(payload)` | An opaque payload between a plugin's script half and its panel half. We never parse it. |
| `theme(tokens)` | Token values, the one rung of look a plugin may change without drawing. |

### Hooks never lift a block

Core's `emitHook` hands every handler the same event and **keeps only the last result**. A
plugin returning `{}` from `tool_call` would silently erase the gate's `{ block: true }`.

**So plugin hooks run through a chaining runner with deny precedence, and a plugin may add
a block and may never lift one.** The gate runs last and unconditionally. This is the same
shape `systemPrompt.ts` already uses for `before_agent_start`.

This paragraph exists because the obvious simplification — hand plugin handlers straight
to `harness.on` — deletes the permission gate without any test failing.

### What a plugin is, on disk

A folder with `plugin.json` naming `name`, `description`, an integer `api`, and any subset
of the entry points `script`, `panel` and `theme`. A plugin may be logic only, logic and
pixels, or a theme with no code at all.

- **Global** — the app-data folder. Placing it there is the trust decision, and it loads.
- **Local** — `.ade/plugins/` under the session root. Discovered, listed, and **inert
  until enabled for that root.** Cloning a repository must never be the same act as
  running its author's code.

`api` is one integer we bump on a breaking change, and a mismatch refuses the plugin with a
sentence naming both numbers. That is the whole compatibility mechanism: no semver, no
ranges, no lockfile, no registry.

### A plugin's tools are off until a profile names them

Ticket 13 settled that a manifest on disk is not a trust decision, and plugin tools inherit
it. Enabling a plugin says "run this code". A profile says "let the model call this". One
rule for where a tool comes from instead of two.

### Public identifiers are part of the promise

The fragile surface is not code reach — it is **names**. A plugin that hides the strip item
called `terminal`, or overrides `--muted-foreground`, depends on that identifier existing
even though it imported nothing.

So the ids a plugin may name live in **one file**, and a rename there is an `api` bump.
Ids that are not in that file are not promised.

## What was considered

**A sandbox — a hidden `plugin://` child webview per plugin** (the shape this grill spent
the longest on, and which turns out to be VS Code's architecture: its extension host maps
to the webview, `vscode` to our vocabulary, `engines.vscode` to `api`, `contributes` to
claims, its webview to our panel, Workspace Trust to our local-enable rule). Rejected for
now on cost, not on merit: a renderer process per plugin, a message pump over `ade-ipc:`
and `eval` with chunking, and a runtime shim — several times the work of injection, spent
defending against an attacker the dev does not have. **It stays available**, and the two
rules below are what keep it available.

**A Web Worker.** Recommended during the grill and then withdrawn. A Worker we create runs
in *our* origin, has `fetch`, and Tauri capabilities are granted per webview — so a plugin
Worker inherits the ADE's commands. Removing `fetch`, `XMLHttpRequest`, `WebSocket` and
`Worker` from its scope is a denylist, and `CONTEXT.md` names the security boundary as one
of the four things we never trim. A denylist is the wrong instrument for it.

**Injection with live references** — handing plugins our React and our components. Rejected
because it makes our internals the API: every refactor becomes a compatibility question,
and the `api` integer stops meaning anything since there is no declared surface to version.

## Consequences

**Two rules keep the sandbox reachable.** Break either and the door closes quietly, so they
are rules and not preferences:

1. **Nothing but data crosses.** No component, no React, no controller state, no DOM node
   is ever handed to a plugin by the supported API.
2. **Everything is asynchronous**, including calls that could answer instantly. A
   synchronous getter is the one thing a transport cannot preserve.

**The move to a sandbox has a trigger, not a schedule:** when a plugin hangs the window, or
when a plugin the dev did not write is worth enabling.

**A hanging plugin is a caveat, not a solved problem.** A plugin's `tool_call` handler runs
on our main thread. An asynchronous call that misses its deadline disables the plugin for
the session and writes one line to Problems, with the plugin's name on it. A synchronous
loop still freezes the window, and no timer can interrupt it. This is the one thing the
sandbox would fix for free, and it is recorded here rather than discovered later.

**Plugins in the unsupported tier cannot migrate.** If most plugins end up reaching around
the six messages, the trigger above becomes unusable in practice. That is a fair trade
while the dev writes the plugins, and it is the thing to watch.

**A plugin author has no npm.** A plugin ships a JavaScript file, so anything with
dependencies is bundled first. Not solved, not urgent.

**Hook payloads are pi's, not ours.** `api` covers our messages and our identifiers. A pi
upgrade can change an event's shape underneath a plugin, which argues for our hook events
being ours-shaped rather than pi's passed through raw.

**Compared with pi.** Deeper in surface — a TUI has almost nothing to extend, so pi's whole
UI surface for an extension is a terminal prompt, while ours is claims, a panel, tokens and
layout. Narrower in authority — a pi extension gets unconfined Node; ours gets `invoke`,
and every command behind it is root-confined by a rule this repo made long before plugins.
