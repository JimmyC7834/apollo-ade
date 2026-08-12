# 35 — Rename a symbol

**Blocked by:** [34](34-lsp-navigation.md).
**Status:** **built.** The preview and apply surface is shared with 30, as asked. Shares
33's caveat — no server has run here. See [Landed](#landed).

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

## Landed

**Monaco's rename provider is not registered, and that is the whole design.** The obvious
implementation — `registerRenameProvider`, return the `WorkspaceEdit`, let Monaco apply it —
fails this ticket's central criterion by default: the standalone bulk-edit service applies
edits to **models that already exist** and drops the rest without a word. Renaming a symbol
used in forty files with two of them open would edit two and silently discard thirty-eight.
That is the half-renamed workspace, arrived at by using the framework as intended.

So rename is an action, not a provider. `textDocument/rename` returns a `WorkspaceEdit`;
`workspaceEdit.ts` turns it into `Replacement[]` — **the same type ticket 30's preview and
apply already carry** — and the previewing and the writing below are ticket 30's code, not a
second implementation of it. Sharing the *type* is what makes the sharing real rather than
claimed: every file goes through `provider.writeFile`, the same Rust path under the same
containment, with ticket 30's `refuseReason` still deciding.

**Which settles the criteria as follows.** Dirty editors are not clobbered because
`refuseReason` refuses a file with unsaved changes and names it. A partial failure is
reported because `applyReplacements` already reports per file. An edit outside the root is
refused **whole**, not partially applied — renaming a symbol everywhere except where it is
defined is worse than not renaming it.

**The one thing the shared surface cannot carry, said out loud.** A `WorkspaceEdit` may
contain `create`, `rename` and `delete` operations on files, and rust-analyzer emits a file
rename when a module's name changes. The ticket-30 preview carries file *contents*. So that
edit is refused whole with *"This rename also creates, moves or deletes files. The preview
can only show content changes, so nothing has been done."* — the ticket asked for the
surface to carry it **or say it cannot**, and this says it cannot.

**The arithmetic, which is where a rename eats a file:** edits are applied **last-first**,
because every range is stated against the original document and applying one from the top
shifts every offset below it. Overlaps are refused rather than resolved — the specification
forbids them, so an overlap means the server and this client disagree about the document.
Positions past the end of a line are clamped rather than fatal, because the check that
actually protects the file is ticket 30's whole-contents comparison at apply time, not a
guess about how stale the server is.

`workspaceEdit.check.ts` pins all of it: three occurrences where two share a line, CRLF,
multi-line ranges, insertions, overlaps in both directions, clamping, `changes` vs
`documentChanges`, file operations, and one edit outside the root refusing the whole thing.

**Flow:** `F2` → name prompt → the server is asked → a diff tab per changed file → one
confirm carrying the count. Confirming before the server has answered would be confirming a
number nobody knows.

`F2` is free for the same reason `Shift`+`F12` is: Monaco's built-in rename is disabled
without a rename provider. A file whose language has no server says so rather than offering
a key that quietly does nothing.

**Not observed:** every criterion here needs a live `rust-analyzer`, which
[33](33-lsp-adaptor.md) records is not installed on this machine. The boxes stay unticked.
