# 30 — Replace, not just find

**Blocked by:** none — can start immediately.
**Status:** ready-for-agent.

## What exists

`search_workspace` finds matches across the root and `SearchView` renders them grouped by
file. Nothing writes back.

## What to build

Replace across the workspace, from the search view: type a replacement, see what would
change, apply all or apply per file.

## The interesting half is the preview, not the substitution

Replacing a string is trivial. Doing it to forty files nobody has looked at is how people
lose work, and this repo has no undo for it — [ticket 28](28-session-undo.md) covers agent
turns, not a human's replace.

So the preview is the feature. `MonacoDiffEditor` already exists and currently has one
consumer, `ChangesView`. A second consumer is the point at which its shape gets tested.

Two decisions:

- **Regex or literal?** Literal is safe and boring. Regex with capture groups is what
  people actually want and is also how a replace eats a codebase. If regex, the preview is
  not optional and the pattern must be validated before anything is offered.
- **Per-match or per-file granularity?** Per-file is much simpler and is probably enough.
  Say which, and why, rather than building per-match because it sounds thorough.

## Acceptance criteria

- [ ] A replacement can be previewed as a diff before anything is written.
- [ ] Nothing is written without an explicit apply — no live-editing as you type.
- [ ] Files are written through the same Rust path with the same containment as every
      other write.
- [ ] A file that changed on disk since the search does not get a stale replacement
      silently applied.
- [ ] Open editors reflect replacements, and dirty editors are not clobbered without asking.
- [ ] A replace that matches nothing says so.
