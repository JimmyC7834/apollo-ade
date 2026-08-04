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

---

## Verification note: the editor paths are closed

Not a slice — no code changed. Recorded because the dev log is where this
project keeps what was actually observed, and because two of these could not be
reached by an agent at all.

Closing a dirty editor was checked by hand: the confirm dialog, and Discard in
particular, which is the only control in the app that destroys work. It works.
With that, together with the typing and saving confirmed just above, every
editor path in the implementation has now had a real run behind it — the first
time that has been true since Slice 5 introduced the editor.

What remains unverified is no longer about the editor: agent chat has never run
natively, no screen reader has heard any of it, and the browser File System
Access provider is still first-run code past the picker.

**One correction about this log itself.** The Slice 12f entry above was edited
after it had been committed, to fold in the by-hand results. The rule in
`context.md` is that this file is append-only and existing entries are never
rewritten, so that was a breach of it, and the right shape was a follow-up entry
like this one. Noted rather than reverted: rewriting history to hide a rewrite
of history would be the worse of the two.

---

## Slice 13 — The agent is real

**User outcome:** Agent Chat answers questions about the code in the open
workspace by actually reading files, instead of replaying a scripted run.

**Added**

- `src/agent/` replaces `src/agent.ts`. The `AgentEvent` contract goes from
  five kinds to eleven — `text`, `thinking`, `tool_start`/`tool_update`/
  `tool_end`, `approval`, `usage`, `compacted`, `error`, `complete`,
  `cancelled` — as settled in
  `docs/wayfinder/pi-harness/tickets/05-event-contract.md`.
- `@earendil-works/pi-agent-core` and `pi-ai`, both pinned to exactly 0.83.0,
  running in-process in the WebView with pi's `read` tool.
- `src-tauri/src/provider.rs`: the provider HTTPS call is made from Rust, so the
  API key never enters JavaScript, and `stat_path` in `workspace.rs` so `exists`
  does not have to read a whole file to answer.
- `src/agent/env.ts`: an `ExecutionEnv` over Rust, plus an in-memory one.
- `src/agent/canned.ts`: browser mode, using pi's own `fauxProvider`.

**UI extracted / reused**

Nothing extracted — the rule is two real consumers first, and there is one.
`PartView` was split out of `AgentChat`'s map because eleven kinds inline is
where a rule about who may answer a question stops being reviewable. Reused
`Icon` and `Overlay` unchanged.

**Adapters and dependencies**

`AgentProvider` is unchanged in shape, so `AgentChat` still knows nothing about
models or transports. Two `ExecutionEnv` implementations behind one interface.
Two new npm dependencies; `reqwest` and `futures-util` on the Rust side.

**Security boundary**

Rust remains the only filesystem authority: `stat_path` reuses the same
component scan `resolve` performs, reports symlinks without following them, and
grants no read. The renderer never learns the workspace's real path — the agent's
path namespace is root-relative, rooted at `/`. The API key is read in Rust from
`DEEPSEEK_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_API_KEY` and attached there;
`provider_stream` discards any auth header the renderer sends rather than merging
it. `write`, `edit` and `bash` are deliberately **not** wired: they are
destructive and belong behind the permission gate, which is a later slice.

**Accessibility behavior**

Tool calls and approvals are `role="group"` with a label carrying their own
outcome, so navigating group to group does not require reading into each one.
Reasoning is a `<details>`, collapsed. Errors are *not* `role="alert"` — the log
is already `aria-live="polite"` and interrupting it would talk over the answer.
The plain-text transcript covers every new kind, including usage and compaction.

**Validation performed**

`npm run build`, `npm run check` (7 checks; `transcript.check.ts` gained the
eleven-kind cases, `agent/events.check.ts` is new), `cargo test` (5).

Browser mode driven through the UI: prompt → tool card updating in place →
answer, with `198 in · 57 out · 522 context` rendered. Native mode driven over
the WebView2 debugging port against DeepSeek: 9 progressive render steps, a real
file read and summarised correctly, and separately a missing file producing a
`Failed` card reading `not found` that the model recovered from.

**Not validated:** no screen reader has heard any of it. `thinking` has never
rendered — DeepSeek is not a reasoning model, and the one provider that emits
reasoning (Gemini) was rate-limited before it could be checked in this UI.
`compacted` has never fired; no session has been long enough. `approval` renders
but is unreachable, since no gate is registered yet. Images are unsupported:
`read_file` refuses non-UTF-8, so pi's image path in the read tool cannot fire.

