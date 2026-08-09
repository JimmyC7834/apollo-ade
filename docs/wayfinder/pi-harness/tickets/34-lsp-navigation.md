# 34 — Go to definition, find references, hover

**Blocked by:** [33](33-lsp-adaptor.md).
**Status:** ready-for-agent, once 33 lands.

## Why this is its own ticket

Ticket 33 proves the transport with one capability. This is the second capability, and
splitting them is what keeps 33 from becoming a quarter of work with nothing demoable in
the middle. If the transport is right, this is mostly registering Monaco providers against
it; if the transport is wrong, this is where that shows, and it is much better to find out
against a landed 33 than inside it.

## What to build

Go to definition, find all references, and hover, through the language server from
ticket 33 — and through Monaco's own TypeScript worker for TS, so the two languages behave
the same way from the user's side.

## The one that is not like the others

**Find references opens a result set, not a location.** Definition and hover land in the
editor; references needs somewhere to render a list — and `SearchView` is already a list
of positions grouped by file. Reuse it or do not, but decide deliberately: a second
results view that looks almost like search is exactly the drift this repo's two-consumer
rule exists to catch.

Cross-file navigation also opens files that were never in the explorer's tree — a
definition inside `node_modules` or outside the workspace root. **That is a containment
question, not a UI one.** Reading outside the root is not something `workspace.rs` allows,
and it should not start allowing it silently for this. Failing honestly is acceptable.

## Acceptance criteria

- [ ] Go to definition, find references and hover work for the ticket 33 language and for
      TypeScript.
- [ ] Navigation across files opens the target file at the right position and the editor
      history can go back.
- [ ] A definition outside the workspace root either opens read-only through a decided,
      recorded mechanism, or fails with a clear reason. It does not silently widen
      containment.
- [ ] References render somewhere already justified, not in a new near-duplicate of search.
- [ ] A server that does not support a capability degrades to it being absent, not to an
      error.
- [ ] Keyboard reachable, including the references list.
