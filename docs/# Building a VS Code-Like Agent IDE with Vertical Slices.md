# Building a VS Code-Like Agent IDE with Vertical Slices  
  
> Project: Tauri Vertical-Slice Prototype    
> Project: Tauri Vertical-Slice Prototype    
> Stack: Tauri 2, React 19, TypeScript, Vite, Rust    
> Status: Functional workbench prototype with Agent Chat, editor, search, Git, and terminal    
> Status: Functional workbench prototype with Agent Chat, editor, search, Git, and terminal    
> Audience: Engineers and coding agents extending this prototype or building a similar IDE  
  
## 1. Purpose of This Document  
  
This is the complete development record and continuation guide for the project. It explains:  
This is the complete development record and continuation guide for the project. It explains:  
  
- Why the project exists.  
- Why the project exists.  
- What was learned from VS Code's Agents Window.  
- Why its implementation was recreated rather than copied.  
- Why its implementation was recreated rather than copied.  
- The order in which each functional slice was built.  
- The order in which each functional slice was built.  
- Which packages and earlier slices each step depends on.  
- Which packages and earlier slices each step depends on.  
- Which reusable UI pieces were extracted at each stage.  
- The design, accessibility, security, and architecture decisions that shaped the result.  
- Known caveats and deliberate prototype limitations.  
- Known caveats and deliberate prototype limitations.  
- The recommended roadmap for turning the prototype into a complete Agent IDE.  
- The recommended roadmap for turning the prototype into a complete Agent IDE.  
  
The most important lesson is that a high-quality IDE shell should not begin as a large speculative component library. Build complete user workflows one at a time, use explicit adapter seams, and extract a shared primitive only after real feature modules demonstrate the common contract.  
  
## 2. Product Goal  
## 2. Product Goal  
  
The original product target was VS Code's new Agents Window:  
The original product target was VS Code's new Agents Window:  
  
- Sessions or navigation on the left.  
- Agent conversation in the central region.  
- Agent conversation in the central region.  
- Files, changes, and other auxiliary views on the right.  
- Files, changes, and other auxiliary views on the right.  
- A bottom terminal or output panel.  
- A bottom terminal or output panel.  
- Native window chrome and desktop behavior.  
  
The desired result was not merely a similar dashboard. It needed the calm density, focus behavior, keyboard interaction, pane resizing, iconography, and visual hierarchy of a real workbench.  
  
The final prototype extends that concept into a small but functional IDE:  
The final prototype extends that concept into a small but functional IDE:  
  
- Agent Chat remains the primary central experience.  
- Files and diffs open in a centered modal editor.  
- Explorer and Search occupy the primary sidebar.  
- Explorer and Search occupy the primary sidebar.  
- Changes occupy the secondary sidebar.  
- Terminal occupies the bottom panel.  
- The shell is resizable and rearrangeable.  
- The shell is resizable and rearrangeable.  
- Browser fixtures and native implementations share typed adapter contracts.  
  
## 3. Source Exploration and the First Major Decision  
  
### 3.1 What was found in VS Code  
### 3.1 What was found in VS Code  
  
The source Agents Window lives primarily under `src/vs/sessions`. Its product name is Agents Window, while "sessions" is the internal architecture name.  
  
The investigation found:  
The investigation found:  
  
- A top-level workbench and grid controller.  
- A top-level workbench and grid controller.  
- A Sessions sidebar and grouped session list.  
- A central sessions/chat grid.  
- A central sessions/chat grid.  
- Per-session views and chat widgets.  
- Files and Changes contributions in auxiliary regions.  
- Files and Changes contributions in auxiliary regions.  
- Editor and bottom-panel integration.  
- Editor and bottom-panel integration.  
- Global command, menu, context-key, storage, lifecycle, and service dependencies.  
- Global command, menu, context-key, storage, lifecycle, and service dependencies.  
  
### 3.2 Why direct extraction was rejected  
### 3.2 Why direct extraction was rejected  
  
The UI is not an isolated React component tree. It relies on:  
The UI is not an isolated React component tree. It relies on:  
  
- VS Code's decorator-based dependency injection.  
- Global command, menu, editor, and view registries.  
- Side-effect contribution loading.  
- Side-effect contribution loading.  
- Workbench-specific widgets such as trees and chat.  
- Workbench-specific widgets such as trees and chat.  
- Context keys and configuration services.  
- Context keys and configuration services.  
- Observables, events, URI types, storage, and lifecycle services.  
- Localization transforms.  
- Workbench CSS and DOM contracts.  
- Workbench CSS and DOM contracts.  
- Editor, terminal, Explorer, and extension infrastructure.  
- Editor, terminal, Explorer, and extension infrastructure.  
  
Copying the high-level source would have meant rebuilding much of the VS Code runtime around it. That would be slower, more fragile, and harder to understand than recreating its product contracts.  
  
### 3.3 The selected strategy  
### 3.3 The selected strategy  
  
The project recreates:  
  
- Visual contracts: surfaces, density, typography, tokens, borders, focus, icon roles.  
- Visual contracts: surfaces, density, typography, tokens, borders, focus, icon roles.  
- Behavioral contracts: navigation, resizing, opening, dismissal, approvals, cancellation.  
- Behavioral contracts: navigation, resizing, opening, dismissal, approvals, cancellation.  
- Architectural contracts: feature modules, adapter boundaries, layout slots, persistence.  
  
It does not copy:  
It does not copy:  
  
- VS Code service graphs.  
- Contribution registries.  
- Contribution registries.  
- Internal singleton state.  
- Internal singleton state.  
- Workbench-specific base classes.  
  
This produced two projects:  
  
1. `tauri-agents-window`  
1. `tauri-agents-window`  
   - A visual and behavioral reference recreation.  
   - Used to prove the Agents Window appearance, sessions navigation, chat, themes, and native chrome.  
   - Used to prove the Agents Window appearance, sessions navigation, chat, themes, and native chrome.  
  
2. `tauri-vertical-slice-prototype`  
2. `tauri-vertical-slice-prototype`  
   - The functional architecture prototype documented here.  
   - Used to add real editor, filesystem, Git, search, terminal, persistence, and Agent workflows.  
   - Used to add real editor, filesystem, Git, search, terminal, persistence, and Agent workflows.  
  
## 4. Development Method  
  
Every feature followed this sequence:  
Every feature followed this sequence:  
  
```text  
```text  
tokens  
tokens  
  -> primitive  
  -> primitive  
  -> shell placement  
  -> shell placement  
  -> feature module  
  -> typed adapter seam  
  -> typed adapter seam  
  -> deterministic browser implementation  
  -> deterministic browser implementation  
  -> native implementation  
  -> native implementation  
  -> accessibility behavior  
  -> accessibility behavior  
  -> validation  
  -> validation  
```  
```  
  
This order matters.  
This order matters.  
  
### 4.1 Why vertical slices  
### 4.1 Why vertical slices  
  
A vertical slice proves a complete user outcome. For example, "Explorer to editor" includes:  
  
- A tree.  
- A tree.  
- Keyboard navigation.  
- File state.  
- File state.  
- An editor tab.  
- Monaco.  
- Monaco.  
- Focus behavior.  
- Focus behavior.  
- A deterministic provider.  
- A deterministic provider.  
  
Building only a generic tree or only an editor wrapper would not prove that the workflow feels like an IDE.  
Building only a generic tree or only an editor wrapper would not prove that the workflow feels like an IDE.  
  
### 4.2 Extraction rule  
  
Do not extract a shared component because two screens look vaguely similar. Extract it after at least two real consumers reveal the same stable behavior.  
  
Examples:  
Examples:  
  
- Explorer and Changes proved the need for `WorkbenchTree`.  
- Repeated toolbar use proved `ActionBar`.  
- Repeated toolbar use proved `ActionBar`.  
- Editor and terminal tabs proved `Tabs`.  
- Editor and terminal tabs proved `Tabs`.  
- Command center and dialogs proved common overlay behavior.  
- Command center and dialogs proved common overlay behavior.  
  
### 4.3 Adapter rule  
  
Feature components must consume domain interfaces, not call Tauri directly.  
Feature components must consume domain interfaces, not call Tauri directly.  
  
```text  
```text  
React feature  
  -> TypeScript provider or adapter interface  
  -> TypeScript provider or adapter interface  
  -> deterministic browser adapter OR Tauri adapter  
  -> Rust command/native API  
```  
```  
  
Benefits:  
Benefits:  
  
- Browser development remains fast.  
- Workflows can be tested without a native process.  
- Native implementation details stay outside the UI.  
- Native implementation details stay outside the UI.  
- A future Agent Host or Copilot CLI integration can replace a provider without rewriting chat.  
- A future Agent Host or Copilot CLI integration can replace a provider without rewriting chat.  
  
## 5. Technology and Dependency Inventory  
## 5. Technology and Dependency Inventory  
  
### 5.1 Frontend runtime  
### 5.1 Frontend runtime  
  
| Package | Role | Important caveat |  
|---|---|---|  
| `react` / `react-dom` 19 | Feature composition and stateful UI | Keep feature state local or controller-owned; avoid introducing a second state framework until needed. |  
| `vite` 7 | Development server and production bundling | Development port is fixed to `1430`. |  
| `typescript` 5.8 | Typed feature and adapter contracts | Prefer narrow interfaces and discriminated event unions. |  
| `typescript` 5.8 | Typed feature and adapter contracts | Prefer narrow interfaces and discriminated event unions. |  
| `@vscode/codicons` | VS Code-compatible icon language | Icon names must exist in the installed Codicon set. Icon-only controls require labels. |  
| `@vscode/codicons` | VS Code-compatible icon language | Icon names must exist in the installed Codicon set. Icon-only controls require labels. |  
| `monaco-editor` 0.53.0 | Source and diff editing | Large bundle, explicit worker setup, and model disposal are required. |  
| `@xterm/xterm` 6 | Terminal rendering | A terminal UI alone is not a shell; it depends on a PTY adapter. |  
| `@xterm/xterm` 6 | Terminal rendering | A terminal UI alone is not a shell; it depends on a PTY adapter. |  
| `@xterm/addon-fit` | Fit terminal geometry to its container | Resize observations must eventually resize both xterm and the native PTY. |  
| `@xterm/addon-fit` | Fit terminal geometry to its container | Resize observations must eventually resize both xterm and the native PTY. |  
| `@tauri-apps/api` 2 | Typed calls and events between frontend and Rust | Keep calls inside adapters, not feature components. |  
| `@tauri-apps/api` 2 | Typed calls and events between frontend and Rust | Keep calls inside adapters, not feature components. |  
| `@tauri-apps/plugin-dialog` | Native workspace folder picker | Native-only; browser provider cannot choose a real folder. |  
| `@tauri-apps/plugin-dialog` | Native workspace folder picker | Native-only; browser provider cannot choose a real folder. |  
| `@tauri-apps/plugin-opener` | Native open behavior scaffold | Present but not central to current workflows. |  
  
### 5.2 Native runtime  
### 5.2 Native runtime  
  