**Caveats and deviations from the guide**

- **`ExecutionEnv` is partial on purpose.** Twelve of its methods return
  `not_supported` rather than pretending — a silent empty `listDir` would read to
  the model as "the directory is empty" and send it somewhere wrong.
- **Model selection is two env vars**, `VITE_AGENT_PROVIDER` and
  `VITE_AGENT_MODEL`, with no UI and no persistence. Profiles own this and are a
  later slice; building a settings surface now would be built twice.
- **`globalThis.fetch` is patched**, scoped to three provider hostnames.
  Ticket 06 had named `ProviderStreams` as the credential seam; that is right for
  two of pi's three API shapes and impossible for the third, because the Google
  adapters reject an injected `fetch` and accept only the global. One mechanism
  covering every adapter beat one covering most plus a special case.
- **Model costs are zeroed rather than guessed.** A wrong cost table produces
  confident wrong numbers, which is worse than none.

---

## Slice 14 — The agent can change your code

**User outcome:** The agent writes and edits files in the workspace. By default
it just does it; with `VITE_AGENT_GATE=careful` it asks first, and either way the
working tree is snapshotted before every turn so an unwanted change is
recoverable.

**Added**

- `src/agent/gate.ts`: pi's `tool_call` hook, with an `auto` and a `careful`
  policy. Auto is the default and never prompts — **auto mode is the policy dial
  set to permissive, not the absence of a gate**, which is why both modes run the
  same mechanism.
- `write` and `edit` tools, plus `ExecutionEnv.writeFile` in both environments.
- `agent_write_file` in Rust: create-capable, unlike `write_file`, which routes
  through `resolve` and so can only overwrite files that already exist.
- `git_checkpoint` in Rust, run before every turn.
- `src/agent/gate.check.ts`.

**UI extracted / reused**

Nothing new. `PartView` renders the approval, which slice 13 built and could not
reach because nothing raised one.

**Adapters and dependencies**

No new dependencies. `AgentRun.resolveApproval` finally does something: it
settles the promise the hook is awaiting.

**Security boundary**

`agent_write_file` makes its own containment argument rather than inheriting
one: every path component must be `Normal`, the *parent* is canonicalised and
must still be inside the root, and an existing target that is a symlink or not a
regular file is refused. **This is the floor, and it holds regardless of what the
gate decided** — a renderer talked into writing outside the root still cannot.

`git_checkpoint` uses `stash create` + `stash store`, which builds a commit
object without touching the working tree, the index, or the branch. Its limits
are stated in the source and repeated here: it captures modifications to
*tracked* files only, so it does not recover an untracked file that was
overwritten, anything deleted outside the repository, a force push, or anything
already sent over the network.

**Not built, deliberately:** `bash`/`exec`, and the deny list of irreversible
commands. The deny list guards *commands*, so building it before the thing that
runs commands would be guarding nothing. They ship together or not at all.

**Accessibility behavior**

The approval is a `role="group"` labelled with its own outcome, so it reads as
answered/unanswered without entering it. Answering moves focus to the composer,
because the button that was clicked is about to be replaced by static text and
focus would otherwise fall to `body`.

**Validation performed**

`npm run build`, `npm run check` (9 checks), `cargo test` (5).

Driven natively over the WebView2 debugging port against `deepseek-reasoner`,
in a throwaway git workspace:

- **Auto passes reads, careful stops writes.** `read` ran unprompted; `edit`
  raised an approval with Continue/Skip.
- **Approving completes the edit** — verified on disk, not just in the
  transcript.
- **Declining does not abort the turn.** The tool card became `Failed` reading
  "The user declined this change.", the model saw the error result, re-read the
  file, and reported honestly that nothing had changed. This is the behaviour the
  gate ticket said is easiest to get wrong, and it is now exercised.
- **The checkpoint recovers clobbered work.** With uncommitted edits in the tree,
  the agent was told to overwrite a file; `git show 'stash@{0}:README.md'` returns
  the pre-agent contents verbatim.
- **`thinking` renders**, collapsed by default — see the caveat below.

**Not validated:** still no screen reader. `compacted` has never fired; no
session has run long enough. The `careful` policy has only been exercised on
`write` and `edit`, because those are the only mutating tools that exist.

