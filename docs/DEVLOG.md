# Dev Log

Append-only record of completed slices. Newest entries go at the bottom.
See `context.md` for the rule and template.

---

## Slice 1 — Empty Workbench Shell

**User outcome:** A desktop window with a custom titlebar and four empty
workbench regions that can be shown, hidden, and resized by mouse or keyboard.

**Added**

- Frameless window (`decorations: false`) with a custom titlebar
- Drag region and double-click-to-maximize
- Minimize, maximize/restore, close buttons, with maximize state read back from
  the window and re-synced on every resize rather than assumed
- Four regions: primary sidebar, main, secondary sidebar, bottom panel
- Pointer and keyboard resizing on all three separators
- Region visibility toggles
- Focus-safe region hiding
- Accessibility help dialog

**UI extracted:** `tokens.css`, `Icon`, `IconButton`, `Pane`,
`ResizableSeparator`, and the `src/ui/index.ts` barrel.

**Dependencies:** React 19, `@vscode/codicons`, `@vitejs/plugin-react@^4`
(pinned — v6 requires Vite 8, this project is on Vite 6). Tauri window
capabilities: `close`, `minimize`, `toggle-maximize`, `is-maximized`,
`start-dragging`.

**Security boundary:** unchanged. No new native surface; window controls only.

**Accessibility**

- Separators use `role="separator"` with `aria-orientation` and
  `aria-valuenow/min/max`; arrow keys resize in 20px steps, Home/End jump to
  min/max
- Every icon-only control has a label
- Hiding a region that holds focus moves focus to main
- Help dialog has modal semantics, a programmatic title, and Escape dismissal

**Validation performed:** `npm run build` passes. Browser-mode behavioral
checks for region landmarks, separator semantics, keyboard resize (including
inverted sashes), focus-safe hiding, and the help dialog open/close/reopen
cycle.

**Not validated:** anything native. `cargo` has never been run in this repo, so
the frameless titlebar, window buttons, and drag region are untested, and
`src-tauri/src/workspace.rs` has never compiled. Browser mode hides the window
controls by design.

**Two bugs found and fixed during validation**

1. A region's separator is a sibling of the region, not a child, so hiding a
   panel while its sash held focus stranded focus on `<body>`. Predicting which
   element is about to be destroyed proved fragile; focus is now repaired after
   the update instead — if the update left focus on nothing, it goes to main.
2. `<dialog>`'s `close` event never fires in the WebView used for testing
   (confirmed against a bare detached dialog). Syncing React state from that
   event desynced it, leaving the help permanently "open" and impossible to
   reopen. React is now the sole source of truth: `cancel` is prevented and
   every close routes through `onClose`. **This will affect any future
   overlay** — do not rely on the dialog's own close event.

**Caveats and deviations**

- Built out of order: `src/workspace.ts` and `src-tauri/src/workspace.rs`
  (Slice 4 material — real filesystem access) were written before this slice
  and are currently dormant and unimported. Slice 2 uses the fixture provider;
  Slice 4 switches the native path on.
- `WorkspaceProvider` is a subset of the guide's interface: `getFiles`,
  `writeFile`, `restoreWorkspace`, and `search` are missing.
- `AccessibilityHelp` uses a native `<dialog>` rather than the `Overlay`
  primitive, which the guide does not introduce until Slice 3. Marked with a
  `ponytail:` comment naming the upgrade path.
- No persistence: layout state resets on reload. Slices 7-8.

---

## Slice 2 — Explorer to Editor

**User outcome:** Navigate the workspace tree by mouse or keyboard, open files
into editor tabs, and read them in Monaco.

**Added**

- Accessible Explorer tree over the deterministic fixture workspace
- Arrow-key navigation, expand/collapse, Home/End, Enter to open
- Editor tabs with selection, closing, and neighbour selection on close
- Monaco source editor with per-file models and preserved view state
- Line reveal support (`revealLine`)
- TypeScript, JSON, CSS, and base Monaco workers

**UI extracted:** `Tabs` (accessible tablist with roving focus), added to the
`src/ui` barrel. Tree behavior deliberately stays in
`src/features/explorer/ExplorerTree.tsx` — the guide extracts `WorkbenchTree`
in Slice 5, once Changes provides a second consumer to design the interface
against.

