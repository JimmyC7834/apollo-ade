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

## Slice 6: Native Terminal Panel

**User outcome**

The bottom panel is a real terminal. New terminal starts a PowerShell session
in the selected workspace root, typing reaches the shell, output comes back,
dragging the sash resizes the PTY, and multiple shells live in their own tabs.
Closing a tab kills its process. In the browser the same UI runs against an
echo fallback, marked with an "Echo" badge so it is never mistaken for a shell.

**Added**

- `src-tauri/src/terminal.rs`: `terminal_create/write/resize/kill`, one
  blocking reader thread per session, output and exit as Tauri events.
- `TerminalAdapter` seam (`src/terminal.ts`) with native and echo
  implementations.
- `TerminalPanel` (tabs, action bar, exit and echo badges) and
  `TerminalInstance` (one xterm.js instance bound to one session id).
- `portable-pty` 0.9.0, `@xterm/xterm`, `@xterm/addon-fit`.

**UI extracted / reused**

- Reused `Tabs`, `ActionBar`, `Badge`, `Pane`, and the resizable bottom region
  unchanged. Nothing new was extracted — which is the point: the primitives
  from Slice 5 absorbed a third feature without moving.

**Adapters and dependencies**

- Rust owns every process handle. The frontend holds an opaque session id and
  can only write, resize, and kill through the adapter.
- Output and exit are events, not command results: a shell emits bytes when it
  likes, not when it is asked.
- Live terminal processes are deliberately not persisted (Slice 7 persists
  stable user state, not runtime resources).

**Security boundary**

- The shell command is hardcoded, not composed from anything the frontend
  sends. The only frontend-supplied values are the session id, the size, and
  the cwd — which is the workspace root the user already chose.
- `terminal_write` requires an existing session id; unknown ids are rejected
  rather than created implicitly.

**Accessibility behavior**

- xterm claims Tab for the shell, which would trap keyboard focus in the panel.
  Shift+Tab is handed back to the browser as the escape hatch, and is
  documented in the keyboard help dialog.
- Each instance is a labelled `role="group"`; exit state is a badge with a
  full-word accessible name, not only a colour.

**Validation performed**

- `cargo build` and `cargo test` pass with the new PTY module.
- `npm run build` and `npm run check` pass.

**Not validated**

- **No shell has ever been run.** Spawning, output, resize, kill, and exit are
  compile-verified only. The echo fallback has not been exercised either — the
  test WebView still cannot paint, so xterm has not been seen to render.
- Terminal cleanup on application shutdown is untested.

**Caveats and deviations**

- The shell is hardcoded to `powershell.exe -NoLogo -NoProfile` on Windows and
  `/bin/sh` elsewhere. Cross-platform shell discovery is not implemented.
- The exit event carries no code: the reader thread detects EOF, and the exit
  status is not collected from the child. The UI shows "Exited", not a status.
- Killing a session drops it from the map immediately; the reader thread ends
  on its own when the PTY closes. Cleanup and shutdown need production
  hardening, as the guide notes.
- Each `TerminalInstance` subscribes to the output stream and filters by its
  own id, rather than the panel routing events. With a handful of terminals
  this is cheaper than the bookkeeping it would replace.
- The browser fallback echoes text and handles backspace. It is not a shell and
  says so in its banner and its badge.

## Slice 6a: Terminal visual pass (follow-up)

Not a slice: reported as "the terminal looks ass". Corrected against the VS
Code source in `../`, so the values are quoted, not eyeballed.

**Changed**

- Terminal tokens added to `tokens.css` from VS Code's own defaults: the full
  16-colour `terminal.ansi*` map and `terminal.foreground` from
  `terminalColorRegistry.ts`, `terminal.selectionBackground` (via
  `editor.selectionBackground`, `#264F78`), `terminal.tab.activeBorder` from
  `dark_modern.json`, and the font from `DEFAULT_WINDOWS_FONT_FAMILY` plus
  `defaultTerminalFontSize` (14, not the 12 I had guessed).
- Cursor is now block and non-blinking, `lineHeight` 1, `letterSpacing` 0,
  `scrollback` 1000 — all VS Code defaults.
- **Fixed a real bug:** the font family was `var(--ide-font-family-mono)`.
  xterm measures on a canvas, so it read that string as a font *name*. Tokens
  are now read off the document with `getComputedStyle` and passed as literals,
  which keeps `tokens.css` the single source without breaking measurement.
- `Tabs` gained a `variant`: "editor" is the existing boxed strip, "panel" is
  VS Code's flat strip with an underlined active tab. The terminal uses panel.
- Dropped the `Pane` wrapper around the terminal. A 35px pane header above a
  30px tab bar spent a third of the panel's default height on chrome; VS Code
  puts title, tabs, and actions in one row, so the bar is now the header and
  the region is labelled on the section itself.

**Not validated**

- Still nothing rendered. These are corrections to values and structure, not
  observations of pixels.

## Slices 7 and 8: Persistence and Workspace Search

**User outcome**

The workbench resumes where it was left: layout visibility and sizes, the
selected folder, which primary view was showing, the open editors, the active
tab, and any unsaved text. A new Search view in the primary sidebar searches
the whole workspace, groups matches by file with a per-file count, and opens a
result at its matching line.

**Added**

- `PersistenceAdapter` (`src/persistence.ts`): versioned localStorage, read
  once synchronously at mount, written on every change to persisted state.
- Rust `search_workspace`: case-insensitive line search reusing the tree walk.
- `WorkspaceProvider.search`, completing the guide's Slice 4 interface, with a
  fixture implementation over the fixture's own (possibly edited) contents.
- `SearchView`: debounced query, status line, results grouped by file.
- Explorer/Search switching, in the pane's `ActionBar` and as
  `View: Show Explorer` / `View: Show Search` commands.
- `openFile` takes an optional line, so opening an already-open file from a
  search result still moves the cursor.

**UI extracted / reused**

- Search results render through `WorkbenchTree` — its third consumer, and the
  one the guide predicted. Reused `Badge` for per-file match counts and
  `ActionBar` for the view switcher. Nothing new was extracted.
- `WorkbenchTree.defaultExpandedIds` now applies per id as it first appears,
  rather than only on first render: search groups arrive after the query
  resolves, and would otherwise all be collapsed. Ids the user has since
  collapsed stay collapsed.

**Adapters and dependencies**

- Search belongs to `WorkspaceProvider`. The Search UI cannot tell whether
  results came from Rust or from the fixture.
- Persistence is its own adapter, so the shell never touches localStorage.

**Security boundary**

- `search_workspace` reuses `walk` and `resolve`, so it inherits the existing
  policy exactly: root confinement, ignored directories, no symlinks, the depth
  cap, and the 2 MiB limit. Nothing new was granted.
- Files that are too large or not UTF-8 are skipped, not reported as errors —
  an unreadable file is not a search failure.
- Results are capped at 500 and previews at 200 characters, so a minified
  bundle cannot ship a megabyte per match.
- Persisted state is untrusted input: an unknown version, a missing version,
  corrupt JSON, or a non-object payload all load as `undefined` rather than
  being partially read or migrated by guesswork.

**Accessibility behavior**

- The search field has a real (visually hidden) label.
- The result count is `role="status"`, so it is announced — it is the only
  feedback that a search finished at all. Its line is reserved even when empty,
  so results do not jump.
- Both view-switcher buttons expose pressed state.

**Validation performed**

