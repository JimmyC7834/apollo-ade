---
label: wayfinder:grilling
title: What is a profile, concretely?
parent: ../map.md
blocked-by: []
assignee:
status: open
---

# What is a profile, concretely?

## Question

The novel feature of this harness. Everything else on the map that mentions profiles
hangs off this answer.

**Read `docs/RESEARCH-zed-harness.md` §3 first.** Zed ships this feature and its whole
profile is 309 lines including tests, with five fields:

```rust
name
tools: IndexMap<Arc<str>, bool>
enable_all_context_servers: bool
context_servers: IndexMap<name, ContextServerPreset>
default_model: Option<LanguageModelSelection>
```

Tool exposure and a default model — **no system prompt, no skills, no extensions, no
permissions**. Applying it is one filter predicate (`thread.rs:4064`). The selector UI is
~3× the model layer.

That is the cheap version, and it is cheap for a structural reason: the tool set is
rebuilt every loop iteration anyway, so a profile is a filter over a list that already
gets recomputed. The three fields this effort wants to add — system prompt, skills,
extensions — are **not** recomputed per iteration, which is why adding them is not a
matter of three more `IndexMap`s.

So the real question this ticket answers is: **which fields earn their place, given that
Zed shipped the feature without three of the four you asked for?**

Settle:

- **Fields.** Which of skills / tools / system prompt / extensions / model / run caps
  are profile-scoped, and which are global to the harness? A field that turns out to be
  global is one less thing to resolve at every call site.
- **System prompt: override or append?** Zed profiles replace; Claude Code's agent
  definitions build a *new* system prompt for the child. If append, append where — and
  what is the immovable base the harness always emits?
- **Tools: allowlist, denylist, or full set?** Claude Code's agent frontmatter uses an
  allowlist. An allowlist over a fixed built-in set is cheaper than an open registry.
- **Composition.** Zed has **no runtime inheritance** — `create()` copies a base
  profile's toggles once, at creation, and thereafter they are independent. What looks
  like composition comes from the *settings file merge* instead, which is why a user
  profile keyed `"write"` can be a one-key override like `{"tools": {"fetch": false}}`.
  Decide whether that trick is available here or whether composition must be explicit.
- **Storage.** On-disk format and location, and whether profiles are user-level,
  project-level, or both. Zed chose **user-level only** — project settings contribute
  only `disable_ai`. Note that `context.md` forbids the renderer from holding workspace
  authority, so profile *resolution* is Rust's job even if profile *editing* is UI.
- **Defaults.** What ships built-in. Zed ships three: `write` (22 tools), `ask`
  (13, read-only), `minimal` (none). Note the absent-means-disabled convention —
  `tools.get(name) == Some(&true)` at read time, while absent ≠ false during the
  settings merge. That asymmetry is load-bearing and easy to reimplement wrongly.

References: `docs/RESEARCH-zed-harness.md` §3 for the shipping implementation; Claude
Code's `.claude/agents/` frontmatter (`loadAgentsDir.ts`,
`docs/claude-code-how-it-works.md`) for the variant that *does* carry a system prompt.
