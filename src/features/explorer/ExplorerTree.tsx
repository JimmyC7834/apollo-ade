import { useMemo } from 'react';

import { WorkbenchTree, type TreeNode } from '../../ui';
import type { WorkspaceEntry } from '../../workspace';

export interface ExplorerTreeProps {
	readonly entries: readonly WorkspaceEntry[];
	readonly activeId: string | undefined;
	readonly onOpenFile: (entry: WorkspaceEntry) => void;
}

/** Parent directory id of `src/a/b.ts` -> "src/a"; undefined at the root. */
function parentOf(id: string): string | undefined {
	const cut = id.lastIndexOf('/');
	return cut < 0 ? undefined : id.slice(0, cut);
}

/*
 * Tree behavior moved to `WorkbenchTree` in Slice 5, once Changes became a
 * second consumer and the shared contract was actually visible. What is left
 * here is the workspace-specific part: entry-to-node mapping and file icons.
 */
export function ExplorerTree({ entries, activeId, onOpenFile }: ExplorerTreeProps) {
	const nodes = useMemo<TreeNode[]>(
		() =>
			entries.map((entry) => ({
				id: entry.id,
				parentId: parentOf(entry.id),
				label: entry.name,
				icon: entry.kind === 'dir' ? 'folder' : 'file',
				iconExpanded: entry.kind === 'dir' ? 'folder-opened' : undefined,
				expandable: entry.kind === 'dir',
			})),
		[entries]
	);

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