- `cargo test` passes (search compiles; root confinement still green).
- `npm run build` passes.
- `npm run check` passes, now including `persistence.check.ts`: round trip,
  unknown version, missing version, corrupt JSON, non-object payload, and a
  localStorage that throws on both read and write.

**Not validated**

- No search has ever been run against a real workspace, and no session has been
  restored — the persistence path is covered by its self-check, not by an
  actual restart.
- Debounce timing, the status line, and result grouping have not been seen.

**Caveats and deviations**

- Search is plain case-insensitive substring matching: no regex, no
  include/exclude globs, no cancellation of an in-flight native search, and no
  index. A superseded result set is discarded rather than the work being
  stopped.
- The 500-result cap is applied while walking, so results are the first 500 in
  tree order, not the best 500.
- Restoring an editor re-reads the file for its `saved` baseline and keeps the
  persisted text as `content`, so a file changed on disk between sessions
  correctly shows as dirty. Files that have disappeared are dropped silently.
- Live PTY sessions, modal visibility, and focus are deliberately not
  persisted, per the guide's persistence policy.
- Layout state is read synchronously at mount rather than in an effect;
  applying it after the first paint would show the default and then snap.

## Slice 9: Real Git Source Control

### User outcome

The Changes view now shows the actual state of the selected repository. Saving
a file makes it appear there; staging, unstaging and reverting run real git;
opening a change shows HEAD against the working tree in the Monaco diff editor.
Browser mode is unchanged and still runs the deterministic fixture.

### Added

- `src-tauri/src/git.rs` — the git authority. `git_changes`, `git_diff`,
  `git_stage`, `git_unstage`, `git_revert`, all via `git -C <root>`.
- `git status --porcelain=v1 -z --untracked-files=all` parsing in
  `parse_status`, with a Rust unit test over the shapes the UI renders.
- `Change.revertable` through the whole seam, so the UI can hide an action it
  cannot honour.
- `ChangesProvider.refresh()`, so a save (or a workspace change) can tell the
  view the working tree moved.
- `gitChangesProvider()` in `src/changes.ts` behind the existing interface,
  selected by the same `__TAURI_INTERNALS__` check as the workspace.

### UI extracted/reused

Nothing new. The Changes tree, status badges, context menu, confirm overlay,
Monaco diff editor and editor tab model were all reused unchanged — which is
the point of the slice. The only view edit was making the Revert menu item
conditional.

### Adapters and dependencies

No new dependencies on either side; `git` is invoked with `std::process`. The
frontend still never touches Tauri outside `changes.ts` / `workspace.ts` /
`terminal.ts`. `workspace::resolve` and `root_of` became `pub(crate)` so the
git module reads working-tree content under the workspace's own rules rather
than inventing a second file-reading path.

### Security boundary

- Ids from the frontend pass `relative()` before reaching git: `Normal`
  components only, so no absolute paths, no `..`, and nothing that could be
  read as an option. Every mutating command also uses `--`.
- Working-tree content is read through `workspace::resolve`, inheriting
  symlink rejection, the 2 MiB cap and root confinement.
- All git operations are scoped to the canonical workspace root; there is no
  command that takes a path from the UI as a repository.
- `CREATE_NO_WINDOW` on Windows, so git calls do not flash a console.

### Accessibility behavior

Unchanged. Revert disappearing from the context menu rather than appearing
disabled keeps the menu's arrow navigation over actionable items only.

### Validation performed

- `cargo test` — 3 passing, including the new `parse_status` test (staged and
  unstaged modify, untracked, staged delete, staged add, a rename whose second
  `-z` field must not be read as another entry, and a path with a space) and
  `relative_rejects_escapes`.
- `npm run build` and `npm run check` clean.

### Not validated

Nothing has been run natively — no `npm run tauri dev` session has ever
happened in this project. Every native behaviour in this slice is
compile-verified only: real `git status` output, staging, unstaging, revert,
the diff contents, the non-repository fallback, and the save-then-appear
workflow the user reported. The exact `not a git repository` substring match
in `git_changes` in particular has never been seen against real git output.

### Caveats and deviations

- Porcelain v1 parsing is deliberately minimal, one row per path. A file that
  is staged *and* edited again shows only its staged half; renames appear as a
  modification of the new path; conflicts, submodules, binary files and
  ignored files are not modelled.
- `git_diff` is HEAD-vs-worktree only. It does not show the index as a third
  side, which is the guide's noted `git_content` caveat.
- Revert restores from HEAD *and* unstages, so the file leaves the change list
  entirely — matching the fixture's behaviour. It is hidden for untracked and
  newly added files, which have no HEAD version to restore from; deleting them
  is not an action this app offers.
- An already-open diff tab does not auto-refresh after a save or a stage.
  Re-activating the change row replaces its contents, which is one click. The
  editor is not re-activated automatically because that would steal focus from
  the file being saved.
- A genuine git failure (git missing, repository corrupt) surfaces as an empty
  change list plus a `console.warn`, not a visible error. The guide requires a
  non-git workspace not to crash the workbench; distinguishing the two states
  in the UI is not modelled.

## Slice 10: Controller and Layout Separation

### User outcome

Nothing visible changed, by design. This slice buys the ability to change the
workbench topology without touching a single feature module.

### Added

- `src/workbench/WorkbenchLayout.tsx` — titlebar and body topology, region
  placement, visibility, widths and heights, both sashes, focus transfer when
  a region disappears, and the overlay and announcement slots.
- `src/workbench/WorkbenchController.tsx` — provider selection, commands,
  persistence, workspace and editor state, feature lifecycle, composition.
- `WorkbenchShell.tsx` deleted. `main.tsx` renders the controller.

### The interface

`WorkbenchLayoutSlots` is the guide's contract verbatim: `titlebar`,
`primarySidebar`, `main`, `secondarySidebar`, `panel`, optional `overlays` and
`announcement`. Alongside it the layout takes one compact `state` object
(`visible`, `primaryWidth`, `secondaryWidth`, `panelHeight`) and exactly one
`onChange(next)` callback carrying the whole next geometry.

The single callback is deliberate and is the guide's explicit warning: a set of
per-region setters would leak sash mechanics back into the controller and make
the interface shallow. The controller now contains no width, no minimum, no
maximum, and no separator.

### UI extracted/reused

No new primitives. `ResizableSeparator` moved from the shell into the layout,
which is the only module that should know a sash exists.

### Adapters and dependencies

Unchanged. No new dependencies. Features still receive providers from the
controller and know nothing about where they are rendered — `TerminalPanel`,
`ChangesView`, `SearchView`, `ExplorerTree` and `EditorWorkbench` were not
edited at all.

### Security boundary

Untouched. This slice moves React state and JSX; it crosses no trust boundary.

### Accessibility behavior

- Focus repair on region hiding moved with the geometry that causes it. The
  `main` ref now lives in the layout, which is what owns the element.
- The `announcement` slot renders into a permanently mounted
  `role="status" aria-live="polite"` region. It is always present even while
  empty: a live region mounted together with its first message announces
  nothing, because the screen reader was not observing it beforehand. No
  feature pushes announcements through it yet.

### Validation performed

- `npx tsc --noEmit` clean, `npm run check` clean (3 self-checks).
- Live: this refactor was applied while `npm run tauri dev` was running. Vite
  reloaded the page and the app came back with no console or build errors.

### Not validated

