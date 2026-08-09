// Everything that is not topology: which providers are in use, what the
// commands do, what is persisted, and which feature renders into which slot.
// Geometry lives in WorkbenchLayout — this file never sets a width.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { createAgentProvider, loadProfileFiles } from '../agent';
import { createChangesProvider } from '../changes';
import { buildCommands } from '../commands/commandRegistry';
import { EditorDialog } from '../editor/EditorDialog';
import { isDirty, type EditorInput } from '../editor/EditorWorkbench';
import { neighbourId } from '../ids';
import { AgentChat } from '../features/agent/AgentChat';
import { ChangesView } from '../features/changes/ChangesView';
import { CommandCenter } from '../features/commandCenter/CommandCenter';
import { ExplorerTree } from '../features/explorer/ExplorerTree';
import { SearchView } from '../features/search/SearchView';
import { refuseReason, type Replacement } from '../features/search/replace';
import { TerminalPanel } from '../features/terminal/TerminalPanel';
import { createPersistenceAdapter, type PersistedState, type PrimaryView } from '../persistence';
import { createTerminalAdapter } from '../terminal';
import { ActionBar, IconButton, Pane } from '../ui';
import {
	createWorkspaceProvider,
	type WorkspaceEntry,
	type WorkspaceSelection,
} from '../workspace';
import { AccessibilityHelp } from './AccessibilityHelp';
import { ConfirmDiscard } from './ConfirmDiscard';
import { Titlebar } from './Titlebar';
import {
	DEFAULT_LAYOUT,
	WorkbenchLayout,
	type WorkbenchLayoutState,
	type WorkbenchRegion,
} from './WorkbenchLayout';
import { useWindowControls } from './useWindowControls';

