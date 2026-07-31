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