The persistence schema is asserted unchanged by construction — the four
persisted geometry fields are exactly `WorkbenchLayoutState`, spread into
`PersistedState` — but no restart against a pre-refactor `localStorage` payload
was performed. Sash dragging, region toggling and focus transfer were not
re-exercised by hand after the move.

### Caveats and deviations

- `WorkbenchController` is still the largest module in the project, exactly as
  the guide predicts. Domain-specific hooks are a later problem.
- `DEFAULT_LAYOUT` lives in the layout module, not the controller, so every
  geometry number in the app has one home. The persisted values themselves are
  unchanged (260 / 260 / 220).
- The announcement slot has no producer. It is part of the guide's contract and
  the live region has to exist early to work at all, so it ships empty.

## Slice 10a: Region clamping and the empty-state folder action (follow-up)

Not a slice. Two defects found by running the app for the first time.

### User outcome

A panel sized in a large window no longer crushes the editor when the app
reopens smaller, and a workbench with no folder open now offers a way to open
one instead of only a small icon in a pane header.

### Added

- `.ide-region-sidebar { max-width: calc(100% - var(--ide-region-min)) }` and
  the same as `max-height` on `.ide-region-panel`.
- `ExplorerTree` accepts an optional `onOpenFolder`. When present it renders an
  empty state with an "Open Folder" button instead of the tree.
- `.ide-empty-state` in `App.css`.

### Why CSS and not the drag handler

The sashes clamp against their own min and max, never against the space
actually available, so nothing was wrong with the stored value — 565px was a
legitimate panel height in the window where it was chosen. Clamping at render
time in CSS means the preference survives: shrink the window and the region
gives way, grow it back and the user's size returns. Clamping in the handler,
or on resize, would silently destroy a size the user picked.

`--ide-region-min` is the same floor the sashes already use, so main is
guaranteed the same minimum by either path.

### UI extracted/reused

None. `.ide-empty-state` is feature CSS, not a primitive — the Explorer is its
only consumer. Note that this makes `.ide-button` a fourth hand-written
consumer; the `Button` extraction question raised earlier is still open.

### Adapters and dependencies

Unchanged. `ExplorerTree` still knows nothing about workspaces or Tauri: the
controller decides whether a folder can be chosen
(`provider.canChooseWorkspace && !selection`) and the feature only receives a
callback or `undefined`.

### Accessibility behavior

The empty state is a real `<button>` in the tab order, which the icon-only
header action was too — the change is discoverability, not keyboard access.

### Validation performed

Live in the browser, measured from the DOM rather than by eye:

- Stored `panelHeight` 565 in an 860px-tall window: panel rendered 565, main
  256 — above the 170 floor, so correctly not clamped.
- Same state at 600px tall: panel rendered 395 (container minus the floor),
  main 166. Before this change main would have been 0.
- Back at 1000px tall: panel returned to its stored 565, main 396. The
  preference was never overwritten — `localStorage` still reads 565 throughout.
- `npx tsc --noEmit` and `npm run check` clean.

### Not validated

The "Open Folder" empty state has not been seen. It only renders when a folder
can be chosen and none is open, which is native-only — the browser fixture is
always "selected". The native window in this session already had a workspace
restored, so the state never appeared. Its layout, wrapping, and the picker it
opens are compile-verified only.

### Caveats and deviations

- With both sidebars open each is capped independently, so together they can
  still push main below the floor on a very narrow window. Fixing that properly
  needs the layout to arbitrate between regions rather than clamp each one.
- `MIN` in `WorkbenchLayout.tsx` and `--ide-region-min` in `tokens.css` are the
  same number written twice. The token cannot be read from JS without a
  `getComputedStyle` call at drag time, which is worse.

## Slice 10b: Blocked commands stay in the palette (follow-up)

Not a slice. `File: Open Folder` already existed; it was disappearing.

### User outcome

`Ctrl+Shift+P` → `File: Open Folder` is now always present in the native app.
While an editor has unsaved changes it appears greyed with "Save your changes
first" instead of silently vanishing from the list.

### Added

- `Command.disabled?: string` — the reason a command cannot run right now.
- `WorkbenchActions.openFolderDisabled`.
- `CommandCenter` renders a disabled row muted with `aria-disabled`, shows the
  reason in the detail column, and refuses to run it.
- `src/commands/commandRegistry.check.ts`, wired into `npm run check`.

### The distinction being drawn

Absent capability and blocked capability are not the same thing and must not
render the same way:

- Browser mode has no folder to open at all, so the entry stays omitted. An
  entry that can never run is noise.
- Native mode with unsaved work can open a folder, just not yet. Hiding it
  there is indistinguishable from the feature not existing — which is exactly
  how it was reported.

`openFolder` also now refuses when dirty on its own. Switching roots discards
every editor, so the guard belongs on the operation, not only on the controls
that offer it: `IconButton` was already `disabled`, but that is presentation.

### UI extracted/reused

None. `.ide-quickpick-row-disabled` is feature CSS with one consumer.

### Accessibility behavior

Blocked rows stay selectable and keep `aria-selected`, so arrow-key navigation
reaches them and a screen reader reads both the label and the reason. Enter on
one does nothing and leaves the palette open — closing it would look like the
command had run. `aria-disabled` rather than removal from the list is the point
of the change.

### Validation performed

- Live in the browser: `Ctrl+Shift+P` opens the palette with 8 commands and no
  `File: Open Folder` entry — correct, the capability is absent there.
- `commandRegistry.check.ts`: absent capability omits the entry; present and
  unblocked is runnable and actually invokes the callback; present and blocked
  carries the reason; a reason without a capability does not conjure an entry;
  ids are unique.
- `npx tsc --noEmit` and `npm run check` (4 checks) clean.

### Not validated

The disabled row has never been rendered. It requires native mode plus an
unsaved editor, and the browser cannot produce it. Its colour, the reason text
in the detail column, and the Enter-does-nothing behaviour are covered by the
self-check at the data level only — nothing has looked at the pixels.

### Caveats and deviations

- `disabled` is a plain string, not a predicate. Commands are rebuilt on every
  relevant state change, so a stale reason is not possible today.
- Only Open Folder uses it. Save and Close Active Editor are still runnable
  no-ops when no editor is open, rather than reporting why.

## Slice 10c: Opening a real folder in the browser (deviation)

Not a slice, and a deliberate departure from the guide. Requested explicitly by
the user, restated after the guide's position was presented.

### The deviation, stated plainly

Slice 4's goal is to reach a real workspace *without granting broad filesystem
access to the frontend*, and §12 assigns folder opening to native mode only,
with the rule that browser fallbacks need not pretend to provide capability
they cannot safely emulate. This change gives the frontend real filesystem
handles via the File System Access API, which is the thing that goal excludes.

The consequence, accepted knowingly: every rule `workspace.rs` enforces now has
a second implementation in untrusted code. Depth cap, ignored directories, the
2 MiB limit, UTF-8 only, and rejecting `..` in an id are all re-stated in
`workspace.ts`, and nothing but review keeps the two copies in agreement.

### User outcome

In a Chromium browser, `File: Open Folder` is in the palette and the folder
button is in the Explorer header. Choosing a folder replaces the fixture with
the real tree; opening, editing, saving, and searching all work against disk.

### Added

- `fileSystemAccessProvider()` in `src/workspace.ts`, selected when there is no
  Tauri and `showDirectoryPicker` exists. Firefox and Safari still get the
  fixture.
- `WorkspaceProvider.defaultWorkspace` — a workspace that exists without being
  chosen.