| Crate | Role | Important caveat |  
| Crate | Role | Important caveat |  
|---|---|---|  
| `tauri` 2 | Desktop host, commands, events, window APIs | Frameless controls require explicit capabilities. |  
| `tauri` 2 | Desktop host, commands, events, window APIs | Frameless controls require explicit capabilities. |  
| `tauri-build` 2 | Tauri build integration | Used only as a build dependency. |  
| `tauri-build` 2 | Tauri build integration | Used only as a build dependency. |  
| `tauri-plugin-dialog` 2 | Native folder selection | Permission must be declared. |  
| `tauri-plugin-opener` 2 | Native opener support | Permission must be declared. |  
| `tauri-plugin-opener` 2 | Native opener support | Permission must be declared. |  
| `portable-pty` 0.9.0 | Real pseudo-terminal backend | Current shell is Windows PowerShell-specific. |  
| `portable-pty` 0.9.0 | Real pseudo-terminal backend | Current shell is Windows PowerShell-specific. |  
| `serde` / `serde_json` | Native/frontend data serialization | Rust uses camel-case serialization for frontend contracts. |  
| `walkdir` 2.5 | Filesystem traversal dependency | The current native implementation mostly uses explicit `fs::read_dir`; review whether this dependency remains necessary. |  
| `walkdir` 2.5 | Filesystem traversal dependency | The current native implementation mostly uses explicit `fs::read_dir`; review whether this dependency remains necessary. |  
  
### 5.3 System dependencies  
  
- Windows 10 or 11.  
- Windows 10 or 11.  
- Stable Rust MSVC toolchain.  
- Visual Studio 2022 Build Tools with the C++ workload.  
- Node.js and npm.  
- Installed Git executable.  
- Installed Git executable.  
- `powershell.exe`.  
- `powershell.exe`.  
- WebView2 through Tauri.  
  
## 6. Slice-by-Slice Development Log  
## 6. Slice-by-Slice Development Log  
  
## Slice 0: Reference Agents Window  
## Slice 0: Reference Agents Window  
  
### Goal  
### Goal  
  
Prove that the Agents Window visual and interaction language can be recreated independently from VS Code.  
Prove that the Agents Window visual and interaction language can be recreated independently from VS Code.  
  
### Added  
### Added  
  
- Standalone Tauri/React window.  
- Sessions navigation.  
- Central chat.  
- Deterministic streaming.  
- Deterministic streaming.  
- Themes and persistence.  
- Accessibility surfaces.  
- Native custom chrome.  
  
### Depends on  
### Depends on  
  
- Tauri 2.  
- Tauri 2.  
- React and TypeScript.  
- React and TypeScript.  
- Codicons.  
- Codicons.  
- Deterministic in-memory fixtures.  
- Deterministic in-memory fixtures.  
  
### Design decision  
  
Use the source application as the product contract, but implement a clean runtime.  
Use the source application as the product contract, but implement a clean runtime.  
  
### Caveats  
### Caveats  
  
- Exact parity still requires pinned screenshot comparisons against a known VS Code revision.  
- The reference app is not the main functional IDE prototype.  
- The reference app is not the main functional IDE prototype.  
  
## Slice 1: Empty Workbench Shell  
## Slice 1: Empty Workbench Shell  
  
### Goal  
### Goal  
  
Establish the desktop window, layout grammar, native chrome, and accessible pane resizing before feature complexity.  
  
### Added features  
  
- Frameless native window.  
- Frameless native window.  
- Custom titlebar.  
- Drag region and double-click maximize.  
- Drag region and double-click maximize.  
- Minimize, maximize/restore, and close buttons.  
- Minimize, maximize/restore, and close buttons.  
- Primary sidebar, main region, secondary sidebar, and bottom panel.  
- Primary sidebar, main region, secondary sidebar, and bottom panel.  
- Pointer and keyboard resizing.  
- Pointer and keyboard resizing.  
- Region visibility toggles.  
- Region visibility toggles.  
- Focus-safe region hiding.  
- Focus-safe region hiding.  
- Accessibility help.  
- Accessibility help.  
  
### UI extracted  
  
- `tokens.css`  
- `tokens.css`  
- `Icon`  
- `Icon`  
- `IconButton`  
- `Pane`  
- `Pane`  
- `ResizableSeparator`  
  
### Depends on  
### Depends on  
  
- Tauri window API.  
- Tauri window API.  
- Codicons.  
- Tauri capabilities:  
- Tauri capabilities:  
  - close  
  - close  
  - is-maximized  
  - is-maximized  
  - minimize  
  - minimize  
  - start-dragging  
  - start-dragging  
  - toggle-maximize  
  - toggle-maximize  
  
### Key decisions  
### Key decisions  
  
- Use a fully custom titlebar because Tauri window decorations are disabled.  
- Use a fully custom titlebar because Tauri window decorations are disabled.  
- Give separators real keyboard behavior and accessible separator semantics.  
- If a visible region containing focus is hidden, transfer focus to the main region.  
- If a visible region containing focus is hidden, transfer focus to the main region.  
- Keep workbench chrome quiet at rest.  
- Keep workbench chrome quiet at rest.  
  
### Caveats  
### Caveats  
  
- A frameless window must reimplement behavior users normally receive from the OS.  
- Permission failures can look like broken UI even when the React handler is correct.  
- Native maximize state must be synchronized; visual assumptions are insufficient.  
- Native maximize state must be synchronized; visual assumptions are insufficient.  
  
## Slice 2: Explorer to Editor  
## Slice 2: Explorer to Editor  
  
### Goal  
  
Prove the first true IDE workflow: navigate a workspace tree and open source code.  
  
### Added features  
### Added features  
  
- Deterministic workspace fixture.  
- Deterministic workspace fixture.  
- Accessible Explorer tree.  
- Accessible Explorer tree.  
- Arrow-key navigation and expansion.  
- File opening.  
- Editor tabs.  
- Editor tabs.  
- Tab selection and closing.  
- Monaco source editor.  
- Monaco source editor.  
- Line reveal support.  
- TypeScript, JSON, CSS, and base Monaco workers.  
- TypeScript, JSON, CSS, and base Monaco workers.  
  
### UI extracted  
  
- `Tabs`  
- `Tabs`  
- Initial reusable tree behavior, later consolidated into `WorkbenchTree`  
- Editor composition through `EditorWorkbench`  
  
### Depends on  
### Depends on  
  
- Slice 1 shell regions.  
- `monaco-editor` 0.53.0.  
- `monaco-editor` 0.53.0.  
- Explicit `monacoEnvironment.ts` worker mapping.  
- Explicit `monacoEnvironment.ts` worker mapping.  
- Workspace provider contract.  
- Workspace provider contract.  
  
### Key decisions  
  
- Monaco is the only practical way to obtain high-quality code editing without recreating an editor.  
- The editor owns models and disposes them with component lifecycle.  
- The editor owns models and disposes them with component lifecycle.  
- Workspace data arrives through `WorkspaceProvider`.  
- Workspace data arrives through `WorkspaceProvider`.  
- Browser mode uses deterministic files.  
- Browser mode uses deterministic files.  
  
### Caveats  
  
- Monaco substantially increases production bundle size. The main bundle is roughly 4.2 MB minified, plus workers.  
- Worker misconfiguration may work in development and fail in production.  
- Editor state and DOM focus are different concerns; both must be managed.  
- Editor state and DOM focus are different concerns; both must be managed.  
  
## Slice 3: Command Center  
## Slice 3: Command Center  
  
### Goal  
  
Add a universal keyboard-first action surface backed by real commands.  
Add a universal keyboard-first action surface backed by real commands.  
  
### Added features  
  
- Command registry.  
- Command registry.  
- Fuzzy command scoring.  
- Fuzzy command scoring.  
- Deterministic file search in the command center.  
- Deterministic file search in the command center.  
- `Ctrl+Shift+P`.  
- `Ctrl+Shift+P`.  
- Arrow-key result navigation.  
- Arrow-key result navigation.  
- Enter execution.  
- Enter execution.  
- Escape dismissal.  
- Escape dismissal.  
- Focus restoration to the opener.  
  
### UI extracted  
### UI extracted  
  
- `Overlay`  
- Quick-pick composition pattern  
- Command descriptors separated from rendering  
  
### Depends on  
  
- Slice 1 shell actions.  
- Slice 1 shell actions.  
- Slice 2 file and editor actions.  
- Slice 2 file and editor actions.  
- `commandRegistry.ts`.  
- `commandRegistry.ts`.  
  
### Key decisions  
### Key decisions  
  
- Commands are data plus callbacks, not conditionals embedded in the command UI.  
- The command center invokes actual workbench operations.  
- Overlay dismissal restores focus.  
  
### Caveats  
### Caveats  
  
- Fuzzy search is intentionally lightweight, not VS Code's full ranking algorithm.  
- Global keyboard handlers must not fire while dialogs or editors own the same gesture.  
  
## Slice 4: Real Filesystem Workspace  
## Slice 4: Real Filesystem Workspace  
  
### Goal  
  
Replace fixture-only files with a selected local workspace without granting broad filesystem access to the frontend.  
  
### Added features  
### Added features  
  
- Native folder picker.  
- Workspace-root state in Rust.  
- Recursive directory listing.  
- UTF-8 file reads.  
- UTF-8 file reads.  
- File writes.  
- File writes.  
- Dirty editor tabs.  
- `Ctrl+S`.  
- `Ctrl+S`.  
- Save command and discard confirmation.  
- Restoring a previously selected workspace.  
- Restoring a previously selected workspace.  
  
### Adapter added  
### Adapter added  
  
`WorkspaceProvider`:  
  
```ts  
```ts  
interface WorkspaceProvider {  
readonly canChooseWorkspace: boolean;  
getTree(): Promise<readonly WorkspaceEntry[]>;  
getFiles(): Promise<readonly WorkspaceFile[]>;  
readFile(id: string): Promise<WorkspaceFile>;  
readFile(id: string): Promise<WorkspaceFile>;  
writeFile(id: string, content: string): Promise<void>;  
writeFile(id: string, content: string): Promise<void>;  
chooseWorkspace(): Promise<WorkspaceSelection | undefined>;  
restoreWorkspace(path: string): Promise<WorkspaceSelection>;  
search(query: string): Promise<readonly SearchResult[]>;  
search(query: string): Promise<readonly SearchResult[]>;  
}  
}  
```  
```  
  
### Depends on  
  
- Slice 2 editor workflow.  
- Slice 2 editor workflow.  
- Tauri API and dialog plugin.  
- Rust filesystem commands.  
- Rust filesystem commands.  
  
### Security decisions  
### Security decisions  
  
- Canonicalize the selected root.  
- Resolve every requested file beneath that root.  
- Reject paths outside the root.  
- Reject paths outside the root.  
- Skip symlinks.  
- Skip symlinks.  
- Reject non-files.  
- Reject non-files.  
- Limit opened files to 2 MiB.  
- Accept UTF-8 text only.  
- Accept UTF-8 text only.  
- Ignore `.git`, `node_modules`, `target`, and `dist` in tree/search operations.  
- Ignore `.git`, `node_modules`, `target`, and `dist` in tree/search operations.  
  
