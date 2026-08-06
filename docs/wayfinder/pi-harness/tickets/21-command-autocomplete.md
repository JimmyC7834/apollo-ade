---
label: wayfinder:ticket
title: Completing a slash command and its argument
status: open
---

# Completing a slash command and its argument

Deferred out of [ticket 20](20-skills.md) by the dev, where it came up as a
question about the *format* of `/skill <name>` and turned out not to be one.

## What is already decided

The separator does not decide this. An autocomplete menu matches typed text
against a list of strings, and a list entry may contain a space — so `/skill
grilling` can be offered whole, and `/skill:grilling` has no advantage. pi uses
the colon form and registers each skill as its own command; this app uses
`/skill <name>`, matching `/profile <name>`, because one separator is one rule.

Skill names cannot contain a space — pi's validator permits lower case letters,
digits and hyphens — so the argument ends at the first space in either format,
and the free text after it is unambiguous.

## Settled in the grill: the chain becomes data, and it goes first

The dev settled this while grilling the deferred list. `AgentChat` finds a
command with a chain of `startsWith` inside `send`. That chain becomes a **list
of commands**, and the work happens **before** this ticket completes anything and
before [ticket 22](22-steering.md) adds `/steer`.

Three consumers want the list: completion here, `/steer` in ticket 22, and
prompt templates if they land. A list built for one consumer gets built again for
the next two.

Where it lives is still open. `src/commands/commandRegistry.ts` exists for the
workbench palette. Slash commands are typed in the composer, which is a different
surface, so the registry may be the wrong home.

## What is open

**The argument source table.** Completing the second word requires knowing which
command is in the first. That is a small map from command name to the list its
argument comes from, and there are four commands and three sources:

| Command | Argument | Source |
| --- | --- | --- |
| `/skill <name> [text]` | skill name | `allSkills()` |
| `/profile <name>` | profile name | `listProfiles()` |
| `/compact`, `/reload`, `/skills` | none | — |

The work is not the table. It is that `AgentChat.tsx` currently parses commands
with a chain of `startsWith` inside `send`, so there is no list of commands to
complete *from* — the first real decision is whether that chain becomes data.
`src/commands/commandRegistry.ts` already exists for the workbench palette and
may or may not be the right home; slash commands are typed where the prompt is
and the palette is a different surface.

## A fifth command is coming, and pi ships it whole

Found by the reuse audit, and it changes the table above rather than the
decision. pi exports a **prompt template** system that is the user-authored
half of a command system: `loadPromptTemplates(env, paths)` reads `.md` files
from directories exactly as `loadSkills` reads skills — same diagnostics shape,
same `loadSourcedPromptTemplates` provenance variant — and
`AgentHarness.promptFromTemplate(name, args)` runs one. `parseCommandArgs`
splits an argument string on shell quoting, and `substituteArgs` fills `$1`,
`$@`, `$ARGUMENTS` and `${@:N:L}`.

The map deleted "a command system for the agent chat" from its queue as *"one
`promptFromTemplate` call"*, and that call has never been made. So the row that
does not exist yet is:

| Command | Argument | Source |
| --- | --- | --- |
| `/<template> [args]` | template name | `loadPromptTemplates` |

Two consequences for this ticket. The completion list must be able to hold
commands that come from **disk** rather than from the `startsWith` chain, which
is a second reason for that chain to become data. And `parseCommandArgs` is what
should split a command line here — `AgentChat` splits `/skill` arguments on
whitespace, which is fine for free text and wrong the moment an argument is
quoted.

Neither is a reason to build prompt templates first. It is a reason not to shape
the command list so that adding them later means shaping it again.

## Why it was not done with skills

Nothing about skills is harder to find without completion than profiles already
were, and `/skills` lists every name with a mark for whether the active profile
permits it. The feature works; this makes it pleasant.
