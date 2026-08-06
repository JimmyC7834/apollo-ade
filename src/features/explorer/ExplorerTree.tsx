import { useMemo } from 'react';

import { dirname } from '../../ids';
import { WorkbenchTree, type TreeNode } from '../../ui';
import type { WorkspaceEntry } from '../../workspace';

export interface ExplorerTreeProps {
	readonly entries: readonly WorkspaceEntry[];
	readonly activeId: string | undefined;
	readonly onOpenFile: (entry: WorkspaceEntry) => void;
	/**
	 * Passed only when no folder is open *and* one can be chosen. A folder icon
	 * in the pane header is not an affordance anyone finds on an empty
	 * workbench, so the empty state has to offer the action itself.
	 */
	readonly onOpenFolder?: () => void;
}

/*
 * Tree behavior moved to `WorkbenchTree` in Slice 5, once Changes became a
 * second consumer and the shared contract was actually visible. What is left
 * here is the workspace-specific part: entry-to-node mapping and file icons.
 */
export function ExplorerTree({
	entries,
	activeId,
	onOpenFile,
	onOpenFolder,
}: ExplorerTreeProps) {
	const nodes = useMemo<TreeNode[]>(
		() =>
			entries.map((entry) => ({
				id: entry.id,
				parentId: dirname(entry.id),
				label: entry.name,
				icon: entry.kind === 'dir' ? 'folder' : 'file',
				iconExpanded: entry.kind === 'dir' ? 'folder-opened' : undefined,
				expandable: entry.kind === 'dir',
			})),
		[entries]
	);

	if (onOpenFolder) {
		return (
			<div className="ide-empty-state">
				<p>You have not opened a folder yet.</p>
				<button type="button" className="ide-button" onClick={onOpenFolder}>
					Open Folder
				</button>
			</div>
		);
	}

	return (
		<WorkbenchTree
			label="Files"
			nodes={nodes}
			activeId={activeId}
			emptyMessage="No files"
			onActivate={(id) => {
				const entry = entries.find((candidate) => candidate.id === id);
				if (entry) {
					onOpenFile(entry);
				}
			}}
		/>
	);
}