> **Corrected later.** "No session has run long enough" was wrong, and being
> wrong in a comfortable direction hid it. `provider.ts` builds a new
> `AgentHarness` and a new `Session` inside `start()`, so **every turn is a
> fresh conversation** — there is no history to compact and never was.
> `compacted` is unreachable, not merely unexercised. Found while surveying
> what pi already ships; see
> [ticket 15](wayfinder/pi-harness/tickets/15-core-already-does-this.md).

**Caveats and deviations from the guide**

- **A checkpoint on a clean tree saves nothing, and that is correct.**
  `stash create` returns empty when there is nothing to stash — the recovery
  point is already HEAD. It only produces a stash when the user had uncommitted
  work, which is exactly the case where one is needed.
- **`model.reasoning: true` is not enough to get reasoning, and the failure is
  silent.** pi's harness defaults `thinkingLevel` to `"off"`, and for DeepSeek
  its adapter then sends `thinking: { type: "disabled" }`. The API returns no
  `reasoning_content`, no `thinking_delta` is emitted, and the transcript looks
  exactly like a non-reasoning model — with no error anywhere. Found by
  instrumenting the event stream after three rounds of guessing; `curl` proved
  the API was willing, so the suppression had to be ours. Fixed by setting
  `thinkingLevel` from `model.reasoning`.
- **Whether a model reasons is a regex on its id.** Wrong for the next reasoning
  model not named after one. The honest answer is a model catalog, and the map
  already records that pi's is stale enough for a new key to be unable to call
  what it advertises — so adopting it is its own piece of work.
- **Gate policy is an env var**, like model selection. It is a per-profile field
  in the design; profiles are a later slice.

---

## Slice 15 — The conversation remembers

**User outcome:** The agent remembers what you said in the previous turn.
"Now do the same to the other file" is a sentence it can act on. Stopping a run
also stops it, which turns out to be a different sentence than it used to be.

**What changed:** `src/agent/provider.ts` built a new `AgentHarness` and a new
`Session` inside `start()`, so every turn was a fresh conversation with no
memory of the last. The harness now lives for the life of the provider; what is
per-turn is the *subscription*, because each turn has its own `onEvent` to
deliver into. Both registrations — the event subscription and the `tool_call`
hook — are released when the turn settles.

`src/agent/rustFetch.ts` now honours the caller's `AbortSignal`.

**Validated natively** against `deepseek-reasoner`, driven over the WebView2
debugging port:

- **Memory.** Turn one: "remember 4477". Turn two: "what number?" → `4477`.
  Context tokens climb across turns (980 → 1020 → 1157), so history really is
  being sent rather than the model guessing.
- **No leak between turns.** The first turn's rendered text is byte-identical
  before and after the second turn runs. Asserted, not eyeballed.
- **Stop.** The cancelled turn freezes at zero further growth, renders
  `Stopped.`, and the *next* turn runs normally on the same session.
- **Tools still run** through the per-turn hook registration.

**Two defects this slice exposed rather than introduced.** Both were invisible
while the harness lasted one turn, and both are worth recording because neither
was found by reading the code.

- **`Stop` did nothing pi could see.** `AgentHarness.abort()` aborts its
  controller and then `await`s `waitForIdle()` *before* emitting `abort`. Our
  `fetch` shim ignored the `AbortSignal`, so the provider stream never ended,
  `waitForIdle` never resolved, and no `cancelled` event was ever produced. With
  a per-turn subscription that stopped being cosmetic: the turn was never
  released, and its listener then marked the *next* turn complete and wrote that
  turn's text into a dead transcript. Measured, not inferred — an instrumented
  run showed `abort` never settling and the composer re-enabling 502 ms after a
  click that had not stopped anything.
- **`abort` arrives after `agent_end`.** So releasing on `complete` — correct for
  every normal turn — swallowed it. Waiting for pi's `abort` event instead would
  simply invert the problem. Worse, the unwinding run emits a `message_end` whose
  usage is all zeros, so a stopped turn rendered as prose cut mid-word followed
  by `0 in · 0 out · 0 context` and no acknowledgement. `cancelled` is now
  synthesised at the moment Stop is pressed, which is also when a Stop button
  should respond.

**Caveats and deviations**

- **Rust keeps streaming after Stop.** The abort ends the request on the
  JavaScript side only; `provider_stream` has no cancellation, so the provider
  goes on generating tokens that are billed and discarded. Stopping the HTTPS
  call itself needs a Rust-side cancel, and belongs with the map's open question
  on cancellation semantics below the event boundary.
