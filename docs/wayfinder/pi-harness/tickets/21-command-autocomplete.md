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

## Why it was not done with skills

Nothing about skills is harder to find without completion than profiles already
were, and `/skills` lists every name with a mark for whether the active profile
permits it. The feature works; this makes it pleasant.
