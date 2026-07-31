import { useMemo, useRef, useState } from 'react';

import { Icon } from '../../ui';
import type { WorkspaceEntry } from '../../workspace';

export interface ExplorerTreeProps {
	readonly entries: readonly WorkspaceEntry[];
	readonly activeId: string | undefined;
	readonly onOpenFile: (entry: WorkspaceEntry) => void;
}

/** Every ancestor directory id of `src/a/b.ts` -> ["src", "src/a"]. */
function ancestorsOf(id: string): string[] {
	const segments = id.split('/');
	return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

/*
 * Tree behavior lives with the Explorer for now. The guide extracts
 * `WorkbenchTree` in Slice 5, once Changes becomes a second consumer and the
 * shared contract is actually visible — extracting from one consumer would
 * only be guessing at the interface.
 */
export function ExplorerTree({ entries, activeId, onOpenFile }: ExplorerTreeProps) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
	const listRef = useRef<HTMLDivElement>(null);

	// A row is visible only when every ancestor directory is expanded.
	const visible = useMemo(
		() => entries.filter((entry) => ancestorsOf(entry.id).every((id) => expanded.has(id))),
		[entries, expanded]
	);

	function toggle(id: string, open: boolean): void {
		setExpanded((current) => {
			const next = new Set(current);
			if (open) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}

	function focusRow(index: number): void {
		const target = visible[index];
		if (!target) {
			return;
		}
		setFocusedId(target.id);
		listRef.current
			?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(target.id)}"]`)
			?.focus();
	}

	function onKeyDown(event: React.KeyboardEvent, entry: WorkspaceEntry, index: number): void {
		const isOpen = expanded.has(entry.id);
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusRow(Math.min(index + 1, visible.length - 1));
				break;
			case 'ArrowUp':
				event.preventDefault();
				focusRow(Math.max(index - 1, 0));
				break;
			case 'ArrowRight':
				event.preventDefault();
				// Expand a closed directory, else step into its first child.
				if (entry.kind === 'dir' && !isOpen) {
					toggle(entry.id, true);
				} else if (entry.kind === 'dir') {
					focusRow(index + 1);
				}
				break;
			case 'ArrowLeft': {
				event.preventDefault();
				// Collapse an open directory, else jump out to the parent row.
				if (entry.kind === 'dir' && isOpen) {
					toggle(entry.id, false);
					break;
				}
				const parentId = ancestorsOf(entry.id).at(-1);
				const parentIndex = visible.findIndex((candidate) => candidate.id === parentId);
				if (parentIndex >= 0) {
					focusRow(parentIndex);
				}
				break;
			}
			case 'Home':
				event.preventDefault();
				focusRow(0);
				break;
			case 'End':
				event.preventDefault();
				focusRow(visible.length - 1);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (entry.kind === 'dir') {
					toggle(entry.id, !isOpen);
				} else {
					onOpenFile(entry);
				}
				break;
		}
	}

	if (entries.length === 0) {
		return <p className="ide-tree-empty">No files</p>;
	}

	// Roving tabindex: exactly one row is reachable with Tab.
	const tabbableId = focusedId && visible.some((e) => e.id === focusedId) ? focusedId : visible[0]?.id;

	return (
		<div className="ide-tree" role="tree" aria-label="Files" ref={listRef}>
			{visible.map((entry, index) => {
				const isDir = entry.kind === 'dir';
				const isOpen = expanded.has(entry.id);
				return (
					<div
						key={entry.id}
						className={`ide-tree-row${entry.id === activeId ? ' ide-tree-row-active' : ''}`}
						style={{ paddingLeft: `${entry.depth * 12 + 6}px` }}
						role="treeitem"
						tabIndex={entry.id === tabbableId ? 0 : -1}
						aria-level={entry.depth + 1}
						aria-selected={entry.id === activeId}
						aria-expanded={isDir ? isOpen : undefined}
						data-entry-id={entry.id}
						onFocus={() => setFocusedId(entry.id)}
						onClick={() => (isDir ? toggle(entry.id, !isOpen) : onOpenFile(entry))}
						onKeyDown={(event) => onKeyDown(event, entry, index)}
					>
						<span className="ide-tree-twistie">
							{isDir ? <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} /> : null}
						</span>
						<Icon name={isDir ? (isOpen ? 'folder-opened' : 'folder') : 'file'} />
						<span className="ide-tree-label">{entry.name}</span>
					</div>
				);
			})}
		</div>
	);
}
