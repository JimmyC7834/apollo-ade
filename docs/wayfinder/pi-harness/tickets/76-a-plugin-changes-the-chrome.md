# 76 — A plugin changes the chrome

**Blocked by:** [71](71-one-file-of-public-names.md),
[72](72-a-plugin-loads-and-adds-a-command.md).
**Status:** ready-for-agent

## What to build

The last two rungs of "modify the UI/UX", neither of which involves the plugin drawing
anything:

- **`theme(tokens)`** — a plugin supplies token values and the workbench takes them.
- **Layout claims** — a plugin hides, reorders or renames what already exists: strip items,
  dock tabs, command centre entries.

## Why

The dev asked for plugins that change the ADE, not only ones that add to it. These two are
the whole of that, once
[ADR 0005](../../../adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md) ruled out
the third rung — **a plugin never replaces one of our components**. Everything a plugin
substituted would freeze at the moment of substitution, and the Shell Guide's accessibility
contracts, focus order and keyboard model are ours to keep working. A plugin that wants its
own transcript gets a panel next to ours, not instead of ours.

## What is there now

- `src/tokens.css` keeps every value the Shell Guide gave it. Theming is already a matter
  of custom-property values, not of components — [ADR 0003](../../../adr/0003-the-shell-guide-keeps-topology-and-loses-look.md)
  is why.
- Strip items, dock tabs and command centre entries are all lists rendered by our own
  components, so hiding and reordering are data changes rather than new machinery.
- [71](71-one-file-of-public-names.md) is the prerequisite that makes any of this safe to
  promise: a layout claim **names** the thing it modifies, and that name becomes an API.

## The shape of it

**A layout claim names a public id, and an unknown id is a visible failure.** A plugin that
hides `terminal` when no such id exists must say so in Problems, not silently do nothing —
a rename on our side otherwise turns into a plugin that appears to work.

**Only ids in the file from [71](71-one-file-of-public-names.md) may be named.** An id
outside it is unsupported; refuse the claim with a message that says so.

**A theme is values only.** No selectors, no rules, no arbitrary CSS in our document — that
is the component-replacement rung by another route. If a plugin supplies a whole stylesheet
it is a panel's stylesheet, not ours.

**Two plugins that fight.** Two themes, or two plugins reordering the same strip, need a
rule and it should be the boring one: last enabled wins, and the conflict is visible
somewhere the user can find it. Do not build precedence weights.

**The dev must be able to get back.** A plugin that hides everything is a plugin that hides
the way to disable it. There has to be one route to the plugin list that no claim can
remove.

## Not in scope

Component replacement, in any form. Arbitrary CSS injected into our document. Layout claims
that create new regions — a plugin that wants a new surface uses a panel
([75](75-a-plugin-draws.md)).

## Acceptance criteria

- [ ] A plugin's `theme` changes the workbench's tokens, and disabling the plugin restores
      them.
- [ ] A plugin hides, reorders and renames a strip item, a dock tab and a command centre
      entry, by public id.
- [x] Naming an id that does not exist, or one that is not public, fails with one line in
      Problems that names the plugin and the id.
- [x] A theme carrying selectors or rules rather than values is refused.
- [ ] Two plugins claiming the same thing resolve by last-enabled-wins, and the conflict is
      visible.
- [ ] There is one route to the plugin list that no claim can hide, driven with a plugin
      that hides everything it is allowed to.
- [x] `npm run check` and `cargo test` pass.
- [ ] Driven in the **native** window.

**The strip and the dock tabs are one list here.** The dock strip renders the pinned
artifacts, so one `applyLayout` call covers both rather than two call sites pretending to be
independent.

**`order` pulls to the front rather than permuting.** A permutation would need a plugin to
name every id there is, and would go wrong the day we add one.

The way back is `artifact:plugins` and the command that shows it, refused as claim targets and
asserted in `chrome.check.ts`. What is unticked is watching a plugin that hides everything
else fail to hide that one.