**Composition:** `EditorWorkbench` = `Tabs` + `MonacoEditor`.

**Dependencies:** `monaco-editor@0.53.0`. `tsconfig` moved to ES2022 (for
`Array.prototype.at`) and now references `vite/client` types for `?worker`
imports.

**Security boundary:** unchanged. This slice runs entirely on the fixture
provider; no native filesystem access is wired up. `workspace.rs` stays
dormant until Slice 4.

**Accessibility**

- Tree uses `role="tree"`/`treeitem` with `aria-level`, `aria-expanded`,
  `aria-selected`, and a roving tabindex so Tab does not walk every row
- Tabs use `role="tablist"` with roving focus, arrow-key movement, and a
  labelled close button per tab; Delete/Backspace closes the focused tab
- Monaco retains its own accessible editing behavior

**Validation performed:** `npm run build` passes; all four workers emit as
separate hashed bundles, which is the dev-works/prod-breaks trap the guide
warns about. Browser-mode checks: collapsed-by-default tree, ArrowRight
expansion, ArrowDown into children, Enter to open, tab creation, roving
tabindex, ArrowLeft tab switching, no duplicate tab when reopening a file,
neighbour selection on close, empty state and Monaco teardown when the last
tab closes. Console is clean on a fresh load.

**Not validated**

- Monaco's actual *painting*. The test WebView never fires
  `requestAnimationFrame`, so `view-lines` stays empty and no screenshot is
  possible. Monaco mounts, its accessibility textarea exists, and content
  loading is proven (a tab only appears after `readFile` resolves) — but
  nothing visual has been confirmed by eye. **Needs a human look.**
- Line reveal, for the same reason.
- Anything native. `cargo` still has never run in this repo.

**Caveats and deviations**

- Bundle is now 3.9 MB for the main chunk plus a 5.8 MB `ts.worker`, matching
  the guide's ~4.2 MB warning. Build time went from ~0.8s to ~25s.
- Editor content is read-only in practice: no dirty state, no save, no
  `writeFile`. Slice 4.
- `revealLine` is plumbed through but nothing calls it yet; Search (Slice 8)
  is its first real consumer.
- Workspace state still lives in `WorkbenchShell`, as the guide intends until
  the Slice 10 controller/layout split.

---

## Slice 3 — Command Center

**User outcome:** Press Ctrl+Shift+P anywhere, type a few characters, and run a
workbench command or jump to a file — then land back exactly where you were.

**Added**

- `commandRegistry.ts`: commands as data plus callbacks
- Fuzzy scoring with a runnable self-check (`npm run check`)
- Quick pick over commands (`>` prefix) and files (bare text)
- Ctrl+Shift+P, arrow navigation with wrapping, Enter to execute, Escape to
  dismiss, focus restoration to the opener
- Result count and empty state

**UI extracted:** `Overlay` — modal semantics, focus entry, containment,
Escape, and opener capture/restore. `AccessibilityHelp` was migrated onto it,
paying off the `ponytail:` debt recorded in Slice 1.

**Dependencies:** none. First slice that adds nothing to `package.json`.

**Security boundary:** unchanged.

**Accessibility**

- Combobox/listbox pattern: `aria-activedescendant` moves the selection while
  focus stays in the input, so the query is never interrupted
- Active row is scrolled into view during keyboard navigation
- Result count is announced via `role="status"`
- Overlay captures the opener before focus moves in, and restores it on close;
  verified from two different openers and from inside Monaco

**Validation performed:** `npm run build` and `npm run check` pass. Browser
checks: open from a button and from inside Monaco, initial `>` query, ranking
(`>tog` puts Toggle Panel first), arrow navigation and wrapping, file mode,
empty state, Enter executing a command, Enter opening a file, Escape
restoring focus to each distinct opener, and the migrated help dialog's
open/Escape/reopen/close cycle plus being launched via a command. Console
clean on fresh load.

**The scoring self-check earned its keep.** It failed twice before any UI
existed, both times on real ranking defects:

1. An uncapped gap penalty scaled with the distance between words, which
   drowned out initials matching — "ts" ranked "Tabs" above "Toggle Secondary
   Sidebar". Gap cost is now capped.
2. With gaps capped, scattered matches beat contiguous ones — "file" ranked
   "Fix Little Errors" above "Open File". Contiguity now outranks word starts.