- **The session is still in memory.** `InMemorySessionStorage`, so the
  conversation dies with the window. `JsonlSessionRepo` — which also brings
  session list, resume and fork — is the next slice and needs four new Rust
  commands. See
  [ticket 15](wayfinder/pi-harness/tickets/15-core-already-does-this.md).
- **No check covers the disposal logic.** A check would have to import
  `provider.ts`, which uses extensionless imports Vite resolves and `node` does
  not, and `import.meta.env`. The two-turn native test is the substitute, and it
  asserts the thing that matters — the first turn's text does not move while the
  second runs.
- **`compacted` is now reachable** for the first time, and still has not fired.
  That is now an honest "untested" rather than the mislabelled one corrected in
  Slice 14.

---

## Slice 16 — The conversation survives the window

**User outcome:** Close the app, reopen it, and the agent still knows what you
were talking about. The transcript is written to disk as it happens rather than
saved at the end, so a crash loses nothing that was already said.

**What changed:** `InMemorySessionStorage` gave way to pi's `JsonlSessionRepo`,
which was already in the package — see
[ticket 15](wayfinder/pi-harness/tickets/15-core-already-does-this.md). It needs
eleven `FileSystem` methods; we had four. `joinPath` is pure string work, so
four new Rust commands closed the gap: `agent_append_file`, `agent_create_dir`,
`agent_list_dir`, `read_text_lines`.

Sessions live at `.ade/sessions/` **inside the workspace**, as
[ticket 09](wayfinder/pi-harness/tickets/09-session-store.md) settled — which
is why no containment exemption is needed. `.ade/.gitignore` contains `*`, so
the directory ignores itself and the user's own `.gitignore` is never edited by
us. `.ade` is also hidden from the explorer tree.

**Validated natively** against `deepseek-reasoner`:

- **Persistence.** One turn produces a five-line JSONL: a `session` header and
  four `message` entries in a parent-linked chain.
- **Resume.** After a full page reload — new module graph, new provider, **zero
  rendered turns** — "what number did I ask you to remember earlier?" answered
  `4477`, with 1068 context tokens. The history is really being sent.
- **No second session file.** The repo opens the newest rather than creating.
- **Git does not see it.** `git status` in the test workspace shows only the
  files the agent edited in earlier slices.
- `cargo test` 6 passed; `contained` refuses `..`, absolute ids, and a
  drive-qualified Windows path.

**A defect the first run exposed.** Two session files appeared with identical
millisecond timestamps. React's StrictMode double-invokes `useMemo`, so
`createAgentProvider` ran twice, both calls found no stored session, and both
created one — leaving an empty orphan at every start. Fixed by caching the
session *promise* at module scope, so the second caller waits for the first
rather than racing it. Worth recording because it is invisible in production
(no StrictMode) and would have shipped as a slow leak of empty files.

**Caveats and deviations**

- **The transcript does not rehydrate.** After a restart the chat renders empty
  while the model remembers everything — measured, not assumed:
  `turnsRenderedBeforeAsking: 0` and the right answer in the same run. This is
  the least honest state in the app right now. Mapping `SessionTreeEntry[]` back
  to `Turn[]` is the fix and it is its own piece of work.
- **Session list and fork are capability without UI.** `repo.list()` sorts
  newest first and `repo.fork()` is right there; "most recent for this
  workspace" is the entire selection policy, standing in for a picker.
- **`remove` stays unsupported**, so `repo.delete()` fails loudly. Nothing asks
  the app to erase files, so it cannot.
- **Two windows on one workspace would corrupt a session.** Both would open the
  newest and append to the same file. Nothing prevents it, and nothing needs to
  until sessions are something the user picks.
- **A session over 2 MiB is why `read_text_lines` exists.** `read_file` goes
  through `resolve`, which refuses anything larger — and the transcript is the
  one file here that grows without bound. The append cap is per chunk, not per
  file, for the same reason.

---

## Slice 17 — The agent can run commands

**User outcome:** The agent can run your tests, your build, `git status` —
anything a shell can do — and you see the output as it arrives rather than at
the end. Stop actually stops it, including whatever it started.

