---
label: wayfinder:ticket
title: Completing a slash command and its argument
status: closed
---

# Completing a slash command and its argument

**Shipped in Slice 33.** [`src/agent/completion.ts`](../../../../src/agent/completion.ts)
holds the rule, [`completion.check.ts`](../../../../src/agent/completion.check.ts)
holds the cases, and the composer renders the menu. What is below is the record
of the decisions, marked with what each one turned into.

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

## Done: the chain is data

The precondition shipped in Slice 32 with [ticket 22](22-steering.md).
[`src/agent/commands.ts`](../../../../src/agent/commands.ts) holds the list —
name, summary, argument source, and whether the command means anything mid-turn
— plus `parseCommand`. `AgentChat.send` matches against it, `/steer` was added
by editing a list rather than a chain, and the argument-source column below is
already a field on every entry.

It lives beside the agent rather than in `src/commands/commandRegistry.ts`. That
registry is the workbench palette: its entries carry a `run`, are fuzzy-searched
and belong to the window, where these are typed in the composer, take arguments
and mean nothing outside the agent.

The menu was deferred by the dev when the list landed, and is what Slice 33
added: the list under the composer, the keys that move through it, and the
argument filled from the source column.

## Done: the menu

`complete(text, sources, running)` returns the entries for the text now in the
composer. Two positions, and the space between them decides which — the first
word is a command name, the second is its argument, and everything after the
argument is free text bound for the model, which nothing completes.

Four decisions that the ticket did not ask and the building did:

- **The palette's scorer is reused.** `/prof` finding `/profile` is the question
  `tog` finding `Toggle Panel` already is, and `fuzzyFilter` is forty lines with
  tuned tie-breaks. A second matcher would be a second set of them.
- **An entry equal to the typed text is dropped.** The menu owns Enter while it
  is open, so a finished `/compact` offering `/compact` costs a second press to
  send something already correct. Dropping it closes the menu exactly when the
  user stops typing.
- **The menu offers only what `send` would accept.** `whileRunning` filters it,
  so a running turn offers `/steer` and nothing else. Offering a command and
  then refusing it is a menu that lies.
- **Only permitted skills are completed.** An unpermitted skill is on disk and
  refused by ticket 13; `/skills` remains the listing that shows every one with
  a mark for which is which.

Keys: Up and Down move, Tab and Enter take the entry, Escape closes the menu
until the text changes. The textarea is the combobox and keeps the caret —
`aria-activedescendant` names the selected row rather than focusing it.

## Done: the argument source table

Completing the second word requires knowing which command is in the first. That
is a small map from command name to the list its argument comes from, and there
are four commands and three sources:

| Command | Argument | Source |
| --- | --- | --- |
| `/skill <name> [text]` | skill name | `permittedSkills(allSkills(), activeProfile())` |
| `/profile <name>` | profile name | `listProfiles()` |
| `/steer <text>` | free text | — |
| `/compact`, `/reload`, `/skills` | none | — |

The table is the `argument` field on each `SlashCommand`. The wiring is the
`CompletionSources` record the composer passes in — the rule takes the lists
rather than importing them, so it stays a function of its arguments and the
check needs no skill loader. Both lists are read on every keystroke, because
`/reload` replaces both and a cached menu would be a stale one.

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

Two consequences, and they outlive this ticket. The completion list must be able
to hold commands that come from **disk**, which is why it reads `SLASH_COMMANDS`
as a value: templates join it by being added to the list, and the menu needs no
change. And `parseCommandArgs` is what should split a command line here —
`AgentChat` splits `/skill` arguments on whitespace, which is fine for free text
and wrong the moment an argument is quoted. That one is still not done, and it
belongs to whoever builds templates.

## Why it was not done with skills

Nothing about skills is harder to find without completion than profiles already
were, and `/skills` lists every name with a mark for whether the active profile
permits it. The feature works; this makes it pleasant.
