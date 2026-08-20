# 71 — One file of public names

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent

## What to build

Nothing a user can see. The identifiers a plugin is allowed to name — artifact ids,
command ids, strip item names, token names — move into **one file**, and that file carries
the rule that a rename in it is an `api` bump.

## Why

The fragile surface of a plugin system is not code reach. It is **names**.

A plugin that hides the strip item called `terminal`, or puts its command next to
`view.browser`, or overrides `--muted-foreground`, depends on that identifier continuing to
exist — even though it imported nothing from us and used only the supported API. Those
strings become a promise the moment a plugin says one.

This is the only part of the design that gets harder the longer it waits, because ids leak
into use fast. It is a prefactor, and it goes first for that reason.
[ADR 0005](../../../adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md) records the
decision.

## What is there now

The ids exist and are correct. They are simply scattered, each defined where it is used:

- Artifact ids and their prefixes in `src/artifacts.ts`.
- Command ids in `src/commands/commandRegistry.ts`.
- Glyph names in `src/ui/Icon.tsx`, as `keyof typeof GLYPHS`.
- Token names in `src/tokens.css`.

Nothing here is wrong. What is missing is a single place that says *which of them are
public*, because today the answer is "all of them, by accident".

## The shape of it

One module — say `src/publicNames.ts` — that re-exports or declares the promised ids, and
whose comment states the rule. Not a copy: a name must have exactly one definition, so
this file either holds the definition or re-exports it, never restates it.

**Public is a smaller set than "every id we have."** Internal ids stay internal, and a
plugin naming one is in the unsupported tier. Deciding which ids are public is the actual
work of this ticket; moving them is the easy part.

Token names are the awkward case — they live in CSS, not TypeScript. Either the file lists
the promised custom-property names, with a check that each one exists in `tokens.css`, or
the promise is scoped to "the tokens `tokens.css` defines" and the file says so. Pick one
and write down why.

## Not in scope

No plugin loading, no API, no `api` integer yet — that arrives with
[72](72-a-plugin-loads-and-adds-a-command.md). This ticket only gathers the names and
states the rule.

## Acceptance criteria

- [x] One module holds or re-exports every identifier a plugin may name, and its comment
      states that a rename is an `api` bump.
- [x] No identifier is defined twice — the file re-exports where the definition already
      lives.
- [x] The public set is deliberately smaller than every id in the codebase, and the file
      says what makes an id public.
- [x] Token names are covered, by whichever of the two routes above is chosen, with the
      reason written down.
- [x] `npm run check` and `cargo test` pass.
