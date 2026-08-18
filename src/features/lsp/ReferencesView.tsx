// Where a symbol is used — ticket 34's result set, as an artifact.
//
// The same shape as `ProblemsView`: a scope sentence, a `WorkbenchTree`, and
// the `onOpen(id, line)` contract every list in this workbench uses to put
// somebody in an editor. `references.ts` explains why this is not `SearchView`.

import { useMemo } from 'react';

import { WorkbenchTree, type TreeNode } from '../../ui';
import {
	groupReferences,
	referenceLabel,
	referenceSummary,
	type Reference,
} from './references';

export interface ReferencesViewProps {
	/** What was asked about, for the header. */
	readonly symbol: string | undefined;
	readonly references: readonly Reference[];
	readonly onOpen: (id: string, line: number) => void;
}

export function ReferencesView({ symbol, references, onOpen }: ReferencesViewProps) {
	const files = useMemo(() => groupReferences(references), [references]);

	const nodes = useMemo<TreeNode[]>(
		() =>
			files.flatMap((file): TreeNode[] => [
				{
					id: file.id,
					label: file.name,
					description: file.id,
					icon: 'file',
					expandable: true,
				},
				...file.references.map((reference, index): TreeNode => ({
					// Two references can share a line, so the index is what keeps
					// rows distinct — the same rule the problems tree follows.
					id: `${file.id}#${index}`,
					parentId: file.id,
					label: referenceLabel(reference),
					description: `${reference.line}:${reference.column}`,
					icon: 'symbol-keyword',
				})),
			]),
		[files]
	);

	const expanded = useMemo(() => files.map((file) => file.id), [files]);

	return (
		<div className="ide-problems">
			<p className="ide-problems-scope">
				{symbol === undefined ? (
					<>
						Put the cursor on a symbol and press <kbd>Shift</kbd>+<kbd>F12</kbd>.
					</>
				) : (
					<>
						<strong>{referenceSummary(files)}</strong> to <code>{symbol}</code>.
					</>
				)}
			</p>
			<WorkbenchTree
				label="References"
				nodes={nodes}
				emptyMessage={
					symbol === undefined ? 'No symbol has been asked about yet.' : `Nothing uses ${symbol}.`
				}
				defaultExpandedIds={expanded}
				onActivate={(id) => {
					const [fileId, index] = id.split('#');
					const reference = files.find((file) => file.id === fileId)?.references[Number(index)];
					if (fileId && reference) {
						onOpen(fileId, reference.line);
					}
				}}
			/>
		</div>
	);
}
