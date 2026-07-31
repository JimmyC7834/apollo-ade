import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildCommands } from '../commands/commandRegistry';
import { EditorWorkbench, type EditorInput } from '../editor/EditorWorkbench';
import { CommandCenter } from '../features/commandCenter/CommandCenter';
import { ExplorerTree } from '../features/explorer/ExplorerTree';
import { IconButton, Pane, ResizableSeparator } from '../ui';
import { createWorkspaceProvider, type WorkspaceEntry } from '../workspace';
import { AccessibilityHelp } from './AccessibilityHelp';
import { Titlebar } from './Titlebar';
import { useWindowControls } from './useWindowControls';

const MIN = 170;
const MAX_SIDEBAR = 600;
const MAX_PANEL = 600;

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
	const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
	const [inputs, setInputs] = useState<readonly EditorInput[]>([]);
	const [activeEditorId, setActiveEditorId] = useState<string | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		void provider.getTree().then((tree) => {
			if (!cancelled) {
				setEntries(tree);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [provider]);

	const openFile = useCallback(
		async (entry: WorkspaceEntry) => {
			setActiveEditorId(entry.id);
			// Already open: just focus the tab, and keep any unsaved edits.
			if (inputs.some((input) => input.id === entry.id)) {
				return;
			}
			const content = await provider.readFile(entry.id);
			setInputs((current) =>
				current.some((input) => input.id === entry.id)
					? current
					: [...current, { id: entry.id, name: entry.name, content }]
			);
		},
		[inputs, provider]
	);

	const closeEditor = useCallback((id: string) => {
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
				showAccessibilityHelp: () => setHelpOpen(true),
			}),
		[toggle, closeEditor, activeEditorId]
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
							<Pane title="Explorer">
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
								<Pane title="Panel" />
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
							<Pane title="Changes" />
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
			<AccessibilityHelp open={helpOpen} onClose={closeHelp} />
		</div>
	);
}
