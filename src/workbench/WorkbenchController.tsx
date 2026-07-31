// Everything that is not topology: which providers are in use, what the
// commands do, what is persisted, and which feature renders into which slot.
// Geometry lives in WorkbenchLayout — this file never sets a width.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { createChangesProvider } from '../changes';
import { buildCommands } from '../commands/commandRegistry';
import { EditorWorkbench, isDirty, type EditorInput } from '../editor/EditorWorkbench';
import { ChangesView } from '../features/changes/ChangesView';
import { CommandCenter } from '../features/commandCenter/CommandCenter';
import { ExplorerTree } from '../features/explorer/ExplorerTree';
import { SearchView } from '../features/search/SearchView';
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

	const provider = useMemo(() => createWorkspaceProvider(), []);
	const changesProvider = useMemo(() => createChangesProvider(), []);
	const terminalAdapter = useMemo(() => createTerminalAdapter(), []);
	const [selection, setSelection] = useState<WorkspaceSelection | undefined>(undefined);
	const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
	const [inputs, setInputs] = useState<readonly EditorInput[]>([]);
	const [activeEditorId, setActiveEditorId] = useState<string | undefined>(undefined);
	const [pendingCloseId, setPendingCloseId] = useState<string | undefined>(undefined);

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
			if (!provider.canChooseWorkspace) {
				// Browser mode: the fixture workspace is always "selected".
				setSelection({ label: 'Fixture', path: '' });
			} else if (restored?.workspace) {
				try {
					const workspace = await provider.restoreWorkspace(restored.workspace.path);
					if (cancelled) {
						return;
					}
					setSelection(workspace);
				} catch {
					return; // The folder moved or is gone; start with none.
				}
			} else {
				return;
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
	}, [provider, restored]);

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

	const openFolder = useCallback(async () => {
		const chosen = await provider.chooseWorkspace();
		if (!chosen) {
			return;
		}
		// Editor ids are relative to the old root, so they cannot survive.
		// Switching is blocked while anything is dirty, so nothing is lost.
		setInputs([]);
		setActiveEditorId(undefined);
		setSelection(chosen);
	}, [provider]);

	const openFile = useCallback(
		async (id: string, revealLine?: number) => {
			setActiveEditorId(id);
			// Already open: keep any unsaved edits, but honour a new target
			// line — that is the whole point of opening a search result.
			if (inputs.some((input) => input.id === id)) {
				if (revealLine !== undefined) {
					setInputs((current) =>
						current.map((input) =>
							input.id === id && input.kind === 'source' ? { ...input, revealLine } : input
						)
					);
				}
				return;
			}
			const file = await provider.readFile(id);
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
		},
		[inputs, provider]
	);

	// Diffs share the editor's tab strip but live in their own id space, so a
	// file and its diff can be open at the same time without colliding.
	const openDiff = useCallback(
		async (id: string) => {
			const diffId = `diff:${id}`;
			setActiveEditorId(diffId);
			const diff = await changesProvider.getDiff(id);
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
		},
		[changesProvider]
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
			const index = current.findIndex((input) => input.id === id);
			const next = current.filter((input) => input.id !== id);
			// Closing the active tab selects its neighbour rather than nothing.
			setActiveEditorId((active) =>
				active === id ? (next[index] ?? next[index - 1])?.id : active
			);
			return next;
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
		const state: PersistedState = {
			...layout,
			primaryView,
			workspace: selection,
			editors: inputs
				.filter((input) => input.kind === 'source')
				.map((input) => ({
					id: input.id,
					name: input.name,
					...(isDirty(input) ? { content: input.content } : {}),
				})),
			activeEditorId,
		};
		persistence.save(state);
	}, [persistence, layout, primaryView, selection, inputs, activeEditorId]);

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
				openFolder: provider.canChooseWorkspace && !dirty ? () => void openFolder() : undefined,
				showAccessibilityHelp: () => setHelpOpen(true),
			}),
		[
			toggle,
			showPrimaryView,
			closeEditor,
			saveFile,
			activeEditorId,
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
			main={
				<EditorWorkbench
					inputs={inputs}
					activeId={activeEditorId}
					onSelect={setActiveEditorId}
					onClose={closeEditor}
					onChange={editFile}
				/>
			}
			secondarySidebar={
				<Pane title="Changes">
					<ChangesView
						provider={changesProvider}
						activeDiffId={activeEditorId?.startsWith('diff:') ? activeEditorId : undefined}
						onOpenDiff={(id) => void openDiff(id)}
					/>
				</Pane>
			}
			panel={<TerminalPanel adapter={terminalAdapter} cwd={selection?.path || undefined} />}
			overlays={
				<>
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
