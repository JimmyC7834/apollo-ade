# Context

Working rules for this repo. Read before starting work.

## Less is more

The governing philosophy, and it outranks the guide when the two pull apart.
**Every wanted and needed feature ships — and nothing else does.** This is not a
licence to cut scope: a missing feature the user asked for is a failure, not a
simplification.

What it rules out is everything around the feature. No abstraction with one
implementation. No configuration for a constant. No scaffolding built for a
future that has not arrived. No second way to do something that already works.
When two designs deliver the same behaviour, the smaller one is correct — and
"smaller" means fewer moving parts and fewer concepts to hold, not terser code.

Prefer deleting to adding. Prefer an existing dependency to a new one, a
platform feature to a dependency, and nothing at all to any of them. When a
shortcut is taken deliberately, mark it and name what would justify replacing
it, so the next reader knows it was a decision rather than an oversight.

The exceptions are fixed and small: input validation at trust boundaries, error
handling that prevents data loss, the security boundary, and accessibility. These
are never the thing that gets trimmed.

## How to write to the dev

When the dev asks for a pitch, a re-pitch, or an explanation of a choice, write in
**ASD-STE100 simplified technical English**:

- Write short sentences. Keep one idea in each sentence.
- Use the active voice. Name who does the action.
- Use the present tense.
- Use one word for one meaning. Do not change words to make the text more
  interesting.
- Do not use more than three nouns together.
- Do not use metaphors or rhetorical questions.

Use the words of this repo for the things of this repo — slice, adapter, domain
interface, boundary, root-confined, profile, gate, tool, harness, event. Do not
invent a second name for something that has a name.

This rule is about the pitch, not about the code comments. Comments keep the
voice they already have.

## Review agents

Run every code-review sub-agent at **low effort**. Reviews are a second opinion
on a diff that is already typechecked, checked and validated live; more effort
buys length, not more findings.

## The guide is the spec

Two documents are authoritative, and they cover different things. Say which one
you mean; never write "the guide" unqualified.

**The Shell Guide** — `docs/UIUX-UPDATE.md`. Authoritative for what the
workbench **is**: its regional topology, the transcript, the composer, profiles
as a surface, which controls exist and what they do, and the accessibility
contracts. Where it and the guide below disagree, **the Shell Guide wins.** It
is a design that was drawn elsewhere and is being migrated to here, so parts of
it describe a mock with no engine — its own "Interaction caveats" say as much.
Those parts are shape, not behaviour, and a ticket that implements one literally
is a ticket that has misread it.

**It is no longer authoritative for what the workbench looks like** — see
[ADR 0003](docs/adr/0003-the-shell-guide-keeps-topology-and-loses-look.md).
Iconography, fills, elevation, radii, typography and tone are settled by the
TUI restyle instead, and its reference is `docs/tui-restyle-probe.html` and
`docs/tui-restyle-primitives.html`. The palette is **not** part of that split:
`tokens.css` keeps every value the Guide gave it, and only stops painting them
as backgrounds.

`docs/tui-restyle-mockup.html` is a **review artifact, not a specification.** It
carries the Shell Guide's own hazard for the same reason — it was drawn to be
looked at — and it deliberately shows changes nobody asked for. Implementing it
literally is the same misreading.

**The guide** — `docs/# Building a VS Code-Like Agent IDE with Vertical
Slices.md`. Authoritative for everything else: adapter seams, security policy,
accessibility contracts, slice discipline, the UI-extraction rule. Its shell is
superseded; nothing else is.

Follow both. If you deviate from either, say so explicitly and record it in the
dev log rather than quietly diverging.

## Dev log rule

**Every completed slice gets a summary appended to `docs/DEVLOG.md`.** Append
only — never rewrite or reorder existing entries. One entry per slice, added
when the slice is finished, using the template already in that file:

- User outcome (one sentence, not a file list)
- Added
- UI extracted / reused
- Adapters and dependencies
- Security boundary
- Accessibility behavior
- Validation performed (and what was *not* validated)
- Caveats and deviations from the guide

