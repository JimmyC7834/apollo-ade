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

## Decided: literal, case-insensitive, per file

**Literal, not regex.** `search_workspace` lowercases both sides and matches a
substring, so a literal case-insensitive replace changes exactly the matches the
result list above it is showing. A regex replace whose matches disagreed with the
visible results would be worse than no replace: the preview would be correct and
the list would be a lie. Regex is the thing to add *with* its own search.

**Per file, not per match.** It is what the results tree already groups by, so
"apply this file" needs no selection model at all. Per-match is not designed
against; it is simply not built.

## Landed

`replace.ts` holds the substitution and the refusal rule with no React in it,
because both are ways to lose a file. `SearchView` gained a replace field, a
Preview button and a plan list; the preview itself is a `diff:`-style editor tab
under a `replace:` id, so `MonacoDiffEditor` got its second consumer without a
second diff surface being built.

**The apply lives in `WorkbenchController`**, and not for tidiness: it is the
only thing that knows which files are open and which are dirty, and that is half
of the safety rule. Each file is re-read immediately before it is written and
compared against the bytes the preview was built from — a whole-content compare
rather than a timestamp, because a file edited and edited back is not stale and a
clock is not evidence about bytes.

A dirty editor is **refused rather than confirmed**. The two answers to that
dialog are "lose your edit" and "lose the replacement", and leaving the file
alone with its name in the report is the one the user can undo by saving and
applying again.

Verified in browser mode against the fixture: 2 files planned, previewed as a
diff, applied, and a re-search showed the written text. The dirty-editor refusal
is covered by `replace.check.ts` and has **not** been exercised by hand.

## Acceptance criteria

- [x] A replacement can be previewed as a diff before anything is written.
- [x] Nothing is written without an explicit apply — the plan is built by a
      button, not by typing, and an unpreviewed plan cannot be applied.
- [x] Files are written through the same Rust path with the same containment as
      every other write. It is `WorkspaceProvider.writeFile`, unchanged.
- [x] A file that changed on disk since the search does not get a stale
      replacement silently applied.
- [x] Open editors reflect replacements, and dirty editors are not clobbered —
      they are refused and named.
- [x] A replace that matches nothing says so.