### Why `defaultWorkspace` exists

The controller used `canChooseWorkspace === false` to mean "the fixture is
already selected". Those are now independent: the browser can both choose a
folder and have one by default. Conflating them made the fixture disappear the
moment the picker became available. The provider states each separately, and
until a folder is chosen the browser provider delegates every call to the
fixture, so the deterministic boot state the guide relies on is intact.

### Security boundary

Re-implemented, not shared:

- Ids are split and every segment checked; `''`, `.` and `..` are rejected
  before any handle lookup.
- Files are decoded with `TextDecoder('utf-8', { fatal: true })`, so a binary
  file fails loudly instead of arriving as replacement characters and being
  written back over the original.
- 2 MiB is enforced on read and on write.
- `handleAt` never passes `create: true`, so saving can overwrite but never
  bring a new path into existence — matching `write_file`.
- The picker is opened with `mode: 'readwrite'` once, rather than escalating
  during a save.
- A handle exposes no real path and none is invented: `label` is all the UI
  shows and all that is persisted.

### Validation performed

Live in the browser, read from the DOM:

- Palette now lists `File: Open Folder` first; the header folder button
  renders; the fixture tree (`src`, `README.md`) still boots.
- `npx tsc --noEmit`, `npm run check` (4 checks) and `npm run build` clean.

### Not validated

Nothing past the picker. Choosing a real folder needs a user gesture and an OS
dialog, which cannot be driven from here, so the entire post-selection path is
unexercised: the recursive walk, ignored directories, the depth cap, reading,
the UTF-8 rejection, saving through `createWritable`, and search over real
files. Every one of those is first-run code.

### Caveats and deviations

- A chosen folder does not survive a reload. Re-granting a handle needs it
  stored in IndexedDB *and* a user gesture, so `restoreWorkspace` throws and
  the controller falls back to the fixture rather than pretending.
- Changes and Terminal stay on their fixtures in the browser regardless of the
  folder chosen. There is no git and no PTY in a page, and the guide's rule
  against faking native capability still holds for those.
- The policy constants are duplicated between `workspace.rs` and
  `workspace.ts` with only a comment tying them together.

## Slice 11: Agent Chat

**User outcome.** Agent Chat is now the workbench's primary mode and owns the
main region on boot. A prompt is sent with Enter (Shift+Enter for a newline),
the reply streams in, tool activity appears as compact secondary rows, and the
run stops at an approval request that does nothing until Continue or Skip is
answered. Stop cancels a run at any point. Opening a file or a diff brings the
editor forward; the titlebar and two commands switch between the two.

**Added.** `src/agent.ts` — the `AgentProvider` / `AgentRun` / `AgentEvent`
seam plus the deterministic provider. `src/agent.check.ts` — the runnable
check. `src/features/agent/AgentChat.tsx` — transcript, composer, approval, and
the plain-text transcript dialog. Agent CSS in `App.css`.

**UI extracted/reused.** Nothing new was extracted. `Overlay` carries the
plain-text transcript dialog, `Icon` the activity rows, `ActionBar` +
`IconButton` the mode switch, and `.ide-button` the composer and approval
controls. That is now a fifth hand-written `.ide-button` consumer; the
extraction question raised in Slice 10 is still open and still unanswered.

**Adapters and dependencies.** One new adapter, `AgentProvider`. It has a
single deterministic implementation and no mode branch: there is no native
agent to fall back from, so `createAgentProvider()` returns the same object in
both modes. No new dependency. Persistence is untouched — no schema change.

**Security boundary.** None crossed. The provider reaches no network, no
filesystem, and no Tauri command; the approval flow is the mechanism that will
gate real tool calls later, and proving it now is the point of the slice.

**Accessibility behavior.** The transcript is `role="log"` with
`aria-live="polite"`, as the guide specifies. Approvals are a labelled `group`.
Every control has a descriptive name. Ending a run — completed or cancelled —
returns focus to the prompt. Approval required, approved, skipped, finished and
stopped are announced through the workbench live region; announcements carry a
sequence number so that two identical messages are still two announcements
rather than one silent no-op. The plain-text transcript dialog goes through
`Overlay`, which already has the focus trap and focus restoration the guide's
Slice 11 caveat asks for, so that caveat does not apply here. Agent-specific
rows were added to the keyboard help.

**Validation performed.** `npx tsc --noEmit`, `npm run check` (5 checks
including the new one), and `npm run build` all clean. Driven live in the
browser at :5190 through the DOM: a full approved run (streamed text
reassembles byte-for-byte, two activity rows, approval group, Continue →
`Approved` + the apply activity appearing only afterwards + completion text +
`Agent finished` + focus back on the prompt); a cancelled run (transcript
frozen after Stop, `Stopped.`, `Agent stopped`, Send restored); the transcript
dialog (opens with focus inside, contains tool/approval/cancelled markers,
Escape closes); the mode switch (agent stays mounted with both turns intact
while hidden); opening a file bringing the editor forward; both new palette
entries present. No console errors.

**Not validated.** Nothing was exercised in the native window — as with every
slice since 9, the running Tauri webview cannot be inspected from here. No
screen reader was run, so the announcement and `role="log"` behavior is
verified structurally, not audibly. The skip path was checked only in
`agent.check.ts`, not through the UI.