**What changed:** `src-tauri/src/exec.rs` (new) runs one command and streams its
output over a Tauri v2 `Channel`. `ExecutionEnv.exec` stops returning
`shell_unavailable`, and the tool itself is **pi's `createBashTool`** — pi owns
capture, truncation, throttled progress and overflow on top of `exec`, so Rust
only had to run a command and stream chunks. `createTempFile`/`createTempDir`
are implemented in TypeScript over the existing commands, writing into the same
gitignored `.ade/` directory, because pi hands the model the overflow file's
path and the model then tries to `read` it.

**The deviation, repeated here as
[ticket 02](wayfinder/pi-harness/tickets/02-exec-not-terminal.md) requires it to
be:** `exec` is **cwd-confined but not command-confined**. Rust refuses a `cwd`
outside the workspace and starts the child inside it, then does not police what
the command does next — `cd /` works, absolute paths work. This departs from
`context.md`'s "Rust is the only filesystem/process authority; it stays
root-confined". The reasoning is that a shell can always reach the filesystem,
and a partial sandbox that reads as absolute is worse than an honest boundary.
Containment for what a command *does* is the gate's job.

**The deny list ships with it, and is not a security boundary.** Nine patterns,
all irreversible — recursive delete, `reset --hard`, `clean -f`, force push,
`checkout --`, drive format, `dd of=`, shutdown, fork bomb. Every one is
trivially evaded, and saying so is the point: it exists because `auto` is the
default policy and auto running `git reset --hard` is a bad afternoon.

**`bash` is also in `MUTATING` in full**, so `careful` asks before *every*
command rather than only listed ones. A shell can always change something;
asking only about pattern matches would make `careful` quietly weaker than its
name.

**Validated natively** against `deepseek-reasoner`, with the gate on `careful`
so nothing ran without an explicit approval, in a throwaway workspace:

- `echo ade-bash-works` — asked, approved, ran, output returned, model quoted it.
- `rm -rf sandbox-delete-me` — asked **with the reason leading the detail**
  ("deletes files recursively — …"), **declined**, tool result `Failed`, turn
  continued, and the marker file was still on disk afterwards.
- **Streaming is incremental**: 7 characters — one `tick-N\n` — arriving each
  second, six distinct growth steps, not one lump at the end.
- Shell resolved to Git Bash; `agent_shell` reports it and the system prompt
  states it, because a machine without Git Bash gets PowerShell and POSIX
  one-liners fail there.
- `cargo test` 6 passed, `npm run check` 9 passed.

**Three ways to kill a process tree on Windows, two of which look like they
work.** This took the whole slice's debugging budget and none of it was
guessable from the code.

- `child.kill()` — what `terminal.rs` does — kills the direct child only.
- `taskkill /F /T` prints SUCCESS for every process it kills **and still leaks
  grandchildren**, because it kills a process before enumerating that process's
  children.
- Collecting the tree first and killing leaves-first also fails, and this is the
  finding that settles it: Git Bash's fork emulation spawns intermediates that
  exit immediately, so a `sleep` under `bash -lc` ends up with a parent id that
  **no longer resolves to any process** — measured directly as
  `ppid=9568, parentName=<GONE>` while it was still running. No walk from our
  root pid can reach it; the chain is already broken.
- A **job object** ignores parentage entirely. `TerminateJobObject` takes every
  process ever created inside it. Abort now returns in 2.0 s and the tree is
  gone within 415 ms of that, against 25.4 s before.

**A second bug hid behind the first.** Even with the kill working, `exec` took
the command's full runtime to return: killing the shell does not close its
stdout, because a grandchild inherited the write handle, so `read_until` blocked
until *that* process exited. Waiting for EOF was waiting for the wrong event.
The loop now polls the cancelled flag and stops waiting on the pipes; the reader
threads are deliberately not joined on that path.

**And a third, in the fix for the second.** The first tree-walk was written with
`-Filter "ParentProcessId=$(...)"`. Rust escapes `"` as `\"` when it builds a
command line and PowerShell's `-Command` mis-parses that, so the script silently
did nothing and looked exactly like a kill that failed to take. The replacement
contains no double quotes at all.

**Caveats and deviations**

- **The deny list is a foot-gun guard, not a boundary.** Stated in the code, in
  the ticket, and here, because the failure mode of a list like this is someone
  relying on it.
- **A false positive costs a prompt; a false negative costs data.** The patterns
  are tuned that way on purpose. `format` was originally `\bformat\b`, which
  flagged `echo "format the disk"` — noise that trains people to click through —
  and is now `format\s+[a-z]:`.