Two of the original assertions were themselves wrong and were replaced with
ones that isolate the rule under test.

**Not validated**

- Monaco painting, still: the test WebView never fires
  `requestAnimationFrame`. The keybinding conflict *was* verified — the
  capture-phase handler wins from inside Monaco's textarea.
- Anything native. `cargo` still has never run in this repo.

**Caveats and deviations**

- `buildCommands(actions)` is a builder, not a mutable registry with
  register/unregister. Nothing contributes commands dynamically yet; the
  `Command` shape is unchanged either way, so adding registration later will
  not disturb the palette. Marked with a `ponytail:` comment.
- Fuzzy ranking is deliberately lightweight, per the guide — not VS Code's
  algorithm.
- Self-check files are excluded from `tsc` (they need `@types/node`); they are
  verified by being run, not type-checked.
- File search covers the fixture tree only, and matches on basename. Real
  workspace search is Slice 8.

## Slice 4: Real Filesystem Workspace

**User outcome**

Open a real folder from the titlebar's Explorer pane, browse it, open files,
edit them, and save with `Ctrl+S` or the `File: Save` command. Unsaved tabs
carry a dot; closing one asks Save / Don't save / Cancel. The chosen folder is
reopened on the next launch. In the browser the fixture workspace is still
fully usable, including editing and saving (in memory).

**Added**

- Rust `write_file` command, registered in `lib.rs`.
- `WorkspaceProvider` grew `restoreWorkspace`, `getFiles`, `writeFile`;
  `readFile` now returns a `WorkspaceFile` rather than a bare string.
- Fixture provider keeps writes for the session, so the dirty/save workflow is
  exercisable without a native process.
- Editor inputs carry `saved` alongside `content`; `isDirty` compares them.
- `MonacoEditor` gained `onChange`, attached once to the editor (not per model)
  so it survives tab switches.
- `ConfirmDiscard` overlay; `Ctrl+S` on the capture phase; `File: Open Folder`
  and `File: Save` commands; workspace label in the Explorer pane title.
- Custom scrollbars (`::-webkit-scrollbar`) replacing the native Windows ones.

**UI extracted / reused**

- Reused `Overlay`, `Pane`, `IconButton`, `Tabs`. Nothing new was extracted.
- `Tabs` gained a `dirty` flag (marker plus a visually hidden "unsaved");
  `IconButton` gained `disabled`. Both are presentational, no workspace logic.

**Adapters and dependencies**

- All filesystem access still goes through `WorkspaceProvider`. No feature
  imports Tauri.
- `chooseWorkspace` and `restoreWorkspace` share one Rust command:
  `set_workspace` canonicalizes and stores, whatever the path's source.

**Security boundary**

- `write_file` resolves through the same `resolve()` as reads, which requires
  an existing regular file under the canonical root. It therefore cannot create
  files, follow a symlink out of the root, or overwrite a directory.
- Content over 2 MiB is rejected on write as well as read.
- Root confinement is covered by `resolve_confines_to_root`.

**Accessibility behavior**

- Dirty state is announced, not only shown: a visually hidden "unsaved" is part
  of each dirty tab's accessible name.
- The disabled Open Folder button explains itself in its accessible name
  ("Open folder (save your changes first)").
- `ConfirmDiscard` focuses Cancel first, and Escape cancels.
- `Ctrl+S` is documented in the keyboard help dialog.

**Validation performed**

- `npm run build` (tsc + vite) passes.
- **`cargo test` passes** — the first compile of `workspace.rs` in this repo.
  `resolve_confines_to_root` is green, closing the standing debt that the Rust
  side had never been built.

**Not validated**

- No native run: the folder picker, a real recursive listing, an actual disk
  write, and workspace restore across a restart have not been exercised
  end-to-end. Everything native is compile-verified only.
- `write_file` has no dedicated Rust test; it delegates its checks to the
  tested `resolve()`.
- The new scrollbar styling has not been seen rendered.

**Caveats and deviations**

- **`search()` is not on the provider yet.** The guide lists it in Slice 4's
  interface block, but its own slice split puts workspace search in Slice 8.
  Deferred there rather than shipping a stub.
- **Workspace restore uses one raw `localStorage` key**, not the versioned
  persistence schema — that is Slice 7. Marked with a `ponytail:` comment.