**Caveats and deviations.** No deviation from the guide's Slice 11 contract.
One judgment call worth recording: the guide's caveat says the provider "uses
animation frames", and the first implementation did so exclusively. Measured in
a hidden tab, that produced zero frames in 500 ms and the run stalled
mid-stream — which contradicts the guide's own design decision that provider
lifecycle is independent from rendering. Pacing now uses animation frames when
the document is visible and a timer when it is not, so a run in a background
window continues (slowly, under the browser's background throttling) instead of
freezing. Streaming into a `role="log"` region word by word is noisy for a
screen reader; the guide specifies it, so it stands, and the plain-text
transcript is the intended mitigation. Conversations and the selected mode are
deliberately not persisted, per the guide's caveats.

## Slice 11a: Guide alignment audit (follow-up)

**User outcome.** No visible change except that a disabled `.ide-button` now
looks disabled everywhere, not only in the agent composer.

**Added.** Nothing. One CSS rule moved from feature scope to global scope.

**UI extracted/reused.** Nothing extracted — and that is the audited answer,
not an omission. All ten primitives in guide §7 exist and are exported from
`src/ui/index.ts`, and every one has a real consumer. The `Button` and
`ConfirmDialog` extraction question left open since Slice 10 is now closed
against guide §7.2: both fail "the API hides meaningful implementation
complexity", `Button` matches the explicit "do not add when it only shortens a
small JSX fragment", and `ConfirmDialog` matches "the second use case is
hypothetical" with `ConfirmDiscard` still its only consumer. Neither appears in
the §7 table. The correct shape for a shared button is the shared `.ide-button`
class it already has.

**Adapters and dependencies.** Unchanged. Guide §12 lists Agent as
"Deterministic event stream" in browser and "Future Agent Host/Copilot adapter"
in native, so Slice 11 shipping one deterministic provider with no mode branch
is the specified state, not a shortcut.

**Security boundary.** Untouched.

**Accessibility behavior.** Improved: a disabled button outside the agent
composer previously rendered identically to an enabled one, conveying the
disabled state through the DOM only. `.ide-button:disabled` is now global,
matching `.ide-icon-button:disabled`, per guide §8 "the same semantic role uses
the same token, control, and interaction".

**Validation performed.** `tsc`, `npm run check` (5), `npm run build` clean.
Computed style read live from the disabled Send button: `#6e6e6e`
(`--ide-fg-subtle`) with `cursor: default`, confirming the global rule binds.
Primitive consumers enumerated from source.

**Not validated.** Nothing new in the native window.

**Caveats and deviations.** None. Two small divergences from the §7 table's
"proven consumers" column are worth noting but are not defects: `ContextMenu`
is listed for "Explorer/Changes workflows" but only Changes uses it, and
`ResizableSeparator` has a single consumer now that Slice 10 moved all sash
ownership into `WorkbenchLayout`. Both are guide-sanctioned primitives, so
neither is a candidate for removal.

## Slice 12: Centered File and Diff Editor Modal

**User outcome.** Agent Chat is now the only occupant of the main region. Files
and diffs open in a centered dialog over the workbench, with the agent visible
beneath a subdued backdrop. Escape or the close button dismisses it; tabs and
unsaved edits survive dismissal, and the titlebar control or `View: Show
Editor` brings them back. The Slice 11 Agent/Editor mode switch is gone —
replaced, as the guide intends.

**Added.** `src/editor/EditorDialog.tsx` — the extracted dialog the guide names.
`src/editor/EditorHandle.ts` — the imperative surface an editor exposes to its
container. `src/editor/focusEditor.ts` — the shared focus-retry used by both
Monaco wrappers. Editor-dialog CSS; `.ide-main-stack` CSS deleted.

**UI extracted/reused.** `EditorDialog` composes `Overlay` + the existing
`EditorWorkbench` rather than reimplementing an editor, so source, diff, tabs
and dirty tracking are unchanged. `Overlay` gained the guide's "improved
dialog focus behavior": explicit `role="dialog"` and `aria-modal="true"` for
every overlay, and an effect that is now safe to run twice. Still ten
primitives; nothing new entered `src/ui`.

**Adapters and dependencies.** None added or changed. No new dependency.

**Security boundary.** Untouched.

**Accessibility behavior.** Against the guide's contract: `role="dialog"` and
`aria-modal="true"` are now explicit (previously only implied by `<dialog>` +
`showModal()`); the title is connected by `aria-labelledby`; focus enters on
open and lands in Monaco rather than on the tab strip; focus cannot reach the
workbench behind the modal; Escape closes; focus returns to the Explorer or
Changes row that opened it. Focus is never left nowhere — the overlay always
places it inside the dialog first, and the editor upgrades it from there.

**Validation performed.** `tsc`, `npm run check` (5), `npm run build` clean.
Driven live in the browser through the DOM: boot lands on Agent with no dialog
and a disabled Show-editor control; opening `README.md` from the Explorer gives
a dialog titled `README.md` with `role`/`aria-modal`/`aria-labelledby` correct,
sized 1100x760, agent still mounted beneath; focus verified to land on
`.native-edit-context` inside `.monaco-editor` (ancestry checked explicitly,
not inferred); Escape dismisses and returns focus to the exact opener row;
reopening from the titlebar restores the same tabs; diffs open with focus on
the modified side, confirmed 9/9 across repeated trials including the
deleted-file case; focus containment confirmed by failing to focus the agent's
prompt behind the modal; persisted state contains no modal field.

**Not validated.** Typing into Monaco, and therefore dirty-state-survives-
dismissal end to end. Monaco renders no view lines and accepts no synthetic
text input in this environment, so unsaved content surviving dismissal is
verified structurally — `EditorDialog` holds no content state and the inputs
live in the controller — but not by editing a file. Nothing was exercised in
the native window. No screen reader was run.

**Caveats and deviations.** No deviation from the guide's Slice 12 contract.
Backdrop-click dismissal was deliberately not added, per the guide's caveat.

One honest note on `focusEditor`. Monaco does not reliably accept focus at the
moment the dialog opens: its real input is built during layout, and it was
measured absent at the instant the overlay resolves focus. The retry is bounded
(8 attempts, 16ms apart) and stops early once focus is inside the editor or
once anything else has claimed it. The retry budget is empirical, and the
environment available for testing works against measuring it well — the browser
pane never composites, so it serves no animation frames and Chrome throttles
its timers to roughly one second, which stretches a ~128ms sequence into
several seconds and makes timing observations there unrepresentative. Several
apparent failures during this slice turned out to be that, not the code. The
degraded case is safe rather than broken: focus stays on the dialog's close
button, inside the modal. This is the first thing to re-check on a real
window.

## Slice 12a: The closed editor dialog was still in the layout (follow-up)

**User outcome.** Fixes a regression introduced by Slice 12 and reported from a
screenshot: the workbench was crushed into a ~240px strip at the top of the
window, and the editor, when open, sat off-centre instead of over the middle.

**Added.** Nothing. Two CSS declarations removed, one selector narrowed.

**What was wrong.** `.ide-overlay-editor` set `display: flex` unconditionally.
An author rule outranks the UA rule that hides a closed `<dialog>`, so the
dialog stayed in the workbench's flex column at its full 760px height whether
or not it was open — permanently stealing that space from every region above
it. Measured with the dialog closed: `.ide-body` was 205px inside a 1000px
workbench, and the closed dialog reported `display: flex; height: 760`. The
same rule also set `position: relative`, overriding the `position: fixed` with
auto margins that the UA gives an open modal — which is what centres it — and
dropping the dialog back into normal flow. `display: flex` now applies only to
`[open]`, and no `position` is set at all; the close button still anchors
correctly because a fixed element is a containing block for absolute children.

**UI extracted/reused.** Nothing.

**Adapters and dependencies.** Unchanged.

**Security boundary.** Untouched.

**Accessibility behavior.** Unchanged in intent, restored in practice: an
off-centre dialog overlapping a crushed workbench is a usability defect for
everyone, and the modal now covers the workbench as designed.

**Validation performed.** `tsc`, `npm run check` (5), `npm run build` clean.
Measured from the live DOM. Closed: the dialog computes `display: none`,
`.ide-body` is 965px in a 1000px workbench, main 723px, panel 238px matching
the persisted value. Open at 1400x1000: `position: fixed`, 1100x760 at
(150,120) — centred exactly on both axes — with `.ide-body` still 965px, so the
open modal no longer displaces anything. At the Tauri minimum window (900x560),
per the guide's caveat: 828x482, fully on-screen both axes, no horizontal page
scroll, 400px left for the editor itself.

**Caveats and deviations.** None. Worth recording how this was missed: every
Slice 12 check queried the DOM for open dialogs, focus, roles and tab state,
and all of that was correct — nothing in that set would notice that the region
*behind* the modal had been squashed. It took a screenshot to see it. Layout
regressions need a geometry assertion, not a semantics one.

## Slice 12b: Native verification pass

**User outcome.** Opening a file no longer destroys and rebuilds the editor, so
Monaco instances, models and undo history survive. Focus reaches the editor
reliably for files. One defect remains open and is described below.

**Added.** Nothing shipped. A native inspection capability was established:
launching with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
exposes the Tauri WebView2 over the DevTools protocol, so the real window can be
driven and measured the same way the browser pane was. Everything since Slice 9
had been unverified natively; that gap is now closed for most of the app.

**What the native window proved that the browser could not.** It serves real
frames (32 in 500ms, against 0 in the hidden browser pane), so Monaco actually
lays out and paints. Every timing conclusion drawn in Slice 12 was therefore
drawn in an environment that could not exercise this code, and one of them was
wrong.

**Fixed — editor destroyed on every new file open.** `openFile` set
`activeEditorId` before awaiting the read, so for one render the active id named
an input that did not exist yet. `EditorWorkbench` then rendered no editor at
all, unmounting Monaco and remounting it once the content arrived — discarding
the instance, its models, and any focus placed in it. `openDiff` had the same
ordering. Both now select the id only after the input is in state. This was a
real product bug independent of focus.

**Fixed — focus placed once, then lost.** `focusEditor` stopped at the first
successful `focus()`. Measured in the real window, focus lands in Monaco and is
torn out again when Monaco rebuilds its input for a newly opened model, up to
400ms later. It now watches for a short window, re-focusing only while focus is
unclaimed, and falls back to the input element when `focus()` goes quiet during
a rebuild. `EditorDialog` also focuses from a callback ref, which runs exactly
when an editor instance attaches.

**Verified natively.** Rust layer, first time ever: `set_workspace`
canonicalises to a verbatim path; `list_tree` returns 106 entries with zero
`node_modules`/`.git`/`target`/`dist` leakage; `search_workspace` returns real
hits with correct line numbers; `read_file` works. Security boundary: five
escape attempts (`../`, `src/../../`, absolute Windows, backslash traversal,
`/etc/passwd`) were all refused. Git, first time ever: write, detected as
modified, `git_diff` showing real HEAD content, stage, unstage, revert, back to
zero changes — with the scratch line gone and the tree clean. Layout: body 765
of 800 with the dialog closed (`display: none`), dialog centred exactly at
(90,56) 1100x688 when open, body undisplaced. Workspace restore repopulates the
Explorer and pane title. Escape returns focus to the opener 6/6.

**Open defect — editor focus with diffs.** Opening a diff does not put focus in
the modified editor, and after a diff has been shown the next file open fails to
focus as well: 1/6 in an interleaved source/diff run, against 4/5 when only
files are opened. Focus lands on `body` inside the open modal, so the dialog is
still keyboard-reachable by tabbing, but this does not meet the guide's Slice 12
contract ("initial focus into Monaco"). Cause not established. Not a regression
from this pass — it was never working; the browser pane simply could not show
it.

**Known and accepted.** The very first editor opened after a page load does not
take focus in development. Confirmed by removing `StrictMode` and re-running:
the case then passes. React's development-only double-mount disposes and
recreates Monaco, and production builds do not do this. `StrictMode` was
restored; it stays.

**Validation performed.** `tsc`, `npm run check` (5), `npm run build` clean.
Everything above measured from the live native window over CDP. The working
tree is clean apart from the source changes in this entry — the verification
scratch line was reverted and `context.md` restored.

**Not validated.** Terminal PTY and agent chat were not reached natively.
Typing into Monaco still untested. No screen reader.

**Caveats.** `git_revert` restores through git's filters, so with
`core.autocrlf=true` a reverted file can come back with different line endings
than it had on disk. That is git's own behaviour, not ours, and git reports the
tree clean either way.

---

## Slice 12c: Editor focus, closed

**User outcome.** Opening a file or a diff puts the cursor in the editor, every
time, including diffs and including the first open after a page load — the two
cases that were logged as broken and as accepted-broken at the end of Slice 12b.

**Cause.** Both were the same thing, and it was not a Monaco problem. Focus is
requested from a callback ref in `EditorDialog`, which React runs in the layout
phase; Monaco is created in a passive effect, which runs afterwards. So when the
request arrived the editor did not exist yet, and `focus()` hit an early
`return` and gave up. That call had never once done anything.

It only showed as a defect where something forced a remount. Opening a file
after a diff swaps `MonacoEditor` for `MonacoDiffEditor`, which is a fresh
mount, and React's development double-invoke then disposes and recreates Monaco
underneath the effect that had already focused it. Files-only never remounts —
it swaps the model on a live editor — which is exactly why files-only scored 4/5
while interleaving files and diffs scored 1/6.

**Established by measurement, not reading.** Interleaved probe with `StrictMode`
as committed: 0/6, diffs 0/3. Same probe with `StrictMode` commented out: 6/6,
diffs 3/3. That isolated the double-mount as the entire cause in about two
minutes, after three sessions of reasoning about Monaco internals had not.

**Changed.** `focusEditor` now takes the editor as a getter rather than a value.
A caller with no editor yet can still ask for focus, and the request waits for
one to appear instead of being dropped — the retry loop it already had covers
the gap. `MonacoEditor` and `MonacoDiffEditor` lost their early returns and pass
`() => editorRef.current` and `() => editorRef.current?.getModifiedEditor()`.

**Added.** `src/editor/focusEditor.check.ts`, wired into `npm run check` (now 6).
It stubs `document` and drives a fake editor that does not exist for the first
150ms. It asserts the four properties that matter and are otherwise only
observable natively: a not-yet-existing editor is waited for; focus destroyed by
a rebuild is taken back; focus the *user* moved is never taken back; and the
watch is bounded, so it does not tick forever behind a dialog nobody reopened.

**UI extracted / reused.** None. `Overlay`, `EditorWorkbench` and `EditorDialog`
are untouched.

**Adapters and dependencies.** None added.

**Security boundary.** Unchanged; no Rust command touched.

**Accessibility behavior.** This *is* the accessibility fix. The Slice 12
contract, "initial focus into Monaco", now holds for source and diff alike.
Escape still returns focus to the opener, 6/6.

**Validation performed.** `tsc`, `npm run check` (6), `npm run build` clean.
Interleaved source/diff probe in the native Tauri window with `StrictMode` on
and the fix applied: focus in Monaco 6/6, focus on the modified side of the diff
3/3, focus restored to the opener 6/6. `StrictMode` was restored and the probe's
scratch edits reverted; the tree is clean apart from this entry's changes.

**Not validated.** Still no typing into Monaco, no screen reader, and no
terminal or agent chat natively — see `docs/OPEN-ISSUES.md`, from which both
focus items have now been deleted.

**Caveats and deviations.** None. Nothing in the guide changed; this brings the
implementation up to what Slice 12 already specified.

---

## Slice 11b: Cancelled approvals, closed (follow-up)

**User outcome.** Pressing Stop while the agent is waiting for approval now ends
the question. Continue and Skip disappear and the approval reads "Not answered";
it is no longer possible to approve a run that is not running. Answering an
approval affects only the run that asked, and never reaches back into an earlier
one.

**Cause.** Two defects in `AgentChat.tsx`, found by a two-axis review of the
whole implementation rather than by using the app.

`applyEvent` handled `cancelled` by setting `status` and nothing else, so a
pending approval stayed pending, kept its live buttons, and would announce
"Approved. Continuing." into the live region for a dead run.

`resolve` then mapped over **every** turn and flipped anything still pending. So
answering a fresh approval also silently answered a stale one abandoned by an
earlier Stop — the transcript rewrote history the user had already read.

**Correction to the Slice 11 entry above.** That entry states the transcript is
frozen after Stop. It was not, and had never been. This log is append-only, so
the original line stands as written; this paragraph is the correction. The claim
was made from reading the provider's state machine, which does stop cleanly —
what was never checked was the component's reduction of its events.

**Added.** `src/features/agent/transcript.ts`: the transcript reduction as pure
functions, out of the JSX. `applyEvent` and `asPlainText` moved unchanged;
`resolveApproval` and `canAnswer` are new and hold the rules that were wrong;
`approvalLabel` derives how an approval reads from the status of the turn that
owns it. `transcript.check.ts` covers all of it.

**UI extracted and reused.** None. `AgentChat.tsx` lost 60 lines and gained no
component.

**Adapters and dependencies.** None. `agent.ts` is untouched — the provider's
state machine was always correct, and both defects were downstream of it.

**Security boundary.** Unchanged. Nothing here reaches Rust.

**Accessibility behavior.** Three changes, two of them beyond the reported
defect and taken because the rule is that accessibility is part of the work.
The approval group's `aria-label` now carries its own outcome, so navigating
group to group says which questions are still open without reading into each.
Answering now returns focus to the composer: the clicked button was being
replaced by static text, dropping focus to `body` for the remainder of the run,
which with a real model could be a long time. And the label a screen reader
reads is the same string the plain-text transcript uses, from one function.

**Validation performed.** `tsc --noEmit` clean; `npm run check` 7/7 including
the new one; `npm run build` clean apart from the pre-existing chunk-size
warning; `cargo test` 3/3. The new check was mutation-tested: dropping the run
status from `canAnswer`, dropping the status guard from `resolveApproval`,
scoping it to the last turn instead of the running one — each reintroduces a
defect and each is caught.

**What was not validated.** Nothing was run in the native window, and Slice 11
still has never been. No screen reader has heard any of the above. In
particular, cancelling with an approval pending now changes text inside a
`role="log"` region at the same moment `onAnnounce` says "Agent stopped", and
the order those two reach a screen reader is unknown and was not investigated —
guessing at announcement ordering without hearing it is how the claim being
corrected in this entry got made in the first place.

**Caveats and deviations.** None from the guide. One judgement call worth
recording: an approval abandoned by Stop keeps `state: 'pending'` rather than
gaining a fourth state, because whether a question is still open is a fact about
the run, not about the question. `approvalLabel` derives it. A stored fourth
state would have to be kept in step with `Turn.status` forever, and the first
time it drifted the transcript would claim something that never happened.

---

## Slice 12d: The first three review defects, closed

**User outcome.** Three things that would have bitten a real user. A workspace
that is temporarily unreachable — a disconnected drive, a folder renamed and
renamed back — is no longer forgotten permanently one launch later. A file
opened from a search result can be edited anywhere in it, instead of having the
cursor yanked back to the result line on every keypress. And pressing or
double-clicking the titlebar under `npm run dev` no longer throws.

**Cause.** All three come from the two-axis review recorded in
`docs/OPEN-ISSUES.md`; all three were found by reading, none by using the app.

The save effect in `WorkbenchController` had no guard and ran synchronously on
mount, when `selection` is undefined and `inputs` is empty, while the restore
that fills them in is async. The session survived that — `restored` is a
synchronous `useMemo` — but the copy on disk did not: if `restoreWorkspace`
rejected, the record had already been overwritten with emptiness.

`MonacoEditor`'s model-swap effect was keyed `[id, content, revealLine]` and
ended by revealing. `content` changes on every character typed.

`useWindowControls` shipped no browser branch at all, against the rule that
every native capability has one. `available` gates the button row, but
`Titlebar` wires the drag region unconditionally.

**Added.** Nothing, in the sense of no new module. Three edits: two pieces of
state in `WorkbenchController` (`hydrated`, gating the save effect, and
`unrestored`, holding the record of a root that could not be restored), the
reveal split into its own effect that serves each file-and-line request once,
and a `nativeWindow` helper that no-ops off Tauri and swallows a native
rejection rather than leaving it unhandled in a pointer handler.

`unrestored` is the part that is more than a guard, and it is there because the
guard alone was wrong twice over. Simply not saving until a successful restore
kept the record safe but latched the session off for good: a folder chosen
afterwards through Open Folder was never persisted either. And in the browser
`restoreWorkspace` *always* throws by design — a directory handle cannot be
rebuilt from a name — so "don't save after a failed restore" would have meant
`npm run dev` never persisting anything at all. Holding the old record and
writing it back verbatim until a root is restored or chosen keeps both the
session and the record honest.

**UI extracted and reused.** None.

**Adapters and dependencies.** None. `nativeWindow` is the browser branch the
window seam was missing, kept in the same file as the native one, since a hook
that resolves to nothing needs no adapter module.

**Security boundary.** Unchanged. Nothing here reaches Rust.

**Accessibility behavior.** Unchanged.

**Validation performed.** `npm run build` clean apart from the pre-existing
chunk-size warning; `npm run check` 7/7; `cargo test` 3/3; `tsc --noEmit` clean.

A two-axis review was run on the change before it was committed, and it earned
its keep: the first version of all three fixes shipped the two defects described
above plus a third — the reveal effect keyed only on `[id, revealLine]` re-fired
on every tab switch, overriding the view state the model swap had just restored,
so a file opened from a search would have lost its cursor and scroll every time
it was switched back to. Consuming the request once fixes it. That defect is
strictly worse than the one being fixed, and it was found by reading, not by
running — which is the same way the originals were found, and the same way they
will keep being found until this surface is actually exercised.

**What was not validated.** Everything that matters, for the same reason each
time: none of these three surfaces has ever been observed. Typing into Monaco
still has not happened, so the reveal fix is as unobserved as the defect was.
The restore-failure path needs a workspace that goes away between launches and
was not staged — note that the browser provider takes that path on every launch
by design, so `npm run dev` exercises the fallback but never the native "drive
came back" case. The drag region has never been pressed under `npm run dev`.

**Judgement calls worth recording.** The reveal is served once per file and
line and never again, so clicking the same search result twice, after scrolling
away, does nothing the second time. Making that work needs the reveal to be a
request with identity rather than a number, and threading a "consumed" callback
back to the controller. Worth doing when someone actually hits it.

A held `unrestored` record keeps the *old* editor list, including its unsaved
text, rather than merging in anything from the current session. There is nothing
to merge: the session has no root those ids mean anything in.

**Caveats and deviations.** None.

---

## Slice 12e: The next three review defects, closed

**User outcome.** A diff of a file the workspace refuses to read now says so,
instead of drawing every line as deleted. The folder the app opens is the folder
the user picked in an OS dialog, and nothing the page can say changes that. And
the page no longer gets a global Tauri object it never used.

**Cause.** All three from the same two-axis review, none observed failing.

`git_diff` built its working-tree side as `resolve(...).ok().and_then(read).ok()
.unwrap_or_default()`. Confinement refusal, over the size cap, and not-UTF-8 all
collapsed into an empty string, and an empty side renders as a whole-file
deletion — a plausible answer to a question that was denied.

`set_workspace` accepted any absolute path from the renderer and canonicalised
it into the root, and the frontend fed it a path out of `localStorage` on every
launch. `resolve` was never the weak part; the root it confines *to* was. A
tampered `ade.workbench` made `C:\` the workspace and every subsequent check
obligingly confined to that.

`withGlobalTauri: true` exposed `window.__TAURI__` to all page script. Nothing
in the repo referenced it — detection uses `__TAURI_INTERNALS__` — so it was
surface granted for nothing, and undeclared besides.

**Added.** `working_tree_side` in `git.rs`, which classifies the one absence
that legitimately reads as empty (the file is not there — a deleted file) and
propagates every other refusal. In `workspace.rs`: `adopt`, now the only place a
root is ever set; `record`/`remember`, the file under `app_config_dir` where the
chosen root is written down; and two commands, `choose_workspace` (opens the OS
dialog *in Rust* and records the answer) and `restore_workspace` (no arguments —
it reads that record back).

`set_workspace` survives as a debug-build affordance and refuses in release. It
is how the app is driven over the WebView2 debugging port without an OS dialog,
which is the only way anything here has ever been observed, so removing it would
have cost more than it bought. It records the root like a real choice does, so a
probe still survives a reload.

**UI extracted and reused.** None. No component changed.

**Adapters and dependencies.** `WorkspaceProvider.restoreWorkspace` lost its
`path` parameter — the interface change *is* the fix, since a seam that takes a
root from the caller cannot be made safe by its implementation. The Tauri
provider no longer imports `@tauri-apps/plugin-dialog`; that npm dependency and
the `dialog:allow-open` capability are both gone, because the renderer no longer
opens dialogs. The Rust plugin stays — it is what `choose_workspace` uses.

**Security boundary.** This is the slice. Before it, two commands took a
directory from the renderer, and reviewing the change turned up the second one:
`set_workspace` took a root, and `terminal_create` took a `cwd` it spawned
PowerShell in. Page script could name any directory on the machine for either.
Both are gone — `terminal_create` now reads the root from Rust's own state, and
`set_workspace` survives only as a debug affordance that refuses in release. The
untrusted side can no longer name a directory at all, only a relative id inside
a root it did not choose. `git_diff` no longer converts a refusal into content,
and `WorkbenchController` no longer drops the resulting error on the floor: a
refused file or diff is announced instead of quietly doing nothing.

The `cwd` parameter was dead surface once Rust stopped needing it, so it came
out of the terminal adapter, `TerminalPanel` and `TerminalInstance` as well.

**Accessibility behavior.** Unchanged.

**Validation performed.** `npm run build` clean apart from the pre-existing
chunk-size warning; `npm run check` 7/7; `cargo test` 4/4, the new one covering
`working_tree_side` — present file, deleted file, escaping path, absolute path,
and a directory — without needing a git repository; `tsc --noEmit` clean.

A two-axis review ran before this was committed and found three things in the
first cut of it. `working_tree_side` keyed "the file is simply absent" on the
string `"not found"`, which `resolve` returned from *two* sites: the metadata
probe and the canonicalize below it. A file that existed but could not be
canonicalised — permission denied on a parent, say — therefore still collapsed
to an empty side, which is the exact defect being fixed. `resolve` now reports
that case differently. The review also caught `terminal_create` (above) and the
fact that a `git_diff` error had nowhere to go in the UI.

**What was not validated.** The whole of the workspace change, and this is the
uncomfortable part: `choose_workspace` calls `blocking_pick_folder`, which
parks its thread until the user answers, so it is put on the blocking pool
rather than left on an async worker. That is a reasoned choice, not a verified
one: no folder has ever been opened in this app, and a dialog that never returns
would look exactly like the app hanging. Nor
has `restore_workspace` — quit with a folder open, relaunch, get it back — been
walked natively. A release build has never been run, so `set_workspace`'s
refusal is untested in the configuration where it matters. `git_diff`'s new
error path is covered at the helper but the command itself still needs a repo
and a real refusal to see end to end.

**Caveats and deviations.** `withGlobalTauri` was an undeclared deviation and is
now simply gone rather than declared, which is the cheaper of the two fixes the
open-issues entry offered.

The dev port is declared here rather than fixed: this repo runs Vite on **5190**
where the guide's §13.5 says 1430, because 5180 belongs to the sibling
`agent-window-tauri` and the two are run side by side. `context.md` has said so
all along; the rule it was breaking is that a deviation must appear in this log,
and now it does. That closes the last of the seven review items, which is why
`docs/OPEN-ISSUES.md` no longer lists any open defect.

---

## Slice 12f: Running it, and the path that fell out

**User outcome.** The terminal opens where the user's folder is, and says so:
the prompt reads `PS C:\Users\...\tauri-ade-prototype>` where it used to read
`PS Microsoft.PowerShell.Core\FileSystem::\?\C:\Users\...`. The workspace path
the app shows and stores is an ordinary Windows path.

**Cause.** `fs::canonicalize` returns a verbatim path — `\?\C:\...`. Every
internal use was correct with it: `starts_with` confinement compares fine, and
`git -C` accepts one (both verified natively this session). But the root is also
handed outward — to the user as their workspace, and to `CommandBuilder::cwd`
as a shell's starting directory — and PowerShell reads a verbatim path as a
provider path rather than a location. This predates Slice 12e; moving the shell
cwd from the renderer to Rust did not introduce it, it only made it visible,
because nothing had ever opened a terminal in the native window before.

**Added.** `canonical` in `workspace.rs`, wrapping `fs::canonicalize` and
stripping the prefix, used by both `adopt` and `resolve`. Both, deliberately:
`resolve` confines by `starts_with(root)`, so a root in one shape and a resolved
file in the other makes every file in the workspace look like an escape. The
existing tests built their roots with raw `fs::canonicalize` and failed exactly
that way when only `resolve` was converted, which is the cheapest possible
demonstration of why the helper has one caller-facing form. Verbatim UNC is left
alone — its short form is a different rewrite and a network root is not worth
the risk. `canonical_leaves_no_verbatim_prefix` covers it.

**UI extracted and reused.** None.

**Adapters and dependencies.** None.

**Security boundary.** Unchanged in policy. Worth noting that the confinement
check now compares stripped paths on both sides rather than verbatim ones; the
comparison is the same comparison, and `resolve_confines_to_root` still passes
with the escape cases it always had.

**Accessibility behavior.** Unchanged.

**Validation performed.** This entry is mostly validation. `cargo test` 5/5,
`npm run check` 7/7, `npm run build` and `tsc --noEmit` clean — and then the
app was actually run, over the WebView2 debugging port, against this repo as its
workspace. What that showed is listed under "Verified in the native window" in
`docs/OPEN-ISSUES.md`; the short version is that Slice 6's PTY, Slice 12e's
`restore_workspace` and `git_diff` refusals, and Slice 12d's reveal fix all
work, and that `choose_workspace` does not block the app while its dialog is
open — the one risk that entry called out by name.

**What was not validated by this agent.** Typing into Monaco could not be
driven, for a documented reason: Monaco 0.53 takes text through the EditContext
API, so neither `Input.insertText` nor synthetic key events reach it, even
though the keydown events demonstrably arrive in the DOM and the mouse works
normally. Nor could a folder be picked from the dialog.

**Both were then done by hand, and both work.** A folder was chosen from the
real dialog — adopted, recorded, and returned as an ordinary Windows path, so
the fix above is confirmed on the path that produced the bug. And text was
typed into Monaco and saved with Ctrl+S, which had not happened since Slice 5.
That leaves *closing* a dirty editor — the confirm dialog, and Discard, which
throws the edit away — as the one editor path still never taken, and it is the
one whose failure loses work. No screen reader. Agent chat has still never run
natively.

**Caveats and deviations.** None. One correction to record: an earlier probe in
this session appeared to show `terminal_create` hanging the app, and it did not.
The probe had called `plugin:event|listen` with a hand-rolled payload, which
wedges the IPC — every later `invoke` then hangs while the renderer keeps
running, which is indistinguishable from the command under test deadlocking.
The PTY sequence was isolated in a standalone test and is fine. That hazard is
now written down in `docs/OPEN-ISSUES.md` so the next investigation does not
spend the same hour.
