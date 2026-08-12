# 34 — Go to definition, find references, hover

**Blocked by:** [33](33-lsp-adaptor.md).
**Status:** **landed.** Measured against Monaco's TypeScript worker in the browser and
against a real `rust-analyzer` through `live.smoke.ts`. See [Landed](#landed).

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

- [x] Go to definition, find references and hover work for the ticket 33 language and for
      TypeScript.
- [x] Navigation across files opens the target file at the right position and the editor
      history can go back.
- [x] A definition outside the workspace root either opens read-only through a decided,
      recorded mechanism, or fails with a clear reason. It does not silently widen
      containment.
- [x] References render somewhere already justified, not in a new near-duplicate of search.
- [x] A server that does not support a capability degrades to it being absent, not to an
      error.
- [x] Keyboard reachable, including the references list.

## Landed

**The transport was right, and this ticket found the thing that was not: Monaco's standalone
editor cannot open a file it has no model for.** That single fact decided both open
questions.

`monaco.editor.registerEditorOpener` is the seam, and it is registered **once for every
language**, not per server. It is what makes go-to-definition land somewhere — including for
TypeScript, where Monaco's own worker has always answered correctly and then had nowhere to
put the answer. Both languages now behave the same way from the user's side, which is what
the ticket asked for, and they do so through one piece of code rather than two.

**Find references does not use Monaco's peek widget**, because peek resolves its targets the
same way the default opener does and throws on a file the workbench has not opened. It would
have worked for TypeScript and broken for Rust, which is worse than either.

**So the result set is an artifact, and the ticket's warning is answered rather than
dodged.** What Search and References genuinely share is `WorkbenchTree` and the
`onOpen(id, line)` contract — already shared by the Explorer, Problems and Changes.
`SearchView` on top of that carries a query box, a replace box, a preview/apply pair and the
staleness rule protecting them; References has none of those, so reusing it would mean four
dead controls or a forked body. A search panel with a disabled search box is a worse lie
than a list that says what it is. The grouping is `references.ts` and is checked; the view
is 80 lines with the same shape as `ProblemsView`.

**Containment is refused, not widened.** `fileIdFromUri` returns `undefined` for anything
outside the root, and that undefined is the answer — a definition in `~/.cargo/registry`
produces a named sentence in the live region and no navigation. `workspace.rs` was not
touched. The read-only mechanism the ticket left open is still not built, and this does not
pretend otherwise.

**Keyboard:** `Shift`+`F12` for references, on a global `addEditorAction`. Monaco's own
binding for it is disabled for a language with no reference provider — its precondition is
`hasReferenceProvider` — so there is no race for the key, which is the reason no provider is
registered rather than an accident of it.

### Measured, in the browser, against the TypeScript worker

Ran at 1280×800 in `npm run dev`, on the fixture's `src/util.ts`:

- Cursor on `noop`, `Shift`+`F12` → References artifact raised itself and read
  **`1 reference in 1 file to noop.`**, with the row `export const noop = (): void => {};`
  at `1:14`. The word came from the model, the offset came back through
  `getPositionAt`, and the file id came back through the model registry.
- Cursor on empty space, same key → **`No references to symbol.`** Empty, not an error.
- The Problems panel carries the server's state under its own scope note.

That exercises the action, the language dispatch, the TypeScript worker path, the grouping
and the artifact.

### Measured against rust-analyzer

`node src/features/lsp/live.smoke.ts`, over this repo's own `src-tauri` crate, on
`read_frame` in `lsp.rs`:

- **hover** → `fn read_frame(reader: &mut impl BufRead) -> std::io::Result<Option<String>>`
- **definition** → resolved to `src/lsp.rs`, through `fileIdFromUri` and therefore inside
  the root
- **references** → 5, every one of them inside the root

All three come back through the same conversions the editor uses, so the positions in the
Problems tree and the References list are the ones the server meant. The capability
degradation is real rather than asserted: `client.can()` gates each of the four on what
`initialize` advertised, and rust-analyzer advertises all four.