### Caveats  
### Caveats  
  
- The 2 MiB and UTF-8 restrictions are prototype policy, not a complete editor file model.  
- Binary files, encodings, symlink workspaces, remote filesystems, and file watching are not supported.  
- Binary files, encodings, symlink workspaces, remote filesystems, and file watching are not supported.  
- Directory traversal has a depth cap of 12.  
  
## Slice 5: Changes and Diff Workflow  
## Slice 5: Changes and Diff Workflow  
  
### Goal  
  
Prove that a second tree-based feature and a second editor type can reuse the emerging workbench contracts.  
  
### Added features  
### Added features  
  
- Deterministic Changes provider.  
- Changes tree.  
- Added, modified, and deleted statuses.  
- Added, modified, and deleted statuses.  
- Status badges.  
- Status badges.  
- Context actions.  
- Stage, unstage, and revert-style actions.  
- Monaco diff editor.  
- Shared source/diff tab host.  
  
### UI extracted  
  
- `WorkbenchTree`  
- `ActionBar`  
- `ActionBar`  
- `Badge`  
- `Badge`  
- `ContextMenu`  
- `ContextMenu`  
- Public `src/ui/index.ts` barrel  
- Public `src/ui/index.ts` barrel  
  
### Depends on  
  
- Slice 2 editor tabs and Monaco.  
- Slice 2 editor tabs and Monaco.  
- Slice 4 workspace concept.  
- `ChangesProvider`.  
- `ChangesProvider`.  
  
### Key decision  
### Key decision  
  
This is where the UI library became intentional. Explorer and Changes proved shared tree requirements:  
  
- Expansion.  
- Expansion.  
- Selection.  
- Keyboard navigation.  
- Descriptions.  
- Descriptions.  
- Accessories.  
- Accessories.  
- Context menus.  
- Context menus.  
  
### Caveats  
  
- The initial browser Changes provider mutates no real repository.  
- The initial browser Changes provider mutates no real repository.  
- Destructive actions need explicit confirmation.  
- Destructive actions need explicit confirmation.  
- A diff input is not the same as an editable source input; keep the union typed.  
  
## Slice 6: Native Terminal Panel  
  
### Goal  
  
Add a real interactive terminal to the bottom workbench panel.  
Add a real interactive terminal to the bottom workbench panel.  
  
### Added features  
  
- Native PowerShell PTY.  
- xterm.js rendering.  
- xterm.js rendering.  
- Fit addon.  
- Fit addon.  
- Frontend-to-PTY input.  
- PTY-to-frontend output events.  
- PTY-to-frontend output events.  
- Terminal resizing.  
- Terminal resizing.  
- Multiple terminal tabs.  
- Create and kill actions.  
- Create and kill actions.  
- Exit state.  
- Exit state.  
- Deterministic browser fallback.  
- Deterministic browser fallback.  
  
### UI reused  
### UI reused  
  
- `Tabs`  
- `ActionBar`  
- `ActionBar`  
- `Badge`  
- `Pane`  
- `Pane`  
- Bottom resizable workbench region  
- Bottom resizable workbench region  
  
### Depends on  
### Depends on  
  
- Slice 1 panel and separators.  
- Slice 1 panel and separators.  
- `portable-pty` 0.9.0.  
- `@xterm/xterm`.  
- `@xterm/xterm`.  
- `@xterm/addon-fit`.  
- Tauri event transport.  
  
### Adapter added  
  
`TerminalAdapter` defines:  
  
- `create`  
- `create`  
- `write`  
- `write`  
- `resize`  
- `resize`  
- `kill`  
- `onOutput`  
- `onOutput`  
- `onExit`  
- `onExit`  
  
### Key decisions  
  
- The React terminal never manages native processes directly.  
- The React terminal never manages native processes directly.  
- Rust owns process handles and PTY state.  
- Rust owns process handles and PTY state.  
- Terminal output and exit are events.  
- Live terminal processes are deliberately not persisted.  
- Live terminal processes are deliberately not persisted.  
  
### Caveats  
  
- The current native shell is hardcoded to:  
- The current native shell is hardcoded to:  
  
```text  
```text  
powershell.exe -NoLogo -NoProfile  
powershell.exe -NoLogo -NoProfile  
```  
  
- The browser fallback echoes text; it is not a shell.  
- The browser fallback echoes text; it is not a shell.  
- Terminal cleanup and application shutdown need more production hardening.  
- Terminal cleanup and application shutdown need more production hardening.  
- Cross-platform shell discovery is not implemented.  
  
## Slices 7 and 8: Persistence and Workspace Search  
  
### Goal  
### Goal  
  
Make the workbench resumable and add project-wide navigation.  
  
### Added persistence  
### Added persistence  
  
- Versioned localStorage schema.  
- Versioned localStorage schema.  
- Layout visibility and dimensions.  
- Layout visibility and dimensions.  
- Selected workspace label/path.  
- Selected workspace label/path.  
- Open editor inputs.  
- Open editor inputs.  
- Active editor.  
- Active editor.  
- Dirty editor IDs and content.  
- Dirty editor IDs and content.  
- Primary sidebar view.  
  
### Added search  
### Added search  
  
- Recursive native text search.  
- Browser fixture search.  
- Explorer/Search primary-view switching.  
- Result count and status.  
- Result count and status.  
- Search results through `WorkbenchTree`.  
- Opening a result at its matching line.  
- Opening a result at its matching line.  
  
### Depends on  
### Depends on  
  
- Slices 1-6 feature state.  
- Slices 1-6 feature state.  
- `PersistenceAdapter`.  
- `PersistenceAdapter`.  
- Workspace search method and Rust command.  
- Workspace search method and Rust command.  
  
### Key decisions  
### Key decisions  
  
- Persistence is versioned from the start.  
- Persist stable user state, not active runtime resources.  
- Search belongs to `WorkspaceProvider`; the Search UI does not know whether results are native or deterministic.  
  
### Search boundaries  
### Search boundaries  
  
- Case-insensitive line matching.  
- Case-insensitive line matching.  
- Maximum 500 results.  
- Maximum 500 results.  
- Maximum 2 MiB per file.  
- Ignore `.git`, `node_modules`, `target`, and `dist`.  
- Ignore `.git`, `node_modules`, `target`, and `dist`.  
- Skip symlinks and unreadable/non-UTF-8 files.  
  
### Caveats  
### Caveats  
  
- Malformed or unknown persistence versions are ignored.  
- Malformed or unknown persistence versions are ignored.  
- Search has no regex, include/exclude glob, cancellation, progress, or index.  
- localStorage is sufficient for the prototype but not for large conversation or workspace state.  
- localStorage is sufficient for the prototype but not for large conversation or workspace state.  
  
## Slice 9: Real Git Source Control  
## Slice 9: Real Git Source Control  
  
### Goal  
### Goal  
  
Replace deterministic Changes data with actual repository state while preserving the UI and provider contract.  
Replace deterministic Changes data with actual repository state while preserving the UI and provider contract.  
  
### Added features  
### Added features  
  
- Native `git status --porcelain=v1`.  
- Working tree and HEAD content.  
- Working tree and HEAD content.  
- Stage.  
- Stage.  
- Unstage.  
- Guarded revert.  
- Real diff inputs.  
- Browser fixture fallback.  
- Browser fixture fallback.  
  
### UI reused  
### UI reused  
  
- Changes tree.  
- Changes tree.  
- Status badges.  
- Status badges.  
- Context menu.  
- Context menu.  
- Monaco diff editor.  
- Center editor tab model.  
- Center editor tab model.  
  
### Depends on  
  
- Slice 5 Changes and diff UI.  
- Slice 5 Changes and diff UI.  
- Slice 4 selected workspace root.  
- Slice 4 selected workspace root.  
- Installed `git` executable.  
- Installed `git` executable.  
- Root-scoped `git -C`.  
  
### Key decisions  
  
- Git operations are always scoped to the selected workspace.  
- Git operations are always scoped to the selected workspace.  
- The native layer, not React, invokes Git.  
- The native layer, not React, invokes Git.  
- Non-Git workspaces produce no changes rather than crashing the workbench.  
- Revert requires confirmation and is not offered where it cannot be safely represented.  
- Revert requires confirmation and is not offered where it cannot be safely represented.  
  
### Caveats  
### Caveats  
  
- Porcelain v1 parsing is intentionally minimal.  
- Porcelain v1 parsing is intentionally minimal.  
- Rename, conflict, submodule, binary, ignored-file, multi-root, and partial-stage workflows need more work.  
- The current `git_content` fallback for staged-only states deserves production review.  
- The current `git_content` fallback for staged-only states deserves production review.  
- Revert is destructive even with confirmation; future Agent edits need a stronger transaction/undo model.  
- Revert is destructive even with confirmation; future Agent edits need a stronger transaction/undo model.  
  
## Slice 10: Controller and Layout Separation  
## Slice 10: Controller and Layout Separation  
  
### Goal  
### Goal  
  
Make the workbench layout easy to change after feature growth made the original shell too broad.  
  
### Before  
  
One `WorkbenchShell` owned:  
One `WorkbenchShell` owned:  
  
- Providers.  
- Providers.  
- Commands.  
- Commands.  
- Persistence.  
- Editors.  
- Editors.  
- Workspace lifecycle.  
- Feature state.  
- Geometry.  
- Geometry.  
- Region visibility.  
- Sashes.  
- Sashes.  
- Composition.  
- Composition.  
  
### After  
### After  
  
`WorkbenchController` owns:  
  
- Provider selection.  
- Commands.  
- Persistence.  
- Workspace/editor state.  
- Workspace/editor state.  
- Feature lifecycle.  
- Feature lifecycle.  
- Composition.  
- Composition.  
  
`WorkbenchLayout` owns:  
  
- Titlebar and workbench DOM topology.  
- Primary sidebar, main, secondary sidebar, and panel placement.  
- Primary sidebar, main, secondary sidebar, and panel placement.  
- Region visibility.  
- Widths and heights.  
- Widths and heights.  
- Sashes.  
- Focus transfer when regions disappear.  
- Focus transfer when regions disappear.  
- Overlay and announcement slots.  
- Overlay and announcement slots.  
  
### Layout contract  
### Layout contract  
  
```ts  
```ts  
interface WorkbenchLayoutSlots {  
interface WorkbenchLayoutSlots {  
readonly titlebar: ReactNode;  
readonly titlebar: ReactNode;  
readonly primarySidebar: ReactNode;  
readonly primarySidebar: ReactNode;  
readonly main: ReactNode;  
readonly secondarySidebar: ReactNode;  
readonly panel: ReactNode;  
readonly overlays?: ReactNode;  
readonly announcement?: ReactNode;  
readonly announcement?: ReactNode;  
}  
}  
```  
```  
  
### Depends on  
  
- All previous feature modules.  
- Stable persisted layout fields.  
- Stable persisted layout fields.  
  
### Key decisions  
### Key decisions  
  
- Features do not know where they are placed.  
- Features do not know where they are placed.  
- Layout receives semantic content slots and a compact state object.  
- Layout receives semantic content slots and a compact state object.  
- Replacing the topology should not require editing Explorer, Search, Changes, Terminal, Editor, or Agent features.  
- Replacing the topology should not require editing Explorer, Search, Changes, Terminal, Editor, or Agent features.  
- Preserve the persistence schema during architectural refactors.  
  
### Caveats  
### Caveats  
  
- `WorkbenchController` remains the largest composition module and may eventually need domain-specific hooks or controllers.  
- Do not "improve" layout flexibility by passing dozens of low-level callbacks. That would make the interface shallow and leak geometry outward.  
- Do not "improve" layout flexibility by passing dozens of low-level callbacks. That would make the interface shallow and leak geometry outward.  
  
## Slice 11: Agent Chat  
## Slice 11: Agent Chat  
  
### Goal  
### Goal  
  
Make Agent interaction the primary IDE experience while preserving the workbench around it.  
  
### Added features  
### Added features  
  
- Central Agent workbench.  
- Central Agent workbench.  
- Prompt composer.  
- Enter to send and Shift+Enter for a newline.  
- Deterministic streamed text.  
- Tool activity rows.  
- Approval request.  
- Approval request.  
- Continue and Skip.  
- Continue and Skip.  
- Stop/cancellation.  
- Stop/cancellation.  
- Accessible transcript.  
- Announcements.  
- Announcements.  
- Agent-specific help.  
- Agent-specific help.  
- Agent/Editor switching during the first implementation.  
  
### Adapter added  
  
```ts  
interface AgentProvider {  
start(prompt: string, onEvent: (event: AgentEvent) => void): AgentRun;  
start(prompt: string, onEvent: (event: AgentEvent) => void): AgentRun;  
}  
  
