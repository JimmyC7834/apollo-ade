# 72 — A plugin loads and adds a command

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent

## What to build

You put a folder in the plugins folder, start the ADE, open the command centre, and **your
command is there and runs**.

That is the whole slice, and it is the tracer bullet: discovery, the plugin manifest, the
`api` check, the difference between a global and a local plugin, injection at boot, and the
first of the six messages — `claim`.

## Why

Every other plugin ticket hangs off this one. It is also the smallest thing that proves the
trust model chosen in
[ADR 0005](../../../adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md) actually
works: a plugin is code we did not write, running in our document, contributing something
our own components draw.

## What is there now

- **Nothing loads foreign code.** The only extension point today is the declarative tool
  manifest in `src/agent/userTools.ts`, which runs no code by design.
- `src/commands/commandRegistry.ts` holds the commands as a list the command centre reads.
  A claimed command is an entry in that list, not a new mechanism.
- Rust is the only filesystem authority and it stays root-confined — so **discovery and
  reading happen in Rust**, and the renderer receives parsed data.
- `ade.profiles.json` is read from the **session root**, which is the precedent for a local
  plugin's location.

## The shape of it

**Two locations, two trust rules.**

- **Global** — the app-data folder. Putting a folder there is the trust decision. It loads.
- **Local** — `.ade/plugins/` under the session root. Discovered, listed, and **inert until
  you enable it for that root**, remembered per root. Cloning a repository must never be
  the same act as running its author's code. This is the sharpest edge in the design; the
  ADR explains it, and the UI has to make the two states obvious.

**The plugin manifest.** `plugin.json` with `name`, `description`, an integer `api`, and
any subset of the entry points `script`, `panel`, `theme`. A malformed file, an unknown
`api`, or a missing entry point disables the plugin and writes **one line to Problems** —
nothing runs. The `api` mismatch message names both numbers.

**Injection.** At boot, before React mounts, Rust hands the renderer each enabled plugin's
script; the renderer makes a blob URL and `import()`s it. A plugin that throws during load
is disabled with its reason in Problems, and the ADE keeps starting.

**The API object.** The plugin receives one object with the six messages on it. This ticket
implements `claim` only; the other five exist as names that reject with "not yet". Two
rules from the ADR bind from the first line of this file, because breaking them later is
silent:

1. **Nothing but data crosses.** No component, no React, no controller state, no DOM node.
2. **Everything is asynchronous**, including calls that could answer instantly.

**`claim('command', spec)`** takes an id, a label and a handler, and the command centre
shows it like any other. It is drawn by *our* component, so it matches the ADE because it
is the ADE.

## Not in scope

`invoke`, hooks, tools, panels, themes, layout — tickets 73 to 76. No sandbox: the plugin
has the ADE's full authority and the API is a promise, not a fence. No registry, no
versions beyond the `api` integer, no install command — you copy a folder.

## Acceptance criteria

- [ ] A folder with a `plugin.json` and a script in the global plugins folder loads at
      start-up, and its claimed command appears in the command centre and runs.
- [ ] The same folder under a session root is **listed but does not run** until enabled for
      that root, and the enablement is remembered.
- [ ] A malformed `plugin.json`, an `api` mismatch, a missing entry point and a script that
      throws each disable that plugin with one line in Problems naming it — and the ADE
      still starts, with other plugins loading.
- [x] The `api` mismatch message names the plugin's number and ours.
- [x] The API object hands the plugin no component, no React and no DOM node, and every
      one of its six members returns a Promise — including the five that reject with
      "not yet".
- [x] Rust reads the folders and stays root-confined; the renderer never touches the
      filesystem.
- [x] `npm run check` and `cargo test` pass.
- [ ] Driven in the **native** window, with a real plugin folder on disk. The four boxes
      above are unticked for the same reason: they are built and reasoned about, and nobody
      has watched them. `docs/examples/hello-plugin/` is there to be copied in.
