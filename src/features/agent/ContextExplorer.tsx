// The Context Explorer — ticket 42.
//
// **Modeless.** It opens in the empty chat area directly above the composer and
// never covers the input or the bar, so the thing you opened it to talk about
// and the thing you are typing are on screen together. That is the whole reason
// it is not the Modal Workbench's file tree in a dialog.
//
// Flat, immediate children only, with Previous walking back through where you
// have been. A tree would show the same information with twice the geometry, and
// this panel is capped at 280px.

import { useState } from 'react';

import { Icon } from '../../ui';
import { children, pathLabel, type ExplorerEntry } from './composer';

export interface ContextExplorerProps {
	/** Every file in the workspace, root-relative — the same list `@` completes. */
	readonly files: readonly string[];
	readonly onClose: () => void;
	/** Attach as a draft chip. A folder cannot be attached; only drilled into. */
	readonly onAttach: (path: string) => void;
	/** Open as a Monaco tab in the Modal Workbench. */
	readonly onOpenFile: (path: string) => void;
}

export function ContextExplorer({ files, onClose, onAttach, onOpenFile }: ContextExplorerProps) {
	/*
	 * Where you have been, newest last, with the root always at the bottom. A
	 * stack rather than "the parent of the current path", because Previous is
	 * history and history is what the Guide asks for — after drilling in and
	 * jumping elsewhere, the parent is not where you came from.
	 */
	const [history, setHistory] = useState<readonly string[]>(['']);
	const path = history[history.length - 1] ?? '';
	const rows = children(files, path);

	return (
		<div className="ide-context-explorer" aria-label="Workspace files">
			<div className="ide-context-explorer-bar">
				<button
					type="button"
					className="ide-bar-button"
					disabled={history.length === 1}
					onClick={() => setHistory((current) => current.slice(0, -1))}
					aria-label="Previous folder"
				>
					<Icon name="arrow-left" />
				</button>
				<span className="ide-context-explorer-path" title={pathLabel(path)}>
					{pathLabel(path)}
				</span>
				<button type="button" className="ide-bar-button" onClick={onClose} aria-label="Close the file browser">
					<Icon name="close" />
				</button>
			</div>
			{rows.length === 0 ? (
				<p className="ide-context-explorer-empty">Nothing here.</p>
			) : (
				<ul className="ide-context-explorer-list">
					{rows.map((entry) => (
						<Row
							key={entry.path}
							entry={entry}
							onOpen={() =>
								entry.kind === 'dir'
									? setHistory((current) => [...current, entry.path])
									: onOpenFile(entry.path)
							}
							onAttach={() => onAttach(entry.path)}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function Row({
	entry,
	onOpen,
	onAttach,
}: {
	readonly entry: ExplorerEntry;
	readonly onOpen: () => void;
	readonly onAttach: () => void;
}) {
	return (
		<li className="ide-context-explorer-row">
			<button
				type="button"
				className="ide-context-explorer-open"
				onClick={onOpen}
				/*
				 * Dragging a row into the composer is the Guide's stated way to
				 * attach. The payload is the root-relative path and nothing else —
				 * the composer resolves it against the same file list this panel
				 * drew from, so a drop can only ever name something that exists.
				 */
				draggable={entry.kind === 'file'}
				onDragStart={(event) => {
					event.dataTransfer.setData('text/plain', entry.path);
					event.dataTransfer.effectAllowed = 'copy';
				}}
			>
				<Icon name={entry.kind === 'dir' ? 'folder' : 'file'} />
				<span className="ide-context-explorer-name">{entry.name}</span>
			</button>
			{entry.kind === 'file' ? (
				// A pointer can drag; a keyboard cannot. The button is what makes
				// attaching reachable without one, and it is the same action.
				<button
					type="button"
					className="ide-bar-button"
					onClick={onAttach}
					aria-label={`Attach ${entry.path}`}
				>
					<Icon name="add" />
				</button>
			) : null}
		</li>
	);
}