The log is how the next agent learns what actually happened, including what
was skipped. Record honest gaps — an unrun test is a caveat, not an omission.

## Open issues

`docs/OPEN-ISSUES.md` is the living counterpart to the dev log: current open
defects, what has never been verified, and how to inspect the **native** window
over the WebView2 debugging port. **Read it before picking up a slice**, and
edit it — close items by deleting them and recording the fix in the dev log.

It exists because the dev log is append-only, so by the time it is long enough
to be useful it is too long to answer "what is broken right now?".

## Working rules

- Feature code consumes domain interfaces; it never calls Tauri directly.
- Every native capability gets a deterministic browser implementation so the
  UI runs under `npm run dev` with no native process.
- Extract a UI primitive only after two real consumers show the same behavior.
- Accessibility is part of the slice, not follow-up work.
- Rust is the only filesystem/process authority; it stays root-confined.
- Before planning any slice that touches the agent, grep
  `node_modules/@earendil-works/pi-agent-core/dist/index.d.ts` for what you are about
  to build. Three consecutive plans proposed building something core already exports.

## Validation

```bash
npm run build
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

Dev server runs on port 5190 (5180 belongs to the sibling `agent-window-tauri`).

The browser pane is **not** equivalent to the native window — it serves no
animation frames, so Monaco never lays out and timing behaves differently.
Anything about focus, layout inside Monaco, or animation has to be checked
natively; `docs/OPEN-ISSUES.md` explains how.

## Words

One word for one meaning. These collided, and the collisions are settled.

**Plugin** — something a *user* adds to the ADE. The dev's word, and it wins.
Two kinds exist: the declarative tool manifest, and the injected plugin of
[ADR 0005](docs/adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md).
"Extension" is pi's word for the same idea and is not ours; use it only when
describing pi.

**Tauri plugin** — a Rust crate we depend on (`tauri-plugin-*`). Always written
with "Tauri" in front. Never shortened to "plugin".

**Plugin manifest** — the `plugin.json` that declares a plugin. Not to be
confused with a **tool manifest**, which declares a user tool inside a profile.

**Global plugin** and **local plugin** — where the folder is, which is also the
trust decision. A global plugin sits in the app-data plugins folder and runs
because putting it there was the decision. A local plugin sits in `.ade/plugins/`
under a project root, arrived with somebody's repository, and is listed and
**inert** until it is enabled for that root. Never say "installed": nothing
installs anything, you copy a folder.

**Claim** — a chrome contribution a plugin declares and **we** draw: a command,
a strip item, a dock tab, a notification, a menu entry. A claim is data. A
plugin never renders a claim itself.

**Plugin tool** — a tool a plugin declares, which the model may call once a
profile names it. Two acts, never one: enabling the plugin runs its code, and a
profile naming the tool grants the model access. Its name is refused rather than
namespaced on a collision, unlike a claimed command's id — a tool name is prose
the model reads.

**Layout claim** — a claim that changes something we already draw rather than
adding to it: hide, rename, reorder, by **public id**. It never creates a
surface; a plugin that wants one uses a plugin panel.

**Public id** — an id a plugin may name, listed in `src/publicNames.ts`. Three
things at once: we chose it, it is the same on every run and in every workspace,
and a plugin can act on it. Renaming one is an `api` bump. An id outside the set
is unsupported, and a layout claim naming one is refused.

**Plugin panel** — a surface a plugin draws itself, in a child webview, in a
dock slot. The other half of what a claim is not. Same machinery as a browser
tab ([ADR 0004](docs/adr/0004-a-browser-tab-is-a-child-webview.md)).

**Relay** — an opaque payload passed between a plugin's script half and its
plugin panel. The ADE carries it and never parses it.

**Supported** and **unsupported** — a plugin call is supported when it uses one
of the six declared messages, and we promise not to break it. Anything else a
plugin reaches is unsupported: it works, and it carries no promise.
