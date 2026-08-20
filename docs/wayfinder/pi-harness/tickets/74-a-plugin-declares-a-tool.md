# 74 — A plugin declares a tool, and a profile turns it on

**Blocked by:** [72](72-a-plugin-loads-and-adds-a-command.md).
**Status:** ready-for-agent

## What to build

A plugin declares a tool. It appears in the profile editor, **off**. A profile names it,
and from then on the model can call it — and the plugin's own code runs when it does.

## Why

This is the difference between a plugin that decorates the ADE and a plugin that changes
what the agent can do. It is also where two existing rules meet, and the ticket exists to
make sure they meet correctly rather than by accident.

## What is there now

- **Ticket 13's rule**: user tools are **opt-in**, and a manifest on disk is not a trust
  decision. Manifests live in the profile files, so the tool and the profile that names it
  are authored together.
- `src/agent/userTools.ts` holds `RESERVED` — now six names, after `browser` widened it —
  and a manifest may not shadow a built-in.
- The tool set is mutable at runtime: `ToolsUpdateEvent`, `activeToolNames`,
  `setResources()`. Adding and removing tools mid-session is supported by construction.
- `profile.tools` is `Readonly<Record<string, boolean>>` — trust is granted per tool name,
  by profile membership, and the gate sits **below** the tool layer.

## The shape of it

**Two decisions, one act each.** Enabling a plugin says "run this code". A profile naming
its tool says "let the model call this". Keeping them separate is what
[ADR 0005](../../../adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md) settled, and
it means one rule for where a tool comes from rather than two — a plugin's hooks and panel
can work while none of its tools are exposed to any model.

**A plugin tool is a normal tool from the model's side.** A schema plus an execute. The
difference is only where the execute runs: for a declarative manifest the argv goes to
Rust; for a plugin the call goes to the plugin's own function, in our renderer, under the
deadline from [73](73-a-plugin-acts-and-listens.md).

**Naming.** A plugin tool may not shadow a built-in, and two plugins may not both claim one
name. Decide how a collision reads to the user — the honest options are refusing the second
plugin's tool with a line in Problems, or namespacing every plugin tool by its plugin. Pick
one, write down why; do not do both.

**The profile editor has to show where a tool came from**, because a user granting trust to
a name deserves to see that the name is a plugin's and which plugin's.

## Not in scope

Panels, relay, themes, layout — tickets 75 and 76. No change to the gate: a plugin tool is
gated exactly like any other tool, which is to say the gate sits below it and the deny list
still binds anything it runs.

## Acceptance criteria

- [ ] A plugin declares a tool; it is listed in the profile editor and is **off**.
- [ ] The model cannot call it until a profile names it, and can once one does.
- [ ] Calling it runs the plugin's own function, under the deadline, and its result reaches
      the transcript like any other tool result.
- [ ] The profile editor shows which plugin a tool came from.
- [x] A plugin tool that shadows a built-in, and two plugins claiming one name, are both
      handled by the chosen rule, with the reason written down.
- [ ] Removing or disabling a plugin removes its tools from a live session.
- [x] `npm run check` and `cargo test` pass.
- [ ] Driven in the **native** window, against a real model calling the tool.

**Naming, as chosen:** a colliding tool name is **refused** with a line in Problems, never
namespaced. A tool name is prose the model reads, in the same list as `read` and `bash`;
`hello_echo` is worse prompt material than `echo`, and a namespace we applied silently is a
name its author never wrote. It is also the rule `userTools.ts` already applies to a manifest
shadowing a built-in — one rule for tool names rather than two. A claimed *command* is still
namespaced, because a command id is ours and nobody reads it.

Everything unticked needs a running window; the tool call also needs a real model. The two
about listing and removal are true of the store and are checked there — nobody has watched
them happen in a profile editor or in a live session. `docs/examples/hello-plugin/` declares
`which_branch` so that can be done.
