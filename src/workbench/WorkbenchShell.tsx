import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createChangesProvider } from '../changes';
import { buildCommands } from '../commands/commandRegistry';
import { EditorWorkbench, isDirty, type EditorInput } from '../editor/EditorWorkbench';
import { ChangesView } from '../features/changes/ChangesView';
import { CommandCenter } from '../features/commandCenter/CommandCenter';
import { ExplorerTree } from '../features/explorer/ExplorerTree';
import { TerminalPanel } from '../features/terminal/TerminalPanel';
import { createTerminalAdapter } from '../terminal';
import { IconButton, Pane, ResizableSeparator } from '../ui';
import {
	createWorkspaceProvider,
	type WorkspaceEntry,
	type WorkspaceSelection,
} from '../workspace';
import { AccessibilityHelp } from './AccessibilityHelp';
import { ConfirmDiscard } from './ConfirmDiscard';
import { Titlebar } from './Titlebar';
import { useWindowControls } from './useWindowControls';

const MIN = 170;
const MAX_SIDEBAR = 600;
const MAX_PANEL = 600;
const WORKSPACE_KEY = 'ade.workspace.path';

type Region = 'primarySidebar' | 'secondarySidebar' | 'panel';

export function WorkbenchShell() {
	const controls = useWindowControls();
	const mainRef = useRef<HTMLDivElement>(null);

	const [visible, setVisible] = useState<Record<Region, boolean>>({
		primarySidebar: true,
		secondarySidebar: true,
		panel: true,
	});
	const [primaryWidth, setPrimaryWidth] = useState(260);
	const [secondaryWidth, setSecondaryWidth] = useState(260);
	const [panelHeight, setPanelHeight] = useState(220);
	const [helpOpen, setHelpOpen] = useState(false);

	/*
	 * Workspace and editor state live here for now. The guide splits this into
	 * WorkbenchController and WorkbenchLayout in Slice 10, once feature growth
	 * has made the shell too broad to change comfortably.
	 */
	const provider = useMemo(() => createWorkspaceProvider(), []);
	const changesProvider = useMemo(() => createChangesProvider(), []);
	const terminalAdapter = useMemo(() => createTerminalAdapter(), []);
	const [selection, setSelection] = useState<WorkspaceSelection | undefined>(undefined);
	const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
	const [inputs, setInputs] = useState<readonly EditorInput[]>([]);
	const [activeEditorId, setActiveEditorId] = useState<string | undefined>(undefined);
	const [pendingCloseId, setPendingCloseId] = useState<string | undefined>(undefined);

	/*
	 * Restore the last root on start.
	 *
	 * ponytail: one raw localStorage key, not the versioned persistence schema.
	 * Slice 7 replaces this with PersistenceAdapter, which also restores layout
	 * and open editors; the workspace path is the only piece Slice 4 needs.
	 */
	useEffect(() => {
		let cancelled = false;
		async function start(): Promise<void> {
			if (!provider.canChooseWorkspace) {
				// Browser mode: the fixture workspace is always "selected".
				setSelection({ label: 'Fixture', path: '' });
				return;
			}
			const saved = localStorage.getItem(WORKSPACE_KEY);
			if (!saved) {
				return;
			}
			try {
				const restored = await provider.restoreWorkspace(saved);
				if (!cancelled) {
					setSelection(restored);
				}
			} catch {
				// The folder moved or is gone; forget it rather than retrying.
				localStorage.removeItem(WORKSPACE_KEY);
			}
		}
		void start();
		return () => {
			cancelled = true;
		};
	}, [provider]);

	// The tree belongs to the selected root, so it is reloaded with it.
	useEffect(() => {
		if (!selection) {
			setEntries([]);
			return;
		}
		let cancelled = false;
		void provider.getTree().then((tree) => {
			if (!cancelled) {
				setEntries(tree);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [provider, selection]);

	const dirty = inputs.some(isDirty);

	const openFolder = useCallback(async () => {
		const chosen = await provider.chooseWorkspace();
		if (!chosen) {
			return;
		}
		localStorage.setItem(WORKSPACE_KEY, chosen.path);
		// Editor ids are relative to the old root, so they cannot survive.
		// Switching is blocked while anything is dirty, so nothing is lost.
		setInputs([]);
		setActiveEditorId(undefined);
		setSelection(chosen);
	}, [provider]);

	const openFile = useCallback(
		async (entry: WorkspaceEntry) => {
			setActiveEditorId(entry.id);
			// Already open: just focus the tab, and keep any unsaved edits.
			if (inputs.some((input) => input.id === entry.id)) {
				return;
			}
			const file = await provider.readFile(entry.id);
			setInputs((current) =>
				current.some((input) => input.id === entry.id)
					? current
							: [
								...current,
								{
									kind: 'source',
									id: file.id,
									name: file.name,
									content: file.content,
									saved: file.content,
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
			setInputs((current) =>
				current.some((input) => input.id === diffId)
					? current
					: [
							...current,
							{
								kind: 'diff',
								id: diffId,
								name: diff.name,
								original: diff.original,
								modified: diff.modified,
							},
						]
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
		},
		[inputs, provider]
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

	const toggle = useCallback((region: Region) => {
		setVisible((current) => ({ ...current, [region]: !current[region] }));
	}, []);

	const closeHelp = useCallback(() => setHelpOpen(false), []);
	const [commandCenterOpen, setCommandCenterOpen] = useState(false);
	const closeCommandCenter = useCallback(() => setCommandCenterOpen(false), []);

	/*
	 * Focus-safe hiding. Hiding a region unmounts both the region and its
	 * separator, and the separator lives outside the region element — so
	 * predicting whether focus is about to be destroyed gets fiddly. Instead
	 * repair it afterwards: if the update left focus on nothing, the user is
	 * stranded, so hand it to main.
	 */
	useEffect(() => {
		const active = document.activeElement;
		if (!active || active === document.body) {
			mainRef.current?.focus();
		}
	}, [visible]);

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
				openFolder: provider.canChooseWorkspace && !dirty ? () => void openFolder() : undefined,
				showAccessibilityHelp: () => setHelpOpen(true),
			}),
		[toggle, closeEditor, saveFile, activeEditorId, provider, dirty, openFolder]
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
		<div className="ide-workbench">
			<Titlebar
				title="ADE"
				controls={controls}
				actions={
					<>
						<IconButton
							icon="layout-sidebar-left"
							label="Toggle primary sidebar"
							pressed={visible.primarySidebar}
							onClick={() => toggle('primarySidebar')}
						/>
						<IconButton
							icon="layout-panel"
							label="Toggle panel"
							pressed={visible.panel}
							onClick={() => toggle('panel')}
						/>
						<IconButton
							icon="layout-sidebar-right"
							label="Toggle secondary sidebar"
							pressed={visible.secondarySidebar}
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

			<div className="ide-body">
				{visible.primarySidebar ? (
					<>
						<div
							className="ide-region ide-region-sidebar"
							data-region="primarySidebar"
							style={{ width: primaryWidth }}
						>
							<Pane
								title={selection ? `Explorer — ${selection.label}` : 'Explorer'}
								actions={
									provider.canChooseWorkspace ? (
										<IconButton
											icon="folder-opened"
											label={
												dirty
													? 'Open folder (save your changes first)'
													: 'Open folder'
											}
											disabled={dirty}
											onClick={() => void openFolder()}
										/>
									) : null
								}
							>
								<ExplorerTree
									entries={entries}
									activeId={activeEditorId}
									onOpenFile={(entry) => void openFile(entry)}
								/>
							</Pane>
						</div>
						<ResizableSeparator
							label="Resize primary sidebar"
							orientation="vertical"
							value={primaryWidth}
							min={MIN}
							max={MAX_SIDEBAR}
							onChange={setPrimaryWidth}
						/>
					</>
				) : null}

				<div className="ide-center">
					<div
						className="ide-region ide-region-main"
						data-region="main"
						ref={mainRef}
						tabIndex={-1}
						role="main"
						aria-label="Main"
					>
						<EditorWorkbench
							inputs={inputs}
							activeId={activeEditorId}
							onSelect={setActiveEditorId}
							onClose={closeEditor}
							onChange={editFile}
						/>
					</div>

					{visible.panel ? (
						<>
							<ResizableSeparator
								label="Resize panel"
								orientation="horizontal"
								value={panelHeight}
								min={MIN}
								max={MAX_PANEL}
								inverted
								onChange={setPanelHeight}
							/>
							<div
								className="ide-region ide-region-panel"
								data-region="panel"
								style={{ height: panelHeight }}
							>
								<TerminalPanel
									adapter={terminalAdapter}
									cwd={selection?.path || undefined}
								/>
							</div>
						</>
					) : null}
				</div>

				{visible.secondarySidebar ? (
					<>
						<ResizableSeparator
							label="Resize secondary sidebar"
							orientation="vertical"
							value={secondaryWidth}
							min={MIN}
							max={MAX_SIDEBAR}
							inverted
							onChange={setSecondaryWidth}
						/>
						<div
							className="ide-region ide-region-sidebar"
							data-region="secondarySidebar"
							style={{ width: secondaryWidth }}
						>
							<Pane title="Changes">
								<ChangesView
									provider={changesProvider}
									activeDiffId={
										activeEditorId?.startsWith('diff:') ? activeEditorId : undefined
									}
									onOpenDiff={(id) => void openDiff(id)}
								/>
							</Pane>
						</div>
					</>
				) : null}
			</div>

			<CommandCenter
				open={commandCenterOpen}
				commands={commands}
				files={entries}
				onOpenFile={(entry) => void openFile(entry)}
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
		</div>
	);
}