interface AgentRun {  
cancel(): void;  
cancel(): void;  
resolveApproval(approved: boolean): void;  
resolveApproval(approved: boolean): void;  
}  
```  
  
The event union contains:  
  
- `text`  
- `text`  
- `activity`  
- `approval`  
- `approval`  
- `complete`  
- `cancelled`  
  
### Depends on  
### Depends on  
  
- Slice 10 main layout slot.  
- Slice 10 main layout slot.  
- Existing tokens, icon language, buttons, overlays, and announcements.  
- Deterministic provider behavior.  
- Deterministic provider behavior.  
  
### Design decisions  
### Design decisions  
  
- Agent Chat is a workbench mode, not a fake file editor input.  
- Agent Chat is a workbench mode, not a fake file editor input.  
- Chat content visually leads.  
- Chat content visually leads.  
- Tool activity is compact and secondary.  
- Tool activity is compact and secondary.  
- Approval receives stronger semantic emphasis.  
- Approval receives stronger semantic emphasis.  
- Composer is an elevated outer-tier surface.  
- Provider lifecycle is independent from rendering.  
- Provider lifecycle is independent from rendering.  
- Prove cancellation and approval before integrating a real model.  
- Prove cancellation and approval before integrating a real model.  
  
### Accessibility decisions  
### Accessibility decisions  
  
- Transcript uses `role="log"` and polite live behavior.  
- Transcript uses `role="log"` and polite live behavior.  
- Controls have descriptive labels.  
- Completion and cancellation return focus to the prompt.  
- Plain text is available through an accessible transcript dialog.  
- Approval status is announced.  
- Approval status is announced.  
  
### Caveats  
### Caveats  
  
- The provider is deterministic and uses animation frames, so streaming is intentionally synthetic.  
- The provider is deterministic and uses animation frames, so streaming is intentionally synthetic.  
- Tool activity does not yet invoke real workspace tools.  
- Approval does not yet apply a file edit.  
- Conversations and selected Agent state are not persisted.  
- Full Sessions navigation is not implemented in this prototype.  
- Full Sessions navigation is not implemented in this prototype.  
- The accessible transcript should receive the same mature focus-trap and focus-restoration behavior now used by the editor modal.  
- The accessible transcript should receive the same mature focus-trap and focus-restoration behavior now used by the editor modal.  
  
## Slice 12: Centered File and Diff Editor Modal  
## Slice 12: Centered File and Diff Editor Modal  
  
### Goal  
  
Keep Agent Chat visible as the primary experience while opening files and diffs in a focused, dismissible editor.  
Keep Agent Chat visible as the primary experience while opening files and diffs in a focused, dismissible editor.  
  
### Added features  
  
- Centered editor dialog over the workbench.  
- Centered editor dialog over the workbench.  
- Agent remains visible beneath a subdued backdrop.  
- Agent remains visible beneath a subdued backdrop.  
- Existing editor tabs and unsaved content remain alive when dismissed.  
- Existing editor tabs and unsaved content remain alive when dismissed.  
- Source and diff editors reuse the same `EditorWorkbench`.  
- Source and diff editors reuse the same `EditorWorkbench`.  
- Dialog title and close action.  
- Dialog title and close action.  
- Escape dismissal.  
- Escape dismissal.  
- Tab and Shift+Tab focus containment.  
- Tab and Shift+Tab focus containment.  
- Initial focus into Monaco.  
- Focus restoration to the Explorer, Search, Changes, or Agent control that opened it.  
  
### UI extracted  
### UI extracted  
  
- `EditorDialog`  
- Improved reusable `Overlay` dialog focus behavior  
  
### Depends on  
### Depends on  
  
- Slice 2 editor and tabs.  
- Slice 2 editor and tabs.  
- Slice 5 diff editor.  
- Slice 5 diff editor.  
- Slice 10 `overlays` slot.  
- Slice 10 `overlays` slot.  
- Slice 11 Agent as the underlying main surface.  
- Slice 11 Agent as the underlying main surface.  
  
### Key decisions  
### Key decisions  
  
- A modal is transient feature state and is not persisted as workbench layout.  
- A modal is transient feature state and is not persisted as workbench layout.  
- The modal is an outer-tier surface.  
- The modal is an outer-tier surface.  
- Do not create another layout region for transient file interaction.  
- Do not replace the editor implementation; compose the existing editor inside a dialog.  
- Do not replace the editor implementation; compose the existing editor inside a dialog.  
- Keep dirty editor state when the dialog closes.  
  
### Accessibility contract  
### Accessibility contract  
  
- `role="dialog"`.  
- `role="dialog"`.  
- `aria-modal="true"`.  
- Title connected through `aria-labelledby`.  
- Title connected through `aria-labelledby`.  
- Focus enters on open.  
- Focus enters on open.  
- Focus cannot tab behind the dialog.  
- Escape closes.  
- Focus returns to the opener.  
- Monaco retains its native accessible editing behavior.  
- Monaco retains its native accessible editing behavior.  
  
### Caveats  
### Caveats  
  
- Backdrop click dismissal should remain a deliberate product choice; explicit close and Escape are the reliable paths.  
- Modal sizing must remain usable at the Tauri minimum window dimensions.  
- Modal sizing must remain usable at the Tauri minimum window dimensions.  
- Editor state must remain distinct from modal visibility.  
  
## 7. Current Internal UI Library  
  
The public internal UI surface is exported through `src/ui/index.ts`.  
The public internal UI surface is exported through `src/ui/index.ts`.  
  
| Primitive | Responsibility | Proven consumers |  
|---|---|---|  
|---|---|---|  
| `ActionBar` | Compact groups of feature actions | Changes, terminal, workbench views |  
| `ActionBar` | Compact groups of feature actions | Changes, terminal, workbench views |  
| `Badge` | Small semantic status/count marker | Changes, terminal |  
| `Badge` | Small semantic status/count marker | Changes, terminal |  
| `ContextMenu` | Anchored feature actions | Explorer/Changes workflows |  
| `ContextMenu` | Anchored feature actions | Explorer/Changes workflows |  
| `Icon` | Codicon rendering | Entire workbench |  
| `Icon` | Codicon rendering | Entire workbench |  
| `IconButton` | Accessible icon-only action | Titlebar, panes, Agent, editor |  
| `Overlay` | Dialog/overlay mechanics | Command center and modal surfaces |  
| `Pane` | Consistent region heading/body composition | Sidebars and panels |  
| `Pane` | Consistent region heading/body composition | Sidebars and panels |  
| `ResizableSeparator` | Pointer and keyboard resizing | Sidebars and panel |  
| `Tabs` | Accessible tab selection and close behavior | Editor and terminal |  
| `Tabs` | Accessible tab selection and close behavior | Editor and terminal |  
| `WorkbenchTree` | Accessible hierarchical navigation | Explorer, Search, Changes |  
  
### 7.1 What is intentionally not in the UI library  
  
- Workspace logic.  
- Git commands.  
- Git commands.  
- Tauri invocation.  
- Tauri invocation.  
- Agent provider lifecycle.  
- Persistence policy.  
- Persistence policy.  
- Terminal processes.  
- Terminal processes.  
- Workbench topology.  
- Workbench topology.  
  
The UI library provides interaction and presentation primitives, not application services.  
  
### 7.2 When to add a primitive  
### 7.2 When to add a primitive  
  
Add one when:  
  
- At least two features need the same behavior.  
- The behavior can be described without feature-specific nouns.  
- The behavior can be described without feature-specific nouns.  
- Accessibility semantics are the same.  
- Accessibility semantics are the same.  
- The API hides meaningful implementation complexity.  
  
Do not add one when:  
  
- It only shortens a small JSX fragment.  
- It only shortens a small JSX fragment.  
- It requires many feature-specific props.  
- It requires many feature-specific props.  
- It would move state ownership into a generic component.  
- The second use case is hypothetical.  
- The second use case is hypothetical.  
  
## 8. Design System Decisions  
## 8. Design System Decisions  
  
The project uses four design values:  
The project uses four design values:  
  
- **Calm:** quiet chrome, limited simultaneous emphasis, stable surfaces.  
- **Focused:** the current task leads; secondary controls recede.  
- **Focused:** the current task leads; secondary controls recede.  
- **Consistent:** the same semantic role uses the same token, control, and interaction.  
- **Consistent:** the same semantic role uses the same token, control, and interaction.  
- **Delightful:** native-feeling details such as proper focus restoration and window behavior.  
  
### 8.1 Token-first styling  
### 8.1 Token-first styling  
  
`tokens.css` is the central contract for:  
`tokens.css` is the central contract for:  
  
- Theme colors.  
- Foreground hierarchy.  
- Foreground hierarchy.  
- Borders and focus.  
- Borders and focus.  
- Spacing.  
- Spacing.  
- Typography.  
- Typography.  
- Radii.  
- Radii.  
- Pane and control dimensions.  
- Overlay surfaces.  
  
Feature CSS should use `--ide-*` tokens instead of inventing isolated values.  
Feature CSS should use `--ide-*` tokens instead of inventing isolated values.  
  
### 8.2 Surface tiers  
  
- **Control tier:** buttons, inputs, tabs, tree rows.  
- **Control tier:** buttons, inputs, tabs, tree rows.  
- **Inner tier:** cards and compact embedded activity.  
- **Inner tier:** cards and compact embedded activity.  
- **Outer tier:** composer, dialogs, centered editor modal.  
  
The Agent approval is emphasized semantically, not through decorative animation.  
  
### 8.3 Density  
### 8.3 Density  
  
IDE UI must remain information-dense without becoming noisy:  
IDE UI must remain information-dense without becoming noisy:  
  
- Compact row heights.  
- Compact row heights.  
- Small icon actions.  
- Small icon actions.  
- Clear hover/focus changes.  
- Clear hover/focus changes.  
- Stronger borders only for selected, focused, dangerous, or approval states.  
- Stronger borders only for selected, focused, dangerous, or approval states.  
- Avoid unnecessary cards around every block.  
- Avoid unnecessary cards around every block.  
  
## 9. Accessibility as Architecture  
## 9. Accessibility as Architecture  
  
Accessibility was implemented as part of every slice rather than as a final audit.  
Accessibility was implemented as part of every slice rather than as a final audit.  
  
### 9.1 Baseline rules  
### 9.1 Baseline rules  
  
- Every icon-only button has a descriptive label.  
- Every interactive region is keyboard reachable.  
- Every interactive region is keyboard reachable.  
- Trees use expected arrow-key behavior.  
- Trees use expected arrow-key behavior.  
- Tabs use tablist semantics and keyboard movement.  
- Sashes are accessible separators with keyboard resizing.  
- Sashes are accessible separators with keyboard resizing.  
- Overlays have Escape dismissal and focus restoration.  
- Hidden regions cannot retain invisible focus.  
- Dynamic Agent output uses restrained live announcements.  
- Reduced-motion preferences must not lose state information.  
  
### 9.2 Dialog checklist  
  
Every new modal must:  
  
1. Use dialog semantics.  
1. Use dialog semantics.  
2. Have a programmatic title.  
2. Have a programmatic title.  
3. Capture the opener before mounting.  
3. Capture the opener before mounting.  
4. Move focus into the dialog after mounting.  
5. Trap forward and backward tab navigation.  
6. Close on Escape unless an embedded control has a stronger valid reason.  
6. Close on Escape unless an embedded control has a stronger valid reason.  
7. Restore focus when closed.  
8. Expose explicit close controls.  
  
### 9.3 Important lesson  
  
Focus restoration is not polish. Without it, keyboard users lose their location in a dense workbench. Treat opener tracking as part of the state transition.  
Focus restoration is not polish. Without it, keyboard users lose their location in a dense workbench. Treat opener tracking as part of the state transition.  
  
## 10. Native Security Boundary  
## 10. Native Security Boundary  
  
The frontend is not granted arbitrary filesystem or process access.  
The frontend is not granted arbitrary filesystem or process access.  
  
### 10.1 Workspace root  
### 10.1 Workspace root  
  
Rust stores one canonical selected root. Every file operation resolves a relative ID beneath it.  
Rust stores one canonical selected root. Every file operation resolves a relative ID beneath it.  
  
### 10.2 File policy  
  
- Existing canonical file only.  
- Existing canonical file only.  
- Must remain beneath the root.  
- Must remain beneath the root.  
- Must be UTF-8.  
- Maximum 2 MiB.  
- Maximum 2 MiB.  
- Symlinks skipped during traversal.  
- Symlinks skipped during traversal.  
  
### 10.3 Search policy  
### 10.3 Search policy  
  
- Root-confined.  
- Root-confined.  
- Build/dependency folders ignored.  
- Build/dependency folders ignored.  
- Symlinks skipped.  
- Symlinks skipped.  
- Unreadable files skipped.  
- Maximum 500 hits.  
- Maximum 500 hits.  
  
### 10.4 Git policy  
### 10.4 Git policy  
  
- Execute installed Git through `git -C <workspace>`.  
- Pass paths after `--`.  
- Expose narrow commands rather than arbitrary shell execution.  
- Expose narrow commands rather than arbitrary shell execution.  
- Confirm destructive restoration in the UI.  
  
### 10.5 Terminal policy  
  
The terminal is intentionally the broadest native capability. It starts a real shell, so it should be treated as an explicit user-facing feature, not as an invisible implementation shortcut for other providers.  
  
Agent tools should not secretly reuse unrestricted terminal execution when a narrow workspace or Git operation can be provided.  
Agent tools should not secretly reuse unrestricted terminal execution when a narrow workspace or Git operation can be provided.  
  
## 11. State Ownership and Persistence  
## 11. State Ownership and Persistence  
  
### 11.1 Controller-owned state  
### 11.1 Controller-owned state  
  
`WorkbenchController` owns cross-feature orchestration:  
`WorkbenchController` owns cross-feature orchestration:  
  
- Selected workspace.  
- Workspace tree and files.  
- Workspace tree and files.  
- Open editor inputs.  
- Open editor inputs.  
- Dirty state.  
- Layout state.  
- Primary view.  
- Primary view.  
- Providers.  
- Providers.  
- Command registrations.  
- Command registrations.  
- Overlay composition.  
- Agent/main workflow.  
- Agent/main workflow.  
  
### 11.2 Feature-owned state  
### 11.2 Feature-owned state  
  
A feature should own transient details that do not coordinate the workbench:  
A feature should own transient details that do not coordinate the workbench:  
  
- Search input and result selection.  
- Search input and result selection.  
- Terminal instance view state.  
- Agent prompt draft and active activity display.  
- Agent prompt draft and active activity display.  
- Editor internal Monaco view state.  
- Editor internal Monaco view state.  
  
### 11.3 Layout-owned state behavior  
### 11.3 Layout-owned state behavior  
  
`WorkbenchLayout` receives layout state but owns geometry mechanics:  
`WorkbenchLayout` receives layout state but owns geometry mechanics:  
  
- Rendering visible regions.  
- Rendering visible regions.  
- Applying widths/heights.  
- Applying widths/heights.  
- Resizing through sashes.  
- Resizing through sashes.  
- Focus transfer when hiding a region.  
- Focus transfer when hiding a region.  
  
### 11.4 Persistence policy  
  
Persist:  
Persist:  
  
- Stable layout.  
- Stable layout.  
- Workspace identity.  
- Open editor inputs.  
- Active editor.  
- Dirty contents.  
- Selected stable views.  
- Future completed Agent conversations.  
- Future completed Agent conversations.  
  
Do not persist:  
  
- Live PTY processes.  
- In-flight Agent streams.  
- Pending approval callbacks.  
- Pending approval callbacks.  
- Temporary modal visibility.  
- Temporary modal visibility.  
- DOM focus references.  
  
## 12. Browser and Native Dual-Mode Development  
  
Every major native feature has a deterministic browser implementation.  
  
| Domain | Browser mode | Native mode |  
|---|---|---|  
|---|---|---|  
| Workspace | In-memory fixture files | Root-confined Rust filesystem |  
| Workspace | In-memory fixture files | Root-confined Rust filesystem |  
| Search | Search fixture content | Recursive Rust search |  
| Changes | Fixed fixture changes | Installed Git |  
| Changes | Fixed fixture changes | Installed Git |  
| Terminal | Echoing fake shell | `portable-pty` PowerShell |  
| Terminal | Echoing fake shell | `portable-pty` PowerShell |  
| Agent | Deterministic event stream | Future Agent Host/Copilot adapter |  
| Persistence | localStorage | Currently also localStorage |  
| Persistence | localStorage | Currently also localStorage |  
  
### Why this matters  
  
- Browser iteration is faster than rebuilding Tauri.  
- UI states are reproducible.  
- Agent runs can be deterministic.  
- Agent runs can be deterministic.  
- Visual regression fixtures are practical.  
- Visual regression fixtures are practical.  
- Native bugs are easier to distinguish from UI bugs.  
- Native bugs are easier to distinguish from UI bugs.  
  
### Rule  
  
Browser fallbacks must preserve the adapter contract and important state transitions. They do not need to pretend to provide native capability they cannot safely emulate.  
Browser fallbacks must preserve the adapter contract and important state transitions. They do not need to pretend to provide native capability they cannot safely emulate.  
  
## 13. Validation Workflow  
## 13. Validation Workflow  
  
Use the smallest validation that proves the changed slice, then expand when native or cross-cutting code changes.  
Use the smallest validation that proves the changed slice, then expand when native or cross-cutting code changes.  
  
### 13.1 Frontend  
### 13.1 Frontend  
  
```powershell  
```powershell  
npm run build  
npm run build  
```  
```  
  
This runs TypeScript and the Vite production build.  
This runs TypeScript and the Vite production build.  
  
### 13.2 Native  
  
```powershell  
```powershell  
cargo check --manifest-path src-tauri\Cargo.toml  
cargo check --manifest-path src-tauri\Cargo.toml  
cargo fmt --manifest-path src-tauri\Cargo.toml --check  
cargo fmt --manifest-path src-tauri\Cargo.toml --check  
```  
```  
  
Run these when Rust, Tauri commands, permissions, or native dependencies change.  
Run these when Rust, Tauri commands, permissions, or native dependencies change.  
  
### 13.3 Dependencies  
### 13.3 Dependencies  
  
```powershell  
npm audit --omit=dev  
```  
```  
  
