# 35 — Rename a symbol

**Blocked by:** [34](34-lsp-navigation.md).
**Status:** ready-for-agent, once 34 lands.

## Why it is last

Rename is the first LSP capability that **writes**. Everything in 33 and 34 reads: a bad
diagnostic is noise and a wrong definition is a wasted click, but a bad rename edits files
across a codebase. It goes last because by then the transport has been exercised twice and
the failure modes are known.

It is blocked on 34 rather than 33 for a concrete reason: rename is find-references plus
edits, and a rename built on a references implementation nobody has used is a rename built
on an untested query.

## What to build

Rename a symbol across the workspace, through the language server, previewed before it is
applied.

## What it shares with ticket 30

[Ticket 30](30-replace-across-files.md) is the same problem with a worse query: change
many files at once, and let the person see it first. **The preview and apply surface
should be the same one.** If ticket 30 landed first, this reuses it; if this lands first,
build it so 30 can. Two multi-file preview surfaces would be the clearest possible failure
of the two-consumer rule.

The difference worth respecting is that an LSP rename returns a `WorkspaceEdit` — a set of
positioned edits, some of them in files that are not open, occasionally including file
*renames* as well as content edits. That is more than a search-and-replace result, and the
shared surface has to be able to carry it or say it cannot.

## Acceptance criteria

- [ ] A symbol can be renamed across the workspace, with a preview before anything is
      written.
- [ ] The preview and apply surface is shared with ticket 30, or the reason it cannot be
      is recorded here.
- [ ] Every edited file goes through the same Rust write path and the same containment.
- [ ] An edit the server places outside the workspace root is refused, not applied.
- [ ] Dirty editors are not clobbered without asking.
- [ ] A rename that partially fails does not leave the workspace half-renamed without
      saying so.
- [ ] A server without rename support offers no rename, rather than an error.
