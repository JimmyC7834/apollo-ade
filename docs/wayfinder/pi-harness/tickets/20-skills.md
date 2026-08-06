---
label: wayfinder:ticket
title: Which profile composes the skills
status: closed
---

# Which profile composes the skills

The map carried this as two entries — "Skills: composition with profiles" and
"Skills: which profile composes them" — and they were the same question asked
twice. [Ticket 15](15-core-already-does-this.md) put `loadSkills` and
`formatSkillsForSystemPrompt` in the adopt list and **deferred** them, on the
grounds that skills compose with profiles and profiles did not exist. They have
existed since [ticket 04](04-profile-data-model.md) shipped. The duplication is
why nobody went back: an obligation split across two entries belongs to neither,
which is exactly how [ticket 19](19-model-entries.md) survived seventeen
closures.

## What a skill is

A directory holding a `SKILL.md`: front matter with a `name` and a
`description`, then instructions, then whatever else the skill needs — scripts,
reference documents, assets. It is the
[Agent Skills standard](https://agentskills.io/specification), which pi
implements and which Claude Code and Codex also write. That matters more than it
sounds: the format is not pi's, so adopting it costs nothing and a directory
already on this machine works unchanged.

## Settled

### 1. `profile.skills` is a default-off list of names

The field already existed with this shape and `danglingReferences` already
validated it. The question was whether it should become a map like `tools`,
default-on.

It should not. Ticket 04 made an unmentioned tool *on* for a specific reason: a
tool pi adds upstream must not vanish from a profile written before it existed,
because the author never had the chance to mention it. That argument is about
things arriving from a dependency. A skill arrives because someone put a
directory on this machine, which is ticket 13's case — **naming it in a profile
is the trust decision** — and default-on would make dropping a directory on disk
arm it everywhere.

The pi client agrees from the other side. Its trust manager lists `skills` among
the resources that require project trust, and treats the global directory as
trusted outright.

### 2. Both entry points, because pi ships both and says why

- **The agent's**: `formatSkillsForSystemPrompt` writes an `<available_skills>`
  block of name, description and **location**, and the model opens the file with
  the ordinary `read` tool. Progressive disclosure — only descriptions are
  always in context.
- **The user's**: `/skill <name> [text]`, which is `AgentHarness.skill()`. It
  finds the skill in the harness's resources, wraps it with
  `formatSkillInvocation`, and runs it as the turn's first message. The text
  after the name is pi's `additionalInstructions`.

They are belt and braces, not alternatives, and pi's own documentation says so:
*"models don't always do this; use prompting or `/skill:name` to force it."*

They also cannot be merged, which is the fact that settled the design.
`AgentHarness.skill()` opens with `if (this.phase !== "idle") throw
AgentHarnessError("busy")`, so it can never be called from inside a turn and can
never be reached by the model. The model's only route is `read`.

### 3. Two directories: `.skills` (global) and `.agents/skills` (project)

pi reads from six sources — two global, two project, package manifests, and a
settings list. Each is a place a name can collide and, here, a place Rust must
permit. Two is the whole feature.

The project one is **`.agents/skills`, not `.ade/skills`**. `profileFiles.ts`
already recorded why for the project profiles file: `.ade/.gitignore` is `*` and
`list_tree` skips `.ade`, so a file meant to be committed and read would be
neither. `.agents/skills` is also one of the four pi itself reads, so a project
shared with another harness needs no second copy.

**Not settled, and named so it does not read as an oversight:** a `skillPaths`
list in the profile files, which is how pi points at `~/.claude/skills`. One
field and one loop. It is the obvious next thing if moving skills into the
global directory turns out to be the wrong ask.

### 4. Project wins a collision; a collision warns rather than refuses

**pi merges the other way** — user first, project reported as a collision —
because pi does not trust a project until you approve it. That reason does not
carry here: a skill does nothing until a profile names it, so trust is already
spent by the time a name is looked up. What is left is specificity, and the
project is more specific. It is also the rule the two profiles files already
follow, and one merge rule for both is worth more than agreeing with upstream.

A collision **warns and continues**, matching pi. Both files exist and one of
them works; refusing to activate a profile over a name clash would be punishing.
But the loser is now dead code on someone's disk, so `/skills` names both paths.

**What project-wins costs, found in review and kept deliberately.** If a name
identifies a *file*, then "the profile named it, so it is trusted" is sound. With
project-wins the name identifies whichever file wins, so a workspace can
substitute the body of a skill the profile author vetted globally — which is the
half of pi's ordering argument that survives.

Two answers, and only one of them is a change:

- **The agent may not author a skill.** `.agents/skills/**` joins
  `ade.profiles.json` in `agent_may_write`. Without it, a profile permitting
  `deploy` plus an agent writing `.agents/skills/deploy/SKILL.md` is the agent
  editing its own system prompt after the next `/reload` — the exact thing the
  mount was made read-only to prevent, left open on the other side. That was a
  real hole and it is closed.
- **A cloned repo shadowing a global skill is left as it is**, because it is not
  a new capability. That repo also ships `ade.profiles.json`, which defines the
  profiles *and* the tool manifests *and* `gatePolicy`; a project that can do
  that can already do far more than replace some prompt text. Skills merging the
  same way as profiles keeps one rule rather than adding a second, and `/skills`
  names both paths when it happens.

### 5. The read boundary widens, by a fixed read-only mount

This was the real fork and it took the longest.

pi puts each skill's absolute path in `<location>` and has the model `read` it.
That works for pi because **pi has no filesystem boundary**. Ours refuses
everything outside the workspace root, and the global directory is outside it by
definition — so pi's mechanism reaches project skills and not global ones, while
pi itself ranks the global directory *higher*.

Serving the body from memory was the alternative, and it is what the grill first
recommended: `loadSkills` already returns `content`, so a `skill(name)` tool
would be a pure in-memory lookup with no path and no boundary change. What
killed it is that **a skill is a directory, not a file**. Both formatters tell
the model to resolve a skill's relative references against its own directory. A
memory-served body hands over `SKILL.md` and then the model opens
`references/api-reference.md` and is refused. Single-file global skills would
work and multi-file ones would half-work, looking like a model failure rather
than an app refusal.

So the boundary widens — as narrowly as possible:

- **A mount, not an exemption list.** Ids beginning `.skills/` resolve under the
  config directory's `skills` folder instead of under the root. The prefix is
  fixed in Rust, so the renderer cannot widen it and never names an OS path;
  everything else about the policy — no `..`, no symlinks, files only, 2 MiB —
  is unchanged.
- **Read-only, in code.** `read_base` is called by the three read commands and by
  no write command, and `may_write` refuses the prefix outright — for the editor
  too, because a write would land in `<root>/.skills` and create two files with
  one id.
- **Fixed, so nothing crosses the boundary at run time.** The grill's version of
  this decision had Rust told which directories the active profile permitted,
  which is a list the renderer supplies. A constant is strictly safer and is also
  less code.

The mount is what makes both halves work: `<location>` is a path the `read` tool
accepts, and a skill's own relative references resolve beside it.

### 6. No listing without `read`

The listing names locations and tells the model to open them, so a profile
without `read` would advertise files nothing can fetch — and the model fails
rather than the app refusing. pi guards this exactly the same way
(`system-prompt.ts:101`, `hasRead`).

### 7. Loaded at root selection and at `/reload`

The grill settled "at window open and at every profile switch", on the belief
that this app had no reload. It has: `/reload` already exists and is the whole
reason hand-authored profiles and tool manifests are usable without a restart.
So skills load where those load — inside `loadProfileFiles`, before
`installProfiles`, because a profile naming a skill that has not loaded refuses
to activate. A profile *switch* re-filters the already-loaded set rather than
re-reading the disk.

## What is ours

Almost nothing, which was the point. pi's `loadSkills` walks the directories over
our own `ExecutionEnv`; pi parses the front matter, honours ignore files and
reports diagnostics; pi formats the listing and the invocation; pi's
`AgentHarness.skill()` runs the turn. What this repo adds is the two things pi's
core deliberately leaves to the application — **where to look** and **which one
wins** — plus the mount that lets the model read the answer.

`loadSourcedSkills` says as much in its own doc comment: *"the agent package does
not interpret source values; applications define their own provenance shape."*

## Deferred

- **Autocomplete for `/skill <name>`** — [ticket 21](21-command-autocomplete.md).
- **`skillPaths`**, above.
- **`disable-model-invocation`** is parsed by pi and honoured by its formatter,
  so a skill carrying it is hidden from the listing and still reachable by
  `/skill`. Nothing here uses it and nothing here blocks it.