- **The deny list is checked as a pure function and nothing is spawned to test
  it.** Verifying a guard against destructive commands by running destructive
  commands would be an absurd trade.
- **`MAX_CAPTURE_BYTES` is 8 MiB per stream**, cut in Rust before the bytes cross
  the IPC, and the cut is appended to stderr so the model knows its log stops
  early rather than drawing conclusions from a partial one.
- **The timeout path is untested end to end.** pi sets one (60 s, seen in a real
  tool call) and the code kills through the same reaper, but no run has actually
  hit it.
- **`exit_code` is -1 for a signalled child**, which is not a real exit status
  and is reported as such rather than as success.

---

## Slice 18 — The conversation can be summarised before it overflows

**User outcome:** `/compact` summarises the conversation so far and the agent
keeps going with the summary instead of the whole history. The per-turn footer
now says how full the context is rather than only how many tokens went by, and
when a turn does die of overflow it says so in those words instead of returning
a raw provider string.

**What changed:** `src/agent/compaction.ts` (new) holds the policy —
`needsCompaction`, `pressure`, `overflowMessage`, `compactionMessage`, and the
two config readers. `AgentProvider` gains `compact(onEvent)`. `mapEvent` takes an
optional `contextWindow` and uses it for two things: a `contextWindow` field on
the `usage` event, and naming an overflow as an overflow. `AgentChat` parses a
leading `/compact` in its submit path and renders the compaction marker as a
`<details>` holding the summary.

**Adapters and dependencies:** every expensive part is pi's —
`AgentHarness.compact()`, `shouldCompact`, `DEFAULT_COMPACTION_SETTINGS`, and
`isContextOverflow` from `pi-ai` with its per-provider pattern table. **Two of
those four are exported by pi and called by neither pi package.** pi ships
context-pressure primitives and deliberately owns none of the policy; the policy
is this slice, and most of it is a refusal to guess. Settled in
[ticket 16](wayfinder/pi-harness/tickets/16-compaction.md).

**The window is explicit or absent — never guessed.** `contextWindow` was
hard-coded to `128_000` for every model. `shouldCompact` divides against it, so
that number silently set the compaction threshold. Three candidates existed: our
`128_000` with no source, pi's `1_000_000` for `deepseek-reasoner`'s nearest
catalogued neighbours, and the truth, which nobody has verified. **Both available
numbers err upward, and upward is the direction where compaction never fires and
the turn dies anyway.** So `VITE_AGENT_CONTEXT_WINDOW` (a profile field once
profiles exist) is required, and unset means auto-compaction cannot fire and the
meter shows a raw count. The `128_000` survives only as `FALLBACK_CONTEXT_WINDOW`
where pi's `Model` type demands a number for `clampMaxTokensToContext`, and
nothing that decides *when to compact* reads it.

**Auto-compaction is opt-in and holds the turn open.** `VITE_AGENT_AUTOCOMPACT=on`
checks on `agent_end`, when the harness is idle and the usage just reported is
real rather than estimated — which is why `estimateContextTokens` was **not**
adopted: post-turn there is nothing left to estimate. The turn's `complete` event
is withheld until the compaction finishes, so the composer stays disabled across
it. Releasing first would let a prompt reach a harness about to throw `busy`, and
would deliver the marker into a turn the UI had already closed.

**One harness, one thing at a time.** `prompt()` and `compact()` both throw
`AgentHarnessError("busy")` unless the harness is idle, and there are now two
ways for a user to reach it. A four-line promise queue in `createRunner`
serialises them and removes the whole class.

**Security boundary:** unchanged. Compaction is a model call over the existing
Rust-held credential path and touches no new native surface.

**Accessibility:** the compaction marker is a native `<details>` — keyboard
operable, announced as a disclosure, no ARIA needed. Starting a `/compact`
announces "Summarising the conversation" into the live region. During one the
Stop button is **replaced** by a disabled "Summarising…" rather than left
present: pi's `compact()` takes no abort signal, so there is genuinely nothing to
offer, and this repo has already shipped one Stop button that did nothing.

**Validation performed** — `npm run build`, `npm run check` (10 checks), and four
native runs against `deepseek-reasoner`:

- **`/compact` on a resumed session** — compacted, marker rendered, a 968-char
  summary behind the disclosure, "Summarising…" disabled and no Stop offered.
- **Automatic, window forced to 18,000** — the turn ran, `complete` was held, and
  the button went Stop → Send only at 6.9 s with the marker already in the same
  turn. Summary 1,316 chars.