// Rust rejections arrive as strings, not Errors, so both shapes are read.
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function WorkbenchController() {
	const controls = useWindowControls();

	// Read once, synchronously: layout that arrives after the first paint
	// shows the user the default and then snaps, which reads as a glitch.
	const persistence = useMemo(() => createPersistenceAdapter(), []);
	const restored = useMemo(() => persistence.load(), [persistence]);

	// The persisted geometry fields are exactly WorkbenchLayoutState, so the
	// refactor did not touch the storage schema.
	const [layout, setLayout] = useState<WorkbenchLayoutState>(() =>
		restored
			? {
					visible: restored.visible,
					primaryWidth: restored.primaryWidth,
					secondaryWidth: restored.secondaryWidth,
					panelHeight: restored.panelHeight,
				}
			: DEFAULT_LAYOUT
	);
	const [primaryView, setPrimaryView] = useState<PrimaryView>(restored?.primaryView ?? 'explorer');
	const [helpOpen, setHelpOpen] = useState(false);
	const [commandCenterOpen, setCommandCenterOpen] = useState(false);
	/*
	 * The editor is a transient surface over the workbench, not a region and not
	 * layout: it is never persisted, so a session always reopens on Agent Chat
	 * with the editor closed. The tabs behind it are persisted as they always
	 * were, so dismissing loses nothing.
	 */
	const [editorOpen, setEditorOpen] = useState(false);
	/*
	 * Announcements carry a sequence number because a live region only reacts to
	 * a mutation: two runs that both end in "Agent finished" would set identical
	 * text, and the second would be announced to nobody. The counter replaces the
	 * node instead of rewriting it.
	 */
	const [announcement, setAnnouncement] = useState({ seq: 0, message: '' });
	const announce = useCallback(
		(message: string) => setAnnouncement((current) => ({ seq: current.seq + 1, message })),
		[]
	);

	const provider = useMemo(() => createWorkspaceProvider(), []);
	const agentProvider = useMemo(() => createAgentProvider(), []);
	const changesProvider = useMemo(() => createChangesProvider(), []);
	const terminalAdapter = useMemo(() => createTerminalAdapter(), []);
	const [selection, setSelection] = useState<WorkspaceSelection | undefined>(undefined);
	const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
	const [inputs, setInputs] = useState<readonly EditorInput[]>([]);
	const [activeEditorId, setActiveEditorId] = useState<string | undefined>(undefined);
	const [pendingCloseId, setPendingCloseId] = useState<string | undefined>(undefined);
	/*
	 * The save effect below must not run before the async restore has put the
	 * restored state back: on mount `selection` is undefined and `inputs` is
	 * empty, and writing that out erases the record being restored.
	 */
	const [hydrated, setHydrated] = useState(false);
	/*
	 * A root that could not be restored — a disconnected drive, or a browser
	 * handle that cannot be re-granted without a gesture. The session carries on
	 * without it, but its record is held here and written back untouched, since
	 * it may well be reachable next launch and overwriting it forgets the folder
	 * and its editors permanently. Superseded as soon as a root is chosen.
	 */
	const [unrestored, setUnrestored] = useState<PersistedState | undefined>(undefined);

	/*
	 * Restore the workspace, then the editors that lived in it. The order
	 * matters: reading a file needs the root to be selected first. A file that
	 * has since moved or been deleted is dropped rather than failing the whole
	 * restore, and a dirty editor keeps its unsaved text while its `saved`
	 * baseline comes from what is on disk now.
	 */
	useEffect(() => {
		let cancelled = false;
		async function start(): Promise<void> {
			// Whether a folder can be *chosen* says nothing about whether one is
			// already available: the browser can now do both.
			let workspace = provider.defaultWorkspace;
			if (restored?.workspace) {
				try {
					workspace = await provider.restoreWorkspace();
				} catch {
					// Gone, or a browser handle that cannot be re-granted
					// without a gesture. Fall back to whatever exists by
					// default — nothing natively, the fixture in the browser —
					// and keep the record rather than writing over it.
					setUnrestored(restored);
				}
			}
			if (cancelled) {
				return;
			}
			// Whatever the session has is now the truth, including having no
			// root at all. Saving before this point writes an empty state over
			// the record being restored.
			setHydrated(true);
			if (!workspace) {
				return;
			}
			setSelection(workspace);

			/*
			 * Profiles, now that there is a root to read the project file from.
			 * Never fails: a missing file is the normal state and a malformed one
			 * is reported here rather than costing anyone their editors. The
			 * announcement is the only channel — a profile that silently did not
			 * load looks exactly like a profile that did nothing.
			 */
			const loaded = await loadProfileFiles();
			if (loaded.problems.length > 0) {
				// One announcement, not one per problem: a live region only
				// reacts to the latest mutation, so announcing in a loop would
				// leave a screen-reader user hearing the last problem and no
				// hint that there were others.
				announce(`Profiles: ${loaded.problems.join('. ')}`);
			}

			const reopened: EditorInput[] = [];
			for (const editor of restored?.editors ?? []) {
				try {
					const file = await provider.readFile(editor.id);
					reopened.push({
						kind: 'source',
						id: file.id,
						name: file.name,
						content: editor.content ?? file.content,
						saved: file.content,
					});
				} catch {
					// Gone since last session.
				}
			}
			if (cancelled) {
				return;
			}
			setInputs(reopened);
			setActiveEditorId(
				reopened.some((input) => input.id === restored?.activeEditorId)
					? restored?.activeEditorId
					: reopened[0]?.id
			);
		}
		void start();
		return () => {
			cancelled = true;
		};
	}, [announce, provider, restored]);

	// The tree belongs to the selected root, so it is reloaded with it.
	useEffect(() => {
		if (!selection) {
			setEntries([]);
			return;
		}
		// The change set belongs to the root too: until one is chosen there is
		// no repository to ask.
		changesProvider.refresh();
		let cancelled = false;
		void provider.getTree().then((tree) => {
			if (!cancelled) {
				setEntries(tree);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [changesProvider, provider, selection]);

	const dirty = inputs.some(isDirty);

	/*
	 * The paths `@` completes over — ticket 27. The tree the explorer already
	 * draws, filtered to files, so a mention can only name something that exists
	 * and the chat never needs a workspace provider of its own. It reloads with
	 * the root, which is what makes the list right after a folder switch.
	 */
	const fileIds = useMemo(
		() => entries.filter((entry) => entry.kind === 'file').map((entry) => entry.id),
		[entries]
	);

	// Closing the last tab leaves the dialog with nothing to show, so it is
	// dismissed rather than left sitting empty over the agent.
	useEffect(() => {
		if (inputs.length === 0) {
			setEditorOpen(false);
		}
	}, [inputs.length]);

	const openFolder = useCallback(async () => {
		// Switching roots discards every editor, so the guard lives here and not
		// only on the controls that offer it. Callers may be disabled; this is
		// what makes the operation itself safe.
		if (dirty) {
			return;
		}
		const chosen = await provider.chooseWorkspace();
		if (!chosen) {
			return;
		}
		// Editor ids are relative to the old root, so they cannot survive.
		// Switching is blocked while anything is dirty, so nothing is lost.
		setInputs([]);
		setActiveEditorId(undefined);
		setSelection(chosen);
		// A deliberate choice supersedes a root that failed to restore: the
		// user has answered the question the held record was waiting on.
		setUnrestored(undefined);
	}, [dirty, provider]);

	const openFile = useCallback(
		async (id: string, revealLine?: number) => {
			// Already open: keep any unsaved edits, but honour a new target
			// line — that is the whole point of opening a search result.
			if (inputs.some((input) => input.id === id)) {
				setActiveEditorId(id);
				setEditorOpen(true);
				if (revealLine !== undefined) {
					setInputs((current) =>
						current.map((input) =>
							input.id === id && input.kind === 'source' ? { ...input, revealLine } : input
						)
					);
				}
				return;
			}
			// Same rule as openDiff: a file the workspace refuses is reported,
			// not silently nothing-happened.
			let file;
			try {
				file = await provider.readFile(id);
			} catch (error) {
				announce(`Could not open ${id}. ${reason(error)}`);
				return;
			}
			setInputs((current) =>
				current.some((input) => input.id === id)
					? current
					: [
							...current,
							{
								kind: 'source',
								id: file.id,
								name: file.name,
								content: file.content,
								saved: file.content,
								revealLine,
							},
						]
			);
			/*
			 * Activated and raised only once the file is in state, and in that
			 * order. Selecting an id the inputs do not contain yet leaves a
			 * render with no active input at all, which unmounts the editor and
			 * remounts it a moment later — throwing away the Monaco instance,
			 * its models, and any focus just placed in it.
			 */
			setActiveEditorId(id);
			setEditorOpen(true);
		},
		[announce, inputs, provider]
	);

	// Diffs share the editor's tab strip but live in their own id space, so a
	// file and its diff can be open at the same time without colliding.
	const openDiff = useCallback(
		async (id: string) => {
			const diffId = `diff:${id}`;
			/*
			 * A refused diff has to say so. Rust reports a file it will not read
			 * — outside the workspace, a symlink, over the size cap — as an
			 * error rather than as empty content, precisely so this does not
			 * render as a diff deleting the whole file. Swallowing it here would
			 * put the silence back one layer down.
			 */
			let diff;
			try {
				diff = await changesProvider.getDiff(id);
			} catch (error) {
				announce(`Could not open the diff for ${id}. ${reason(error)}`);
				return;
			}
			const input: EditorInput = {
				kind: 'diff',
				id: diffId,
				name: diff.name,
				original: diff.original,
				modified: diff.modified,
			};
			// A diff has no unsaved state, so re-opening one that is already
			// there replaces it: that is how a stale diff picks up a save.
			setInputs((current) =>
				current.some((existing) => existing.id === diffId)
					? current.map((existing) => (existing.id === diffId ? input : existing))
					: [...current, input]
			);
			// Same ordering rule as openFile: never select an id the inputs do
			// not have yet.
			setActiveEditorId(diffId);
			setEditorOpen(true);
		},
		[announce, changesProvider]
	);

	/*
	 * Ticket 30's preview: a planned replacement, as a diff, in the editor that
	 * already renders diffs.
	 *
	 * Its own id space — `replace:` beside `diff:` — so a file, its git diff and
	 * its proposed replacement can all be open at once without one replacing
	 * another. Nothing is written by opening it; the tab is a picture.
	 */
	const openReplacePreview = useCallback((plan: Replacement) => {
		const input: EditorInput = {
			kind: 'diff',
			id: `replace:${plan.id}`,
			name: plan.name,
			original: plan.original,
			modified: plan.modified,
		};
		setInputs((current) =>
			current.some((existing) => existing.id === input.id)
				? current.map((existing) => (existing.id === input.id ? input : existing))
				: [...current, input]
		);
		setActiveEditorId(input.id);
		setEditorOpen(true);
	}, []);

	/**
	 * Write the planned replacements, and report what was refused.
	 *
	 * Here rather than in `SearchView` because this is the only thing that knows
	 * which files are open and which are dirty, and both halves of the safety
	 * rule are about that. Sequential rather than parallel: a report that says
	 * which files were skipped is worth more than a faster write, and the writes
	 * are a handful.
	 *
	 * **A refusal is never a partial write.** Each file is re-read, checked and
	 * written on its own, so a file that fails leaves the others correct and is
	 * named in the report rather than rolling anything back — there is nothing
	 * to roll back to that the git checkpoint does not already hold.
	 */
	const applyReplacements = useCallback(
		async (plans: readonly Replacement[]): Promise<string> => {
			const refused: string[] = [];
			const written: string[] = [];
			for (const plan of plans) {
				const open = inputs.find((input) => input.id === plan.id);
				let current: string | undefined;
				try {
					current = (await provider.readFile(plan.id)).content;
				} catch {
					current = undefined;
				}
				const refusal = refuseReason(plan, current, open !== undefined && isDirty(open));
				if (refusal) {
					refused.push(refusal);
					continue;
				}
				try {
					await provider.writeFile(plan.id, plan.modified);
				} catch (error) {
					refused.push(`${plan.id}: ${reason(error)}`);
					continue;
				}
				written.push(plan.id);
				// An open editor showing the old text would be a second copy of the
				// file that disagrees with disk — and saving it would undo the
				// replacement. It is clean, so both sides move together and it stays
				// clean.
				setInputs((currentInputs) =>
					currentInputs.map((input) =>
						input.id === plan.id && input.kind === 'source'
							? { ...input, content: plan.modified, saved: plan.modified }
							: input
					)
				);
			}
			if (written.length > 0) {
				changesProvider.refresh();
			}
			const report = [
				written.length === 0
					? 'Nothing was written.'
					: `Replaced in ${written.length} file${written.length === 1 ? '' : 's'}.`,
				...refused,
			].join(' ');
			announce(report);
			return report;
		},
		[announce, changesProvider, inputs, provider]
	);

	const editFile = useCallback((id: string, content: string) => {
		setInputs((current) =>
			current.map((input) =>
				input.id === id && input.kind === 'source' ? { ...input, content } : input
			)
		);
	}, []);

	const saveFile = useCallback(
		async (id: string) => {
			const input = inputs.find((item) => item.id === id);
			if (!input || input.kind !== 'source' || !isDirty(input)) {
				return;
			}
			const { content } = input;
			await provider.writeFile(id, content);
			// Mark the written text as the new baseline, not the text as it is
			// now — the user may have typed more while the write was in flight.
			setInputs((current) =>
				current.map((item) =>
					item.id === id && item.kind === 'source' ? { ...item, saved: content } : item
				)
			);
			// The working tree just moved and nothing watches the filesystem, so
			// the Changes view is told directly.
			changesProvider.refresh();
		},
		[changesProvider, inputs, provider]
	);

	const forceCloseEditor = useCallback((id: string) => {
		setInputs((current) => {
			// Closing the active tab selects its neighbour rather than nothing.
			setActiveEditorId((active) => (active === id ? neighbourId(current, id) : active));
			return current.filter((input) => input.id !== id);
		});
	}, []);

	const closeEditor = useCallback(
		(id: string) => {
			const input = inputs.find((item) => item.id === id);
			if (input && isDirty(input)) {
				setPendingCloseId(id);
				return;
			}
			forceCloseEditor(id);
		},
		[inputs, forceCloseEditor]
	);

	/*
	 * Persist stable user state on every change. Dirty text is written out;
	 * clean editors keep only their identity, since the file itself is the
	 * record. Live terminals, modal visibility, and focus are deliberately
	 * absent — restoring their shape without their substance is worse than
	 * starting fresh.
	 */
	useEffect(() => {
		if (!hydrated) {
			return;
		}
		const state: PersistedState = {
			...layout,
			primaryView,
			// Geometry always belongs to this session. The workspace and its
			// editors still belong to the last one until the root it named is
			// either restored or replaced.
			...(unrestored
				? {
						workspace: unrestored.workspace,
						editors: unrestored.editors,
						activeEditorId: unrestored.activeEditorId,
					}
				: {
						workspace: selection,
						editors: inputs
							.filter((input) => input.kind === 'source')
							.map((input) => ({
								id: input.id,
								name: input.name,
								...(isDirty(input) ? { content: input.content } : {}),
							})),
						activeEditorId,
					}),
		};
		persistence.save(state);
	}, [hydrated, unrestored, persistence, layout, primaryView, selection, inputs, activeEditorId]);

	const toggle = useCallback((region: WorkbenchRegion) => {
		setLayout((current) => ({
			...current,
			visible: { ...current.visible, [region]: !current.visible[region] },
		}));
	}, []);

	// Switching the primary view also reveals it: a view the user just asked
	// for that stays hidden looks like the command did nothing.
	const showPrimaryView = useCallback((view: PrimaryView) => {
		setPrimaryView(view);
		setLayout((current) => ({
			...current,
			visible: { ...current.visible, primarySidebar: true },
		}));
	}, []);

	const closeHelp = useCallback(() => setHelpOpen(false), []);
	const closeCommandCenter = useCallback(() => setCommandCenterOpen(false), []);

	const commands = useMemo(
		() =>
			buildCommands({
				togglePrimarySidebar: () => toggle('primarySidebar'),
				toggleSecondarySidebar: () => toggle('secondarySidebar'),
				togglePanel: () => toggle('panel'),
				closeActiveEditor: () => {
					if (activeEditorId) {
						closeEditor(activeEditorId);
					}
				},
				saveActiveEditor: () => {
					if (activeEditorId) {
						void saveFile(activeEditorId);
					}
				},
				showExplorer: () => showPrimaryView('explorer'),
				showSearch: () => showPrimaryView('search'),
				// Reopening is only meaningful with something to reopen, and an
				// empty modal over the agent is worse than no modal.
				showEditor: () => setEditorOpen(true),
				showEditorDisabled: inputs.length === 0 ? 'No open editors' : undefined,
				// The command exists wherever the capability does. Unsaved work
				// blocks it — switching roots drops every editor — but it stays
				// in the palette saying so rather than disappearing.
				openFolder: provider.canChooseWorkspace ? () => void openFolder() : undefined,
				openFolderDisabled: dirty ? 'Save your changes first' : undefined,
				showAccessibilityHelp: () => setHelpOpen(true),
			}),
		[
			toggle,
			showPrimaryView,
			closeEditor,
			saveFile,
			activeEditorId,
			inputs,
			provider,
			dirty,
			openFolder,
		]
	);

	/*
	 * Ctrl+Shift+P is bound on the capture phase because Monaco claims the same
	 * chord for its own palette. Capturing means the workbench decides first;
	 * without it the shortcut silently does nothing whenever the editor has
	 * focus, which is most of the time.
	 */
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent): void {
			if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
				event.preventDefault();
				event.stopPropagation();
				setCommandCenterOpen(true);
			}
		}
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, []);

	// Ctrl+S likewise: capture, so the WebView's own save never appears.
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent): void {
			if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 's') {
				event.preventDefault();
				event.stopPropagation();
				if (activeEditorId) {
					void saveFile(activeEditorId);
				}
			}
		}
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, [activeEditorId, saveFile]);

	return (
		<WorkbenchLayout
			state={layout}
			onChange={setLayout}
			titlebar={
				<Titlebar
					title="ADE"
					controls={controls}
					actions={
						<>
							<IconButton
								icon="edit"
								label={inputs.length === 0 ? 'Show editor (no open editors)' : 'Show editor'}
								disabled={inputs.length === 0}
								onClick={() => setEditorOpen(true)}
							/>
							<IconButton
								icon="layout-sidebar-left"
								label="Toggle primary sidebar"
								pressed={layout.visible.primarySidebar}
								onClick={() => toggle('primarySidebar')}
							/>
							<IconButton
								icon="layout-panel"
								label="Toggle panel"
								pressed={layout.visible.panel}
								onClick={() => toggle('panel')}
							/>
							<IconButton
								icon="layout-sidebar-right"
								label="Toggle secondary sidebar"
								pressed={layout.visible.secondarySidebar}
								onClick={() => toggle('secondarySidebar')}
							/>
							<IconButton
								icon="question"
								label="Keyboard help"
								onClick={() => setHelpOpen(true)}
							/>
						</>
					}
				/>
			}
			primarySidebar={
				<Pane
					title={
						primaryView === 'search'
							? 'Search'
							: selection
								? `Explorer — ${selection.label}`
								: 'Explorer'
					}
					actions={
						<ActionBar label="Primary sidebar views">
							<IconButton
								icon="files"
								label="Show Explorer"
								pressed={primaryView === 'explorer'}
								onClick={() => setPrimaryView('explorer')}
							/>
							<IconButton
								icon="search"
								label="Show Search"
								pressed={primaryView === 'search'}
								onClick={() => setPrimaryView('search')}
							/>
							{provider.canChooseWorkspace ? (
								<IconButton
									icon="folder-opened"
									label={dirty ? 'Open folder (save your changes first)' : 'Open folder'}
									disabled={dirty}
									onClick={() => void openFolder()}
								/>
							) : null}
						</ActionBar>
					}
				>
					{primaryView === 'search' ? (
						<SearchView
							provider={provider}
							onOpenResult={(id, line) => void openFile(id, line)}
							onPreviewReplace={openReplacePreview}
							onApplyReplace={applyReplacements}
						/>
					) : (
						<ExplorerTree
							entries={entries}
							activeId={activeEditorId}
							onOpenFile={(entry) => void openFile(entry.id)}
							onOpenFolder={
								provider.canChooseWorkspace && !selection
									? () => void openFolder()
									: undefined
							}
						/>
					)}
				</Pane>
			}
			main={<AgentChat provider={agentProvider} files={fileIds} onAnnounce={announce} />}
			announcement={<span key={announcement.seq}>{announcement.message}</span>}
			secondarySidebar={
				<Pane title="Changes">
					<ChangesView
						provider={changesProvider}
						activeDiffId={activeEditorId?.startsWith('diff:') ? activeEditorId : undefined}
						onOpenDiff={(id) => void openDiff(id)}
					/>
				</Pane>
			}
			panel={<TerminalPanel adapter={terminalAdapter} />}
			overlays={
				<>
					<EditorDialog
						open={editorOpen}
						inputs={inputs}
						activeId={activeEditorId}
						onSelect={setActiveEditorId}
						onCloseEditor={closeEditor}
						onChange={editFile}
						onDismiss={() => setEditorOpen(false)}
					/>
					<CommandCenter
						open={commandCenterOpen}
						commands={commands}
						files={entries}
						onOpenFile={(entry) => void openFile(entry.id)}
						onClose={closeCommandCenter}
					/>
					<ConfirmDiscard
						name={inputs.find((input) => input.id === pendingCloseId)?.name}
						onCancel={() => setPendingCloseId(undefined)}
						onDiscard={() => {
							if (pendingCloseId) {
								forceCloseEditor(pendingCloseId);
							}
							setPendingCloseId(undefined);
						}}
						onSave={() => {
							const id = pendingCloseId;
							setPendingCloseId(undefined);
							if (id) {
								// Only close once the write succeeded; a failed save
								// that still closed the tab would lose the edit.
								void saveFile(id).then(() => forceCloseEditor(id));
							}
						}}
					/>
					<AccessibilityHelp open={helpOpen} onClose={closeHelp} />
				</>
			}
		/>
	);
}