Do not upgrade Monaco or other large dependencies casually. Recheck bundle behavior, worker compatibility, and advisories.  
  
### 13.4 Diff hygiene  
### 13.4 Diff hygiene  
  
```powershell  
git diff --check  
git diff --check  
git status --short  
git status --short  
```  
  
### 13.5 Runtime  
  
```powershell  
```powershell  
npm run tauri dev  
npm run tauri dev  
```  
```  
  
The Vite development server uses port `1430`.  
The Vite development server uses port `1430`.  
  
### 13.6 Interaction checklist  
  
For any UI slice, validate:  
For any UI slice, validate:  
  
- Pointer interaction.  
- Pointer interaction.  
- Keyboard-only interaction.  
- Focus visibility.  
- Focus restoration.  
- Focus restoration.  
- Escape behavior.  
- Resize behavior.  
- Minimum window size.  
- Empty, loading, success, and error states.  
- Browser adapter.  
- Browser adapter.  
- Native adapter where applicable.  
- Native adapter where applicable.  
  
For editor changes, also validate:  
For editor changes, also validate:  
  
- Open.  
- Open.  
- Switch tab.  
- Dirty edit.  
- Dirty edit.  
- Save.  
- Save.  
- Close.  
- Close.  
- Diff open.  
- Line reveal.  
- Modal close and reopen.  
- Modal close and reopen.  
  
For Agent changes, also validate:  
For Agent changes, also validate:  
  
- Send.  
- Send.  
- Multiline prompt.  
- Multiline prompt.  
- Streaming.  
- Streaming.  
- Tool activity.  
- Approval Continue.  
- Approval Skip.  
- Approval Skip.  
- Cancellation.  
- Cancellation.  
- Completion focus.  
- Completion focus.  
- Accessible transcript.  
  
## 14. Git History and Baselines  
## 14. Git History and Baselines  
  
The prototype is an independent nested Git repository.  
  
Current milestones:  
Current milestones:  
  
