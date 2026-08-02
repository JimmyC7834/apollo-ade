---
label: wayfinder:grilling
title: What is a profile, concretely?
parent: ../map.md
blocked-by: []
assignee: jc4649
status: closed
---

# What is a profile, concretely?

## Question

The novel feature. Everything on this map that mentions profiles hangs off this answer,
including rtk.

**Two shipped implementations to read first**, and they disagree about scope:

- **Zed's profile** (`docs/RESEARCH-zed-harness.md` §3) — 309 lines including tests,
  five fields: `name`, `tools: IndexMap<Arc<str>, bool>`, `enable_all_context_servers`,
  `context_servers`, `default_model`. Tool exposure and a default model, **no system
  prompt, no skills, no permissions**. Applying it is one filter predicate
  (`thread.rs:4064`). The selector UI is ~3× the model layer.
- **pi's `preset.ts`** (`pi/packages/coding-agent/examples/extensions/preset.ts`, 392
  lines) — `provider`, `model`, `thinkingLevel`, `tools: string[]`, `instructions`.
  Loaded from `~/.pi/agent/presets.json` and `<cwd>/.pi/presets.json`, project taking
  precedence; activated by CLI flag, `/preset`, or a cycle hotkey. It has the system
  prompt field Zed left out, and its shipped example presets are `plan` / `implement`
  — the same idea as Claude Code's modes.

Neither is importable here (pi's is in the TUI-bound extension layer), so both are
evidence about *scope*, not code.

Settle:

- **The fields.** Start from the intersection the two agree on — tools and a model —
  and justify each addition. The paused map recorded that three of the four things we
  want are things Zed deliberately omitted, and that the gap is where the cost lives.
  Note that `instructions` is where pi and Zed diverge and pi is the more useful.
- **Where the tool subset is applied.** Zed filters at request-assembly. pi's preset
  swaps agent state. What `pi-agent-core` actually permits — is the tool set mutable on
  a live `Agent`, or is it fixed at construction? — is the load-bearing unknown, and it
  decides whether mid-run switching is even possible without a new session.
- **rtk's field.** The map already decided rtk is per-profile. Decide its shape: a
  boolean, a command allowlist, or an `execWrapper` string that generalizes beyond rtk.
  A boolean is honest if rtk is the only wrapper we will ever want; it is the wrong
  shape if it isn't. See [How rtk becomes a profile setting](11-rtk-in-profile.md).
- **A profile naming a model is a bundle decision.** From
  [What pi costs in the bundle](08-bundle-cost.md): each provider SDK costs ~50–100 KB
  gzip, and providers must be imported by subpath rather than through the barrel. So the
  set of models a profile may name is bounded by what is bundled. **All providers are
  in scope** — the dev ruled 448 kB gzip acceptable — so this is no longer about which
  providers exist, but about *when they load*: statically for everyone, or via dynamic
  `import()` when a profile first selects one, which returns the fixed cost to the 62 KB
  floor. That is a question about when a profile's model field is resolved, which is why
  it lands here rather than on the bundle ticket.
- **Storage and precedence.** pi's global-plus-project merge is a good default and
  matches how this repo already thinks. But profiles reference tool names and model
  ids, so a profile file can name things that do not exist — decide what happens then,
  because "silently drops the tool" and "refuses to activate" are very different
  experiences.
- **What a profile is *not*.** Being explicit here prevents the field list growing
  forever. Skills, extensions, and permissions are all plausible members and all
  currently in the fog.

---

## Resolution

**Eight fields. A tool *map*, not a list. Refuses to activate when references dangle.**

### What the harness supports, verified in published 0.83.0

Every field a profile would carry is mutable mid-session, so switching needs no new
session. The original ticket's load-bearing unknown is fully answered.

| Profile field | Mechanism |
|---|---|
| model | `setModel()` |
| thinkingLevel | `setThinkingLevel()` |
| tools | `setTools()` / `setActiveTools()` |
| skills | `setResources({ skills, promptTemplates })` |
| instructions | **no setter** — see below |

**There is no `setSystemPrompt`.** `systemPrompt` accepts
`string | ((context) => string | Promise<string>)`, and `createTurnState()` **awaits the
callback once per turn** (`agent-harness.js:291`, called from `:398/:560/:577/:597`). So
passing a callback that reads current profile state gives a per-turn system prompt with
no setter needed. `before_agent_start` can override it as a second lever. **Pass a
callback, never a string** — a string forecloses `instructions` switching permanently.

### The fields

```
name           string
model          { provider, id }          — Zed: default_model
thinkingLevel  ThinkingLevel             — pi's preset has it; Zed does not
tools          Record<string, boolean>   — a MAP, see below
instructions   string                    — pi's preset has it; Zed deliberately does not
skills         string[]                  — neither reference has it
rtk            (shape set by ticket 11)  — neither reference has it
gatePolicy     "auto" | "ask"            — neither reference has it
```

Five of eight match a shipped implementation. Three are ours, and each is owed to a
closed ticket rather than to analogy: `rtk` because the map ruled rtk per-profile,
`gatePolicy` because [What stops a tool call](03-permission-gate.md) made auto-vs-ask a
profile setting, `skills` because pi exposes them through `setResources`. The paused map
warned that a profile wider than Zed's is where the cost lives; that warning stands, and
these are the fields being bought deliberately.

### Decisions

1. **`tools` is a map (`name -> boolean`), following Zed
   (`crates/agent_settings/src/agent_profile.rs:107`), not pi's `string[]`.** A map
   distinguishes *explicitly disabled* from *not mentioned*. With pi shipping a release
   roughly every 2.1 days, a newly added upstream tool is absent from a list and
   therefore silently excluded; absent from a map, it falls through to its default. The
   map degrades correctly as the tool set moves underneath us.
2. **A dangling reference refuses activation and reports what is missing** (decided with
   the dev). The session stays on the previous profile. The reasoning that decides it:
   an agent running with quietly-different capabilities than its profile claims is a
   worse failure than an irritating one, and it is invisible — the user would attribute
   the degraded behaviour to the model.
3. **All providers are bundled statically** — carried from
   [What pi costs in the bundle](08-bundle-cost.md), where the dev ruled 448 kB gzip
   acceptable. Profile activation is therefore synchronous, with no import failure path.
   **Dynamic `import()` per provider subpath remains available as a pure optimisation**
   — it needs no schema change, only a change to when the model field resolves — and is
   worth revisiting if first-load ever becomes a complaint.
4. **Storage follows pi's shape**: a global file and a project file, merged, project
   winning. pi's preset uses `~/.pi/agent/presets.json` plus `<cwd>/.pi/presets.json`,
   and the precedence matches how this repo already thinks about configuration. Note the
   interaction with root confinement — the global file lives outside the workspace root,
   so it is read by the app rather than through the agent's own filesystem authority.
5. **Ship built-in profiles that users override, not a blank slate.** Zed does this
   (`is_builtin`, `is_unmodified_default`), and it is what makes the feature usable on
   first run. Minimum: an `auto` profile matching the gate default from ticket 03. pi's
   shipped `plan` / `implement` presets are a good second and third.

### Not settled here

- **rtk's exact field shape** — boolean, allowlist, or a generalised wrapper — is
  [How rtk becomes a profile setting](11-rtk-in-profile.md), now unblocked.
- **What a mid-session switch records in the session log** stays in the map's fog,
  waiting on [Where sessions are stored](09-session-store.md) to establish whether custom
  entry types can be appended to pi's session tree.
- **Whether a profile also defines a subagent** stays in the fog, as charted.
