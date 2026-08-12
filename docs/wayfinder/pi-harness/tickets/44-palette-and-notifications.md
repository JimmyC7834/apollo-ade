# 44 — Global Search, slash commands, notifications

**Blocked by:** [39](39-session-navigator.md), [40](40-pinned-workbench.md) — it searches
sessions and opens artifacts.
**Status:** **landed in `e93bff2`, record not yet written.** Last of the shell sequence.
The criteria below are untouched because nobody has checked them against the code — they
say nothing about whether the work is done. Do not read an unticked box here as work
remaining.

## Global Search

The command palette surface, spanning **sessions, files, artifacts and transcript content**.
Opened with Ctrl+K or ADE menu → Command palette. Results identify their source type and
show a compact status or metadata label.

`src/commands/` already has the palette, `fuzzy.ts`, and `commandRegistry.ts` with checks
for both. This widens what it searches; it does not build a second palette.

**Find moves here. Replace does not.** [Ticket 30](30-replace-across-files.md)'s
preview-then-apply cannot live in a result row — it is the Replace Artifact
[slice 40](40-pinned-workbench.md) built. A search result should be able to open it.

Transcript search across *fixture* sessions is fixture search, and the same visible
prototype marking from slice 39 applies.

## Slash commands

Typing `/` at the start of an empty prompt opens command autocomplete above the composer:
filter as you type, Up/Down to change selection, Enter to insert, mouse selection
supported, each row showing the command in monospace with a concise description.

[Ticket 21](21-command-autocomplete.md) landed this and [ticket 27](27-file-mention.md)
extended the same menu with `@`. **This is a restyle, not a rebuild.** The one thing to
check against `completion.ts` is the [Shell Guide](../../UIUX-UPDATE.md)'s *"Enter inserts
the selected command into the prompt"* — if the landed behaviour differs, the landed
behaviour is the one that has been used, and the Guide is describing a mock.

The Guide's examples — `/review`, `/diagnostics`, `/test`, `/summarize`, `/clear` — are
illustrative. The real list comes from the registry.

## Notifications

- Inactive sessions may show unread indicators when completed or waiting for input.
  **Notification state is distinct from lifecycle status** — a session can be done and
  read, or done and unread.
- A modeless toast at the lower right for important completion events, above all
  workbenches, using theme surfaces. Toast actions may open the session.
- ADE menu → Debug notification fires a mock toast for design testing.

With one live session there is little to notify about, and that is fine: the mechanism is
what slice 39's deferred concurrency will need, and one real case exists today — a
long-running turn finishing while the window is not focused.

**A toast is an interruption.** It needs a dismissal that is not a race, it must not steal
focus, and it must be announced without hijacking the screen reader mid-sentence. Use a
polite live region, not an alert.

## Acceptance criteria

- [ ] Ctrl+K and the ADE menu both open the palette; it searches sessions, files, artifacts
      and transcript content, and every result says which it is.
- [ ] A search result can open the Replace Artifact.
- [ ] Results from fixture sessions are marked as such.
- [ ] Slash and `@` completion behave exactly as they do today, restyled. `completion.check.ts`
      passes unchanged.
- [ ] Unread state is separate from lifecycle status in both the model and the navigator.
- [ ] A toast appears at the lower right, does not steal focus, dismisses cleanly, and is
      announced politely.
- [ ] Debug notification exists in the ADE menu.
- [ ] `npm run check` and `npx tsc --noEmit` clean.
