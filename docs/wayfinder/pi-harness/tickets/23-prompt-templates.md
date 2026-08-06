---
label: wayfinder:ticket
title: Commands the user writes
status: closed
---

# Commands the user writes

**Shipped in Slice 35.** Written after the fact, because this never was a
charted question: the map deleted *"a command system for the agent chat"* from
its queue as *"one `promptFromTemplate` call"*, and
[ticket 21](21-command-autocomplete.md) then found the call had never been made.
What follows is the record of the decisions that call turned out to contain.

## What pi ships

All of it, and none of it was rewritten. `loadPromptTemplates(env, paths)` reads
`.md` files from a directory over our own `ExecutionEnv`, non-recursively, and
reports read and parse failures as diagnostics — the same shape `loadSkills`
uses. `AgentHarness.promptFromTemplate(name, args)` finds the template in the
harness's resources, formats it with `formatPromptTemplateInvocation`, fills
`$1`, `$@`, `$ARGUMENTS` and `${@:N:L}` with `substituteArgs`, and hands the
result to the same `executeTurn` a prompt goes through. `parseCommandArgs`
splits the argument string on shell quoting.

So the gate, the asker, the hooks, compaction and cancellation are shared with
every other turn, and an unknown name fails as pi's `invalid_argument` rather
than as a prompt that says "/deploy".

## The decisions it contained

**A template is not gated by a profile, and a skill is.** The asymmetry is the
one thing here that could have gone either way, and ticket 13's rule decides it:
naming a thing in a profile is the trust act *because the model can reach it*. A
skill is listed to the model in `<available_skills>`. A template is prose that
goes in front of the model only when the user types its name — the typing is
already the trust act, and a `templates` field on the profile would be a second
decision about the same thing. What the user would get for it is one more list
to keep in sync and one more way for a file to silently do nothing.

**The write side carries the protection instead.** `.agents/commands` is refused
to the agent in `workspace.rs`, beside `.agents/skills` and on the same
argument: an agent that can write a template can write the instructions it will
later be given, and the user typing the name is what runs them. The refusal is a
foot-gun guard of the same kind as the rest of that file, not a boundary — an
agent with a shell still reaches the directory, and only ticket 02's confinement
bounds that.

**A built-in wins a name clash, and the loser is named.** `parseCommand` matches
the built-ins first, so a template called `compact` could never run. Dropping it
silently would leave a user typing into a command they wrote and getting
compaction; refusing the whole load over one name would punish the files that
are fine. It is dropped with a warning, and `/reload` prints it — which is where
someone who just edited the file is looking.

**Project only, no global directory.** The global skills directory works because
`workspace.rs` mounts it at `.skills`; that is one mount, not a mechanism, and a
second would be Rust work nobody has asked for. A command in `.agents/commands`
is committed and shared with whoever clones the project, which is the case that
makes templates worth having.

## What is left

**`substituteArgs` has never been exercised.** The placeholder syntax is pi's
and is covered by pi's own tests, but no template in this repo has run: browser
mode has no `.agents/commands` at all, so this needs the native window like
every other agent surface.