- `f8ba234` - Initial Agents workbench prototype.  
- `f8ba234` - Initial Agents workbench prototype.  
- `54c1d56` - Open files in a centered editor dialog.  
  
The first commit preserves the complete pre-modal vertical-slice baseline. The second isolates the editor-modal interaction change.  
The first commit preserves the complete pre-modal vertical-slice baseline. The second isolates the editor-modal interaction change.  
  
This split is useful for future agents:  
  
- Compare architecture before and after modalization.  
- Compare architecture before and after modalization.  
- Revert or prototype alternative editor presentation without losing the workbench baseline.  
- Revert or prototype alternative editor presentation without losing the workbench baseline.  
- Review new work as focused changes.  
- Review new work as focused changes.  
  
## 15. Known Caveats and Technical Debt  
## 15. Known Caveats and Technical Debt  
  
### Frontend  
### Frontend  
  
- No dedicated automated test suite is currently configured in this prototype.  
- No dedicated automated test suite is currently configured in this prototype.  
- `WorkbenchController` remains broad.  
- `WorkbenchController` remains broad.  
- `App.css` contains many feature styles and could later be split by stable feature boundaries.  
- Monaco has a high bundle cost.  
- Monaco has a high bundle cost.  
- The Agent stream cadence is synthetic.  
- Agent conversations are not persisted.  
- Agent conversations are not persisted.  
- The accessible Agent transcript should adopt the mature editor-dialog focus contract.  
  
### Native  
  
- Windows PowerShell is hardcoded.  
- Windows PowerShell is hardcoded.  
- There is no workspace file watcher.  
- There is no workspace file watcher.  
- Search has no cancellation or indexing.  
- Search has no cancellation or indexing.  
- Git parsing is simplified.  
- Terminal lifecycle on application shutdown needs production hardening.  
- Terminal lifecycle on application shutdown needs production hardening.  
- CSP is currently `null` in the Tauri prototype configuration and must be tightened before production.  
- `walkdir` may be unused and should be audited before retaining it.  
  
### Product  
### Product  
  
- Full Sessions navigation is not present in the functional prototype.  
- No extension host or language server integration.  
- No diagnostics, completion provider, debugger, tasks, or output channels.  
- No diagnostics, completion provider, debugger, tasks, or output channels.  
- No multi-root or remote workspace.  
- No multi-root or remote workspace.  
- No complete settings/keybinding model.  
- No complete settings/keybinding model.  
- No real model backend.  
- No real model backend.  
- No real Agent tool execution or edit transaction.  
- No real Agent tool execution or edit transaction.  
  
## 16. Pi Agent Ecosystem Audit and Rust Harness Decision  
  
This section is an architectural guardrail for future agents. Pi was evaluated as a capability reference, but its runtime packages must not be integrated directly into this Tauri application unless this decision is explicitly revisited.  
This section is an architectural guardrail for future agents. Pi was evaluated as a capability reference, but its runtime packages must not be integrated directly into this Tauri application unless this decision is explicitly revisited.  
  
### 16.1 What was audited  
  
The package name `pi-agent-core` is ambiguous. The unscoped npm package `pi-agent-core@0.0.1` is unrelated to the intended coding-agent ecosystem. The relevant packages identified during the audit are published under the `@earendil-works` scope, including `@earendil-works/pi-agent-core`.  
The package name `pi-agent-core` is ambiguous. The unscoped npm package `pi-agent-core@0.0.1` is unrelated to the intended coding-agent ecosystem. The relevant packages identified during the audit are published under the `@earendil-works` scope, including `@earendil-works/pi-agent-core`.  
  
The canonical agent-core package provides useful behavior:  
  
- A model-driven agent loop.  
- Streamed assistant output.  
- Streamed assistant output.  
- Tool-call execution and result return.  
- Conversation state.  
- Conversation state.  
- Cancellation and lifecycle behavior.  
- Cancellation and lifecycle behavior.  
- Foundations for richer sessions, compaction, retries, and multiple providers.  
- Foundations for richer sessions, compaction, retries, and multiple providers.  
  
However, the package targets Node.js 22.19 or newer. It is not designed to execute inside a browser or Tauri WebView. Using it would therefore require an additional Node runtime or sidecar process.  
  
### 16.2 Why direct Pi integration was rejected  
### 16.2 Why direct Pi integration was rejected  
  
There are two possible direct-integration shapes, and neither matches this project.  
There are two possible direct-integration shapes, and neither matches this project.  
  
#### Running Pi in the WebView  
#### Running Pi in the WebView  
  
This is unsupported because Pi expects Node facilities unavailable in the WebView. Polyfilling selected modules would not provide a sound runtime and would move privileged agent behavior into the renderer.  
  
#### Running Pi in a Node sidecar  
  
A sidecar could technically work, but it would add:  
A sidecar could technically work, but it would add:  
  
- A separately distributed Node runtime or an external Node prerequisite.  
- A second process lifecycle, crash-recovery, and upgrade path.  
- Authenticated and versioned IPC between Tauri and Node.  
- Startup readiness, shutdown, cancellation, and orphan-process handling.  
- Startup readiness, shutdown, cancellation, and orphan-process handling.  
- Separate logging and diagnostic channels.  
- Additional packaging, signing, and platform-specific failure modes.  
- Additional packaging, signing, and platform-specific failure modes.  
- A second authority boundary around filesystem, Git, and process access.  
  
The sidecar would also duplicate work already owned by the Tauri backend. This project already has canonical Rust modules for the selected workspace, bounded search/read, Git, persistence, and PTY processes.  
  
### 16.3 Security mismatch  
### 16.3 Security mismatch  
  
Pi's general-purpose filesystem and shell tools cannot be exposed directly. They would bypass the IDE's existing authority model:  
Pi's general-purpose filesystem and shell tools cannot be exposed directly. They would bypass the IDE's existing authority model:  
  
- The selected canonical workspace root is the filesystem authority boundary.  
- The selected canonical workspace root is the filesystem authority boundary.  
- Paths cannot escape that root.  
- Paths cannot escape that root.  
- Symlinks are skipped.  
- Only bounded UTF-8 text files are read.  
- Search excludes `.git`, `node_modules`, `target`, and `dist`.  
- Search and read results have explicit size/count limits.  
- Search and read results have explicit size/count limits.  
- Git and terminal operations use separate typed modules and policies.  
- Git and terminal operations use separate typed modules and policies.  
  
An Agent must reuse these existing operations. It must never receive arbitrary filesystem paths, unrestricted shell execution, raw Git commands, or direct PTY handles merely because a generic agent library supports them.  
An Agent must reuse these existing operations. It must never receive arbitrary filesystem paths, unrestricted shell execution, raw Git commands, or direct PTY handles merely because a generic agent library supports them.  
  
### 16.4 Decision  
### 16.4 Decision  
  
Implement a small project-owned agent harness in Rust inside the Tauri backend.  
  
```text  
```text  
React Agent UI  
React Agent UI  
      ↕ versioned Tauri commands and events  
Rust Agent Harness  
Rust Agent Harness  
  ├─ one model transport adapter  
  ├─ one model transport adapter  
  ├─ run state machine  
  ├─ run state machine  
  ├─ typed tool registry  
  ├─ typed tool registry  
  ├─ existing root-confined Search/Read operations  
  ├─ cancellation and approval coordination  
  └─ bounded, normalized results  
  └─ bounded, normalized results  