- `getFiles()` returns `WorkspaceEntry[]` filtered to files, not a separate
  `WorkspaceFile[]` with content; loading every file's content to list names
  would defeat the point.
- Switching workspaces is blocked while any editor is dirty, rather than
  prompting per file. Editor ids are root-relative and cannot survive a root
  change, so the alternative is silent data loss.
- Scrollbars use `::-webkit-scrollbar`, which is accurate here because the
  WebView is Chromium on every target. Monaco draws its own and is unaffected.

## Slice 5: Changes and Diff Workflow

**User outcome**

The secondary sidebar now holds a real Changes view: staged and unstaged
groups, per-file status badges, a toolbar for stage-all/unstage-all, and a
right-click menu to stage, unstage, or revert a file. Activating a change opens
a side-by-side Monaco diff in the same tab strip as source files, so a file and
its diff can be open at once.

**Added**

- `ChangesProvider` seam (`src/changes.ts`) with a deterministic in-memory
  implementation: added/modified/deleted seeds, staging, revert, and a
  `subscribe` signal.
- `ChangesView` feature: grouped tree, badges, action bar, context menu, and a
  confirmation dialog for revert.
- `MonacoDiffEditor` — read-only, side-by-side, models created per input.
- `EditorInput` became a discriminated union of `SourceInput | DiffInput`.

**UI extracted / reused**

This is where the UI library became intentional, exactly as the guide frames
it. Explorer plus Changes made the shared contract visible, so four primitives
were extracted rather than guessed at:

- `WorkbenchTree` — expansion, selection, keyboard navigation, descriptions,
  accessories, context menus. Explorer was rewritten onto it and shrank to
  entry-to-node mapping; Slice 8's Search will be the third consumer.
- `ActionBar`, `Badge`, `ContextMenu`.
- `src/ui/index.ts` re-exports all of them.

**Adapters and dependencies**

- The Changes UI never learns whether the working tree is real. Slice 9 swaps in
  a git-backed provider behind the same interface.
- The tree speaks workspace ids; the editor speaks `diff:<path>` ids. The
  translation happens at the shell/feature boundary, not inside either.

**Security boundary**

- Unchanged. The fixture changes provider mutates an in-memory object and
  touches no repository and no disk.

**Accessibility behavior**

- `WorkbenchTree` keeps the Explorer's full keyboard model (arrows, Home/End,
  Enter/Space, roving tabindex) and adds the `ContextMenu` key.
- The context menu takes focus on open and returns it to the row on close, but
  only if focus is still inside the menu — a click elsewhere has already put
  focus where the user wanted it.
- Badges are abbreviations ("M"), so each carries a full-word accessible name
  ("Modified"). Group badges announce a count.
- Revert is destructive and is confirmed in a dialog; Cancel takes focus first.

**Validation performed**

- `npm run build` (tsc + vite) passes.
- `npm run check` passes, now including `WorkbenchTree.check.ts`: depth and
  visibility over a nested tree, a grandchild staying hidden while an ancestor
  is collapsed (the bug a one-level check would let through), flat lists, and a
  dangling `parentId`.

**Not validated**

- Nothing was run: the diff editor has never been seen to paint, and the
  context menu, badges, and confirmation dialog have not been exercised by hand
  or with a pointer.
- `cargo` was untouched this slice; no Rust changed.

**Caveats and deviations**

- The pure flattening logic lives in `src/ui/treeRows.ts` rather than inside
  `WorkbenchTree.tsx`, because Node's type stripping cannot run JSX and the
  self-check has to import it. `WorkbenchTree` re-exports the node type with a
  `ReactNode` accessory.
- `WorkbenchTree` owns expansion state internally, with only a
  `defaultExpandedIds` prop. No consumer has needed to drive expansion from
  outside; a controlled variant can be added without changing the signature.
- `ActionBar` is `role="toolbar"` without arrow-key roving — these bars hold
  two buttons and Tab matches every other button group in the workbench.
- `createChangesProvider()` returns the fixture unconditionally. Unlike the
  workspace there is no native counterpart to choose between yet; Slice 9 adds
  the environment check with the git provider. Marked `ponytail:`.
- The diff editor recreates its models on every input change instead of caching
  them like `MonacoEditor` — a diff has no edits or undo history worth keeping
  across tab switches.