- **It actually reduced the context.** The next turn read 8% (1,440 tokens),
  below the 1,616 threshold, and auto-compaction correctly did not fire again.
- **Unconfigured default** — `739 in · 4 out · 1,767 context`: raw count, no
  percentage, no warning, no compaction. This is what everyone gets out of the
  box.

**A wrong number was fixed on the way through.** The marker read *"summarised to
save {tokensBefore} tokens"*, but `tokensBefore` is the size of the context
*before* compacting, not the saving — overstated by whatever was retained,
roughly 20k every time. It now states the size and says so.

**A suspicion that did not survive checking.** After the first automatic
compaction the footer read `25 in` where an ordinary turn had read `900 in`, and
the obvious explanation was that the summariser's own model call was overwriting
the turn's usage. Sampling the footer across a compacting turn showed it
unchanged at `61 in · 289 out` before and after — the summariser does not emit
usage through the harness subscription, and the differing numbers were just
differing histories. Recorded because the fix for the bug that was not there
would have been to suppress real events.

**Caveats and deviations**

- **Out of the box this slice protects nobody.** With no window and no
  auto-compaction configured, the only thing shipped here is a better error
  message after the turn has already died. That is the honest consequence of
  refusing to guess the window, and it should not be read as "compaction is
  handled".
- **`keepRecentTokens: 20000` is not tunable.** `compact()` hard-codes
  `DEFAULT_COMPACTION_SETTINGS` internally when it calls `prepareCompaction`,
  while `shouldCompact` takes settings we supply. **The profile can say when,
  never how much.**
- **Compaction cannot be interrupted.** pi passes `undefined` where the abort
  signal goes. Stop during one ends the *turn*; the summarisation still finishes.
- **pi will summarise nothing, at full price.** The first `/compact` returned a
  structured summary whose content was *"No conversation content was provided to
  summarize. The `<conversation>` block is empty."* `prepareCompaction` returned
  a preparation rather than `undefined`, so the "Nothing to compact" guard never
  fired and a model call was spent on an empty conversation. Observed once, not
  yet understood, and not worked around.
- **The overflow path is untested live.** The three provider patterns are
  asserted in `compaction.check.ts` against real error strings, but no run has
  actually overflowed a model — that costs a deliberately oversized request.
- **A small window makes the warning look silly.** With the reserve fixed at
  16,384, an 18,000-token window warns at 9%. That is an artifact of the test
  setting; a real 128k window warns at 87%.

---

## Slice 19 — The system prompt stops being frozen

**User outcome:** None yet, and that is the honest summary. This removes a
foreclosure rather than adding a capability.

**What changed:** one line in `src/agent/provider.ts` — `systemPrompt:
systemPrompt(shell)` became `systemPrompt: () => systemPrompt(shell)`.

**Why it was worth its own slice.**
[Ticket 04](wayfinder/pi-harness/tickets/04-profile-data-model.md) resolved, in
bold, *"pass a callback, never a string — a string forecloses `instructions`
switching permanently."* The walking skeleton passed a string. It predates that
resolution, which explains it and does not fix it. There is no
`setSystemPrompt`: `createTurnState()` awaits the callback once per turn, so a
callback is the **only** mechanism by which a profile's `instructions` can ever
reach the model. Every remaining question about what the prompt contains is
answerable later; this one was answerable only before profiles get built on top
of it.

This is the same shape as the mistakes
[ticket 15](wayfinder/pi-harness/tickets/15-core-already-does-this.md) was
written about — building against an assumption a closed ticket had already
corrected — except the ticket contradicted here was our own rather than pi's.

**The callback composes nothing and returns the same text every turn.** That is
deliberate. What composes into the prompt, in what order, and whether a profile's
`instructions` append or replace is
[ticket 17](wayfinder/pi-harness/tickets/17-system-prompt-assembly.md), written
and deferred at the dev's instruction. Passing a string would have decided it by
foreclosure; passing a callback that does nothing decides nothing.

**Validated natively** against `deepseek-reasoner`: two consecutive turns in one
session, both asked which shell the `bash` tool uses, both answered "bash", both
clean. The guidance survives being recomputed per turn, which is the only thing
that could have broken.

**No check file.** A one-line callback with no branches; `context.md` asks for a
runnable check where there is logic, and there is none here. Ticket 17 will bring
the logic and the check together.