```  
  
Preserve the existing frontend `AgentProvider` interface. Add a Tauri-backed adapter behind it; do not let model SDK or wire types enter React feature state.  
  
The Rust harness is a deep module at the model-to-product seam. Its small external interface should initially expose only:  
The Rust harness is a deep module at the model-to-product seam. Its small external interface should initially expose only:  
  
- Start a run.  
- Start a run.  
- Cancel a run.  
- Cancel a run.  
- Resolve an approval.  
- Subscribe to versioned run events.  
- Subscribe to versioned run events.  
  
Provider parsing, tool dispatch, correlation, bounds, cancellation races, error normalization, and exactly-once terminal delivery remain implementation details.  
Provider parsing, tool dispatch, correlation, bounds, cancellation races, error normalization, and exactly-once terminal delivery remain implementation details.  
  
### 16.5 Rewrite scope  
### 16.5 Rewrite scope  
  
Do not translate Pi source line-for-line and do not attempt package compatibility. Reimplement only the behavior required by complete IDE workflows.  
  
#### Implement now  
  
- One OpenAI-compatible streaming model protocol.  
- One OpenAI-compatible streaming model protocol.  
- Streamed text and typed tool calls.  
- Streamed text and typed tool calls.  
- Sequential, read-only `search_workspace` and `read_file` tools.  
- Run, request, tool, and approval correlation IDs.  
- Stable event sequence numbers.  
- Stable event sequence numbers.  
- Cancellation.  
- Cancellation.  
- Normalized provider/tool failures.  
- Normalized provider/tool failures.  
- Bounded serializable tool results.  
- Exactly one terminal state: completed, failed, or cancelled.  
- Exactly one terminal state: completed, failed, or cancelled.  
- Deterministic Rust transport and tool adapters for tests.  
  
#### Add only when a product slice requires it  
#### Add only when a product slice requires it  
  
- Structured write/patch proposal, preview, guarded apply, and undo.  
- Structured write/patch proposal, preview, guarded apply, and undo.  
- Read-only Git inspection, followed later by separately approved Git mutations.  
- Read-only Git inspection, followed later by separately approved Git mutations.  
- Durable sessions and resume.  
- Durable sessions and resume.  
- Context compaction.  
- Context compaction.  
- Retry and rate-limit policy.  
- Additional model protocols.  
- Parallel tools proven safe and useful.  
- Richer approval policies.  
- Richer approval policies.  
- Subagents.  
  
#### Not planned by default  
#### Not planned by default  
  
- Pi CLI or TUI recreation.  
- Pi package or plugin compatibility.  
- Pi package or plugin compatibility.  
- A broad provider catalog.  
- A generic extension ecosystem.  
- A generic extension ecosystem.  
- Unrestricted filesystem or shell tools.  
- Unrestricted filesystem or shell tools.  
- A duplicate interactive terminal implementation.  
- A duplicate interactive terminal implementation.  
  
### 16.6 Required invariants  
  
Future implementations must preserve:  
Future implementations must preserve:  
  
1. The protocol is explicitly versioned.  
1. The protocol is explicitly versioned.  
2. Events have monotonically increasing sequence numbers.  
2. Events have monotonically increasing sequence numbers.  
3. Each run emits one start and exactly one terminal event.  
4. Cancellation prevents later model turns, tools, approvals, or completion.  
5. Late provider/tool results after cancellation are ignored.  
5. Late provider/tool results after cancellation are ignored.  
6. Approval-required operations cannot execute before approval.  
6. Approval-required operations cannot execute before approval.  
7. Tool requests and results are typed, bounded, and serializable.  
7. Tool requests and results are typed, bounded, and serializable.  
8. Provider errors are normalized and do not expose credentials.  
8. Provider errors are normalized and do not expose credentials.  
9. Raw credentials never enter renderer state, transcripts, logs, or persisted workbench state.  
9. Raw credentials never enter renderer state, transcripts, logs, or persisted workbench state.  
10. Agent tools reuse existing Rust authority modules rather than creating parallel access paths.  
10. Agent tools reuse existing Rust authority modules rather than creating parallel access paths.  
  
### 16.7 When to reconsider Pi  
### 16.7 When to reconsider Pi  
  
Reconsider a Node/Pi sidecar only if the product later requires substantial Pi-specific behavior whose maintenance cost clearly exceeds the sidecar cost—for example, strict Pi extension compatibility or a large set of mature Pi capabilities that cannot be reproduced safely in the focused harness.  
  
If reconsidered, require a new decision record covering runtime distribution, IPC authentication/versioning, process supervision, tool-authority mapping, crash recovery, updates, signing, and cross-platform packaging. Do not introduce Pi incrementally as an undocumented implementation shortcut.  
  
## 17. Roadmap  
  
The next work should prove a real, read-only Agent action loop in a project-owned Rust harness. The roadmap is dependency ordered:  
  
```text  
```text  
A. Rust harness foundation and one model protocol  
   -> B. Read-only Search, Read, and Git inspection  
   -> B. Read-only Search, Read, and Git inspection  
      -> C. Structured edit proposal and preview  
      -> C. Structured edit proposal and preview  
         -> D. Guarded apply and independent undo  
         -> D. Guarded apply and independent undo  
            -> E. Persistent Sessions navigation  
            -> E. Persistent Sessions navigation  
  
F. Advanced harness capabilities are added from measured product needs.  
F. Advanced harness capabilities are added from measured product needs.  
G. Production hardening runs continuously, with release gates after D and E.  
```  
```  
  
This ordering keeps three sources of complexity separate:  
  
1. Tool execution and cancellation.  
1. Tool execution and cancellation.  
2. Model transport, authentication, and protocol parsing.  
3. Workspace mutation and recovery.  
  
The detailed harness plan is embedded below. The project will not reproduce all Pi features up front. It will implement the small stable core now and add sessions, compaction, retry, resume, parallel tools, and additional provider protocols only when a product slice requires them.  
The detailed harness plan is embedded below. The project will not reproduce all Pi features up front. It will implement the small stable core now and add sessions, compaction, retry, resume, parallel tools, and additional provider protocols only when a product slice requires them.  
  
### Immediate next slice  
  
Build **Slice A1: Rust Harness Foundation and Read-Only Agent Loop**.  
Build **Slice A1: Rust Harness Foundation and Read-Only Agent Loop**.  
  
The complete user outcome is:  
  
> A real model running through the Tauri Rust harness can search the selected workspace, show correlated tool activity, read a selected result through the existing root-confined implementation, summarize what it found, and be cancelled without changing any file.  
> A real model running through the Tauri Rust harness can search the selected workspace, show correlated tool activity, read a selected result through the existing root-confined implementation, summarize what it found, and be cancelled without changing any file.  
  
This is the smallest slice that turns the current simulated activity into real IDE behavior while remaining deterministic and read-only.  
This is the smallest slice that turns the current simulated activity into real IDE behavior while remaining deterministic and read-only.  
  
### Roadmap invariants  
  
- Agent code never receives arbitrary filesystem, process, terminal, or Git command access.  
- The Rust workspace and Git modules remain the authority for native operations.  
- Tool requests and results use serializable domain objects, not React callbacks or backend SDK event types.  
- Tool requests and results use serializable domain objects, not React callbacks or backend SDK event types.  
- Every request has a correlation ID and reaches exactly one terminal state: completed, failed, or cancelled.  
- Model SDK or wire types do not cross the Rust harness seam.  
- Model SDK or wire types do not cross the Rust harness seam.  
- The first implementation supports one model protocol and sequential tools.  
- Read-only tools are complete before edit proposal tools are introduced.  
- Preview is complete before apply is introduced.  
- Preview is complete before apply is introduced.  
- Apply is complete with conflict detection and undo before a production backend can mutate files.  
- Browser adapters remain deterministic so the full state machine can be exercised without Tauri or a model backend.  
- Browser adapters remain deterministic so the full state machine can be exercised without Tauri or a model backend.  
  
## Roadmap Slice A: Rust Harness Foundation  
## Roadmap Slice A: Rust Harness Foundation  
  
### Slice A1: Protocol, loop, Search, and Read  
### Slice A1: Protocol, loop, Search, and Read  
  
#### Add  
  
- Search workspace.  
- Search workspace.  
- Read file.  
- One OpenAI-compatible streaming model adapter.  
- One OpenAI-compatible streaming model adapter.  
- Versioned Tauri run commands and events.  
- Versioned Tauri run commands and events.  
- Correlated tool request, activity, result, failure, and cancellation events.  
- Bounded, serializable tool results suitable for transcript persistence.  
- Bounded, serializable tool results suitable for transcript persistence.  
  
#### Reuse  
  
- Existing Rust workspace search and read implementations.  
- Existing Rust workspace search and read implementations.  
- Existing TypeScript `AgentProvider` interface.  
- Existing TypeScript `AgentProvider` interface.  
- Existing Agent activity and cancellation UI.  
- Existing Agent activity and cancellation UI.  
  
#### Interface direction  
#### Interface direction  
  
Introduce one deep Rust harness module at the model-to-product seam. Its interface starts runs, accepts cancellation and approval decisions, and emits versioned domain events. It hides model streaming, tool dispatch, root-confined execution, result bounding, cancellation, error normalization, and exactly-once termination from React.  
Introduce one deep Rust harness module at the model-to-product seam. Its interface starts runs, accepts cancellation and approval decisions, and emits versioned domain events. It hides model streaming, tool dispatch, root-confined execution, result bounding, cancellation, error normalization, and exactly-once termination from React.  
  
Do not add one shallow wrapper per existing provider method. The deletion test should show that removing this module would spread correlation, cancellation, limits, and error handling back across the Agent provider and UI.  
  
#### Acceptance criteria  
  
- A real model prompt triggers a root-confined workspace search through Rust.  
- A real model prompt triggers a root-confined workspace search through Rust.  
- Search activity identifies the query and result count without exposing unrestricted paths.  
- The Agent can read a returned file through `WorkspaceProvider.readFile`.  
- The Agent can read a returned file through `WorkspaceProvider.readFile`.  
- Cancelling during search or read prevents subsequent tool steps and response completion.  
- Cancelling during search or read prevents subsequent tool steps and response completion.  
- Provider errors produce an explicit failed activity and Agent error state.  
- No file, Git index, terminal, or persisted workspace content is mutated.  
- No file, Git index, terminal, or persisted workspace content is mutated.  
- Deterministic and Tauri adapters produce the same domain-level event ordering.  
- Malformed provider streams fail explicitly and still emit only one terminal event.  
- Malformed provider streams fail explicitly and still emit only one terminal event.  
  
#### Validation  
#### Validation  
  
- Unit tests for request validation, event ordering, result limits, cancellation, and errors.  
- Unit tests for request validation, event ordering, result limits, cancellation, and errors.  
- Browser interaction test for the complete prompt-to-result flow.  
- Native smoke test against a temporary selected workspace.  
- Native smoke test against a temporary selected workspace.  
  
### Slice A2: Harness reliability  
  
Add deterministic Rust tests for event ordering, cancellation races, malformed  
Add deterministic Rust tests for event ordering, cancellation races, malformed  
provider streams, bounded results, unknown tools, and exactly-once termination.  
Add credential injection that keeps secrets outside renderer state and persisted  
Add credential injection that keeps secrets outside renderer state and persisted  
transcripts.  
  
### Deferred harness capabilities  
### Deferred harness capabilities  
  
Do not block Slice A on sessions, compaction, steering/follow-up queues, parallel  
Do not block Slice A on sessions, compaction, steering/follow-up queues, parallel  
tool execution, multiple model protocols, extensions, or a general-purpose  
tool execution, multiple model protocols, extensions, or a general-purpose  
shell. Add each only after a concrete workflow and testable interface exists.  
  
## Roadmap Slice B: Read-Only Agent Workspace Tools  
## Roadmap Slice B: Read-Only Agent Workspace Tools  
  
### Slice B1: Git inspection  
### Slice B1: Git inspection  
  
#### Add  
  
- Inspect Git changes.  
  
#### Reuse  
#### Reuse  
  
- `ChangesProvider.getChanges`.  
- `ChangesProvider.getChanges`.  
- Existing working/HEAD content adapters.  
- Existing working/HEAD content adapters.  
- Existing Changes tree and Monaco diff model.  
- Existing Changes tree and Monaco diff model.  
  
#### Acceptance criteria  
#### Acceptance criteria  
  
- The Agent can list current changes and inspect a selected diff.  
- The Agent can list current changes and inspect a selected diff.  
- Git inspection remains read-only.  
- Git inspection remains read-only.  
- Unavailable Git repositories and provider failures are explicit tool outcomes.  
- Unavailable Git repositories and provider failures are explicit tool outcomes.  
- Large content is bounded consistently with workspace reads.  
  
### Exit gate for Slice B  
  
Do not start edit preview until search, read, and Git inspection share one tested correlation and cancellation model, and no UI module calls native commands directly.  
  
## Roadmap Slice C: Edit Preview and Approval  
  
### Add  
### Add  
  
- Proposed-edit domain object.  
- Proposed-edit domain object.  
- Monaco diff preview in `EditorDialog`.  
- Monaco diff preview in `EditorDialog`.  
- Approval linked to the exact proposal.  
- Approval linked to the exact proposal.  
- Continue applies; Skip leaves files unchanged.  
- Continue applies; Skip leaves files unchanged.  
  
The immutable proposal is the handoff from read-only reasoning to preview. It contains the target path, original-content identity, proposed content or edits, explanation, and originating tool/run correlation, but does not write to disk.  
The immutable proposal is the handoff from read-only reasoning to preview. It contains the target path, original-content identity, proposed content or edits, explanation, and originating tool/run correlation, but does not write to disk.  
  
### Reuse  
  
- `MonacoDiffEditor`.  
- `MonacoDiffEditor`.  
- Changes diff inputs.  
- Agent approval UI.  
- Agent approval UI.  
- Centered modal.  
  
### Critical decision  
### Critical decision  
  
Approval must describe the operation being approved. Do not use a generic boolean detached from a specific edit.  
  
### Acceptance criteria  
  
- Every approval references one immutable proposal ID.  
- Every approval references one immutable proposal ID.  
- The modal shows original and proposed content using the existing diff workflow.  
- The modal shows original and proposed content using the existing diff workflow.  
- Dismissing or skipping the proposal leaves the workspace unchanged.  
- Dismissing or skipping the proposal leaves the workspace unchanged.  
- A changed source file invalidates the proposal before approval.  
- A changed source file invalidates the proposal before approval.  
- Transcript and activity state clearly distinguish proposed, approved, skipped, and stale edits.  
  
## Roadmap Slice D: Safe Apply and Undo  
## Roadmap Slice D: Safe Apply and Undo  
  
### Add  
### Add  
  
- Optimistic concurrency check against the original file content or hash.  
- Atomic or guarded write.  
- Transaction record.  
- Transaction record.  
- One-step rollback/undo.  
- Clear failure state when the workspace changed after preview.  
- Clear failure state when the workspace changed after preview.  
  
### Caveat  
  
Git restore is not a sufficient universal undo mechanism. The workspace may not be a repository, and the file may contain pre-existing user changes.  
  
### Acceptance criteria  
### Acceptance criteria  
  
- Apply checks the original content identity immediately before writing.  
- The write is root-confined and cannot partially apply a multi-file transaction.  
- The write is root-confined and cannot partially apply a multi-file transaction.  
- A successful transaction records enough prior content to undo without Git.  
- A successful transaction records enough prior content to undo without Git.  
- Undo only reverts the Agent transaction and preserves unrelated user changes.  
- Undo only reverts the Agent transaction and preserves unrelated user changes.  
- Conflicts and partial failures are visible and recoverable.  
- Conflicts and partial failures are visible and recoverable.  
  
### Release gate  
### Release gate  
  
After Slice D, run the first full Agent safety review: root confinement, symlink behavior, stale proposals, interrupted writes, rollback, cancellation races, and accessibility of approval/error states.  
After Slice D, run the first full Agent safety review: root confinement, symlink behavior, stale proposals, interrupted writes, rollback, cancellation races, and accessibility of approval/error states.  
  
## Roadmap Slice E: Persistent Sessions Navigation  
## Roadmap Slice E: Persistent Sessions Navigation  
  
### Add  
  
- Session list in the primary sidebar or a dedicated Agent view.  
- Session list in the primary sidebar or a dedicated Agent view.  
- Create.  
- Create.  
- Select.  
- Select.  
- Rename.  
- Rename.  
- Archive.  
- Archive.  
- Resume.  
- Resume.  
- Completed conversation persistence.  
- Completed conversation persistence.  
  
### Reuse  
### Reuse  
  
- `WorkbenchTree` where its hierarchical semantics fit.  
- Existing reference Agents Window behavior.  
- Existing reference Agents Window behavior.  
- Versioned persistence migration.  
- Versioned persistence migration.  
  
### Caveat  
  
Do not persist in-flight callbacks, tool handles, or approval closures. Persist a serializable event/conversation model.  
  
### Acceptance criteria  
### Acceptance criteria  
  
- Creating, selecting, renaming, and archiving sessions works without changing shell topology.  
- Creating, selecting, renaming, and archiving sessions works without changing shell topology.  
- Completed transcripts, activities, proposals, approvals, and errors restore from versioned state.  
- In-flight runs restore as interrupted, never as falsely active.  
- In-flight runs restore as interrupted, never as falsely active.  
- Selecting a session restores its editor/modal context only when that state is safe and serializable.  
- Migration tests cover every persisted schema version.  
  
## Roadmap Slice F: Advanced Harness Capabilities  
## Roadmap Slice F: Advanced Harness Capabilities  
  
Add capabilities individually, behind internal seams, when product evidence  
requires them:  
requires them:  
  
- Additional model protocols.  
- Retry and reconnect.  
- Durable conversation resume.  
- Context compaction.  
- Context compaction.  
- Steering and follow-up queues.  
- Steering and follow-up queues.  
- Parallel execution for independently safe read-only tools.  
- Parallel execution for independently safe read-only tools.  
- Usage and cost metadata.  
- Usage and cost metadata.  
  
Do not add Pi compatibility, a plugin system, CLI/TUI, or unrestricted shell and  
filesystem tools as default goals.  
filesystem tools as default goals.  
  
## Roadmap Slice G: Production Hardening  
  
### Continuous track  
### Continuous track  
  
- Automated provider and tool-execution tests.  
- Component and interaction tests.  
- Component and interaction tests.  
- Screenshot fixtures.  
- Screenshot fixtures.  
- Error notifications.  
- Error notifications.  
- Performance budgets.  
- Performance budgets.  
- Accessibility audit and configurable announcement verbosity.  
- Accessibility audit and configurable announcement verbosity.  
  
### Before the Slice D release gate  
  
- Tighten CSP.  
- Add file watching needed for proposal invalidation.  
- Add file watching needed for proposal invalidation.  
- Add search cancellation.  
- Add search cancellation.  
- Improve the Git state model for rename, conflict, and untracked-file cases.  
  
### Before the Slice E release gate  
  
- Cross-platform shell selection.  
- Crash-safe terminal cleanup.  
- Crash-safe terminal cleanup.  
- Search indexing if measured workspace performance requires it.  
- Search indexing if measured workspace performance requires it.  
- Persistence migration and corruption recovery tests.  
- Persistence migration and corruption recovery tests.  
- Native packaging, update, and recovery validation.  
  
## 17. How Another Agent Should Continue  
## 17. How Another Agent Should Continue  
  
### Step 1: Establish the exact slice  
  
Describe one complete user outcome, not a list of files.  
  
Good:  
Good:  
  
> An Agent can search the selected workspace, show the searched files as activity, and be cancelled without applying changes.  
> An Agent can search the selected workspace, show the searched files as activity, and be cancelled without applying changes.  
  
Weak:  
Weak:  
  
> Add tools and refactor providers.  
  
### Step 2: Map reuse before coding  
  
Inspect:  
Inspect:  
  
- Existing provider interfaces.  
- Current feature modules.  
- Current feature modules.  
- `src/ui/index.ts`.  
- `src/ui/index.ts`.  
- `WorkbenchController`.  
- `WorkbenchLayout`.  
- Native command registration.  
- Native command registration.  
  
Do not duplicate workspace, Git, dialog, tab, or tree behavior.  
Do not duplicate workspace, Git, dialog, tab, or tree behavior.  
  
### Step 3: Define the seam  
  
Write the smallest domain interface that can support:  
Write the smallest domain interface that can support:  
  
- Deterministic browser implementation.  
- Deterministic browser implementation.  
- Native implementation.  
- Error behavior.  
- Error behavior.  
- Cancellation if needed.  
  
### Step 4: Implement deterministic behavior first  
### Step 4: Implement deterministic behavior first  
  
Use reproducible data and event order. This makes the UI debuggable without native/backend variability.  
Use reproducible data and event order. This makes the UI debuggable without native/backend variability.  
  
### Step 5: Build the complete UI state machine  
### Step 5: Build the complete UI state machine  
  
Cover:  
Cover:  
  
- Idle.  
- Idle.  
- Running/loading.  
- Success.  
- Success.  
- Empty.  
- Empty.  
- Error.  
- Error.  
- Cancelled.  
- Cancelled.  
- Approval or destructive confirmation.  
- Approval or destructive confirmation.  
  
### Step 6: Add native capability narrowly  
  
Expose explicit commands rather than a general-purpose escape hatch.  
  
### Step 7: Complete accessibility before validation  
  
Keyboard, focus, labels, announcements, and dismissal are part of the feature, not follow-up work.  
Keyboard, focus, labels, announcements, and dismissal are part of the feature, not follow-up work.  
  
### Step 8: Validate and inspect  
  
Build, run the focused native checks, exercise the workflow in browser/Tauri, and inspect the Git diff.  
Build, run the focused native checks, exercise the workflow in browser/Tauri, and inspect the Git diff.  
  
### Step 9: Extract only proven common behavior  
  
If a new feature repeats a pattern, compare semantics before creating a primitive. Update `src/ui/index.ts` only when the abstraction is stable and genuinely reusable.  
  
### Step 10: Record the slice  
  
Update this guide or the README with:  
Update this guide or the README with:  
  
- User outcome.  
- User outcome.  
- New dependencies.  
- New adapter/API.  
- Security boundary.  
- Security boundary.  
- Accessibility behavior.  
- Caveats.  
- Validation performed.  
  
## 18. Architecture Summary  
## 18. Architecture Summary  
  
```text  
```text  
App  
App  
  -> WorkbenchController  
       -> chooses providers/adapters  
       -> owns cross-feature state  
       -> owns cross-feature state  
       -> registers commands  
       -> loads/saves persistence  
       -> loads/saves persistence  
       -> composes layout slots  
  
  -> WorkbenchLayout  
  -> WorkbenchLayout  
       -> titlebar  
       -> titlebar  
       -> primary sidebar: Explorer or Search  
       -> main: Agent Chat  
       -> secondary sidebar: Changes  
       -> secondary sidebar: Changes  
       -> panel: Terminal  
       -> panel: Terminal  
       -> overlays: Command Center, Editor Dialog, Help  
       -> announcement surface  
  
Feature modules  
  -> consume UI primitives  
  -> consume UI primitives  
  -> consume domain providers  
  -> do not invoke Tauri directly  
  -> do not invoke Tauri directly  
  
TypeScript adapters  
TypeScript adapters  
  -> deterministic browser implementation  
  -> deterministic browser implementation  
  -> Tauri invoke/event implementation  
  
Rust host  
Rust host  
  -> root-confined workspace operations  
  -> bounded search  
  -> root-scoped Git  
  -> PTY process management  
  -> PTY process management  
  -> Tauri window and plugin integration  
```  
```  
  
## 19. Final Lessons  
  
1. **Recreate contracts, not coupled runtime code.**    
   The visual and interaction quality of VS Code can be reproduced without importing its entire service graph.  
   The visual and interaction quality of VS Code can be reproduced without importing its entire service graph.  
  
2. **Build workflows before libraries.**    
   Explorer and Changes taught us what the shared tree needed to be.  
   Explorer and Changes taught us what the shared tree needed to be.  
  
3. **Keep native capability behind narrow adapters.**    
3. **Keep native capability behind narrow adapters.**    
   This improves security, testing, and portability.  
   This improves security, testing, and portability.  
  
4. **Separate topology from orchestration.**    
   `WorkbenchLayout` makes arrangement flexible because feature state stays elsewhere.  
   `WorkbenchLayout` makes arrangement flexible because feature state stays elsewhere.  
  
5. **Treat accessibility as state-machine design.**    
5. **Treat accessibility as state-machine design.**    
   Focus entry, containment, dismissal, restoration, and announcements are fundamental transitions.  
  
6. **Use deterministic providers to prove difficult UX.**    
6. **Use deterministic providers to prove difficult UX.**    
   Streaming, cancellation, and approval can be designed before a model backend exists.  
   Streaming, cancellation, and approval can be designed before a model backend exists.  
  
7. **Preview and approval are not enough without safe application.**    
7. **Preview and approval are not enough without safe application.**    
   The next important milestone is an edit transaction with conflict detection and undo.  
   The next important milestone is an edit transaction with conflict detection and undo.  
  
8. **Persist stable meaning, not runtime objects.**    
   Layouts and conversations survive restarts; PTYs and in-flight callbacks do not.  
  
9. **A high-quality IDE is the composition of small reliable contracts.**    
9. **A high-quality IDE is the composition of small reliable contracts.**    
   Tokens, trees, tabs, editor inputs, providers, layouts, and native commands become valuable when their ownership boundaries remain clear.  
