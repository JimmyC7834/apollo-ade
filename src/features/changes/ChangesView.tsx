import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Change, ChangesProvider } from '../../changes';
import {
	ActionBar,
	Badge,
	ContextMenu,
	IconButton,
	Overlay,
	WorkbenchTree,
	type TreeNode,
} from '../../ui';

export interface ChangesViewProps {
	readonly provider: ChangesProvider;
	/** Id of the open diff, so the matching row reads as selected. */
	readonly activeDiffId: string | undefined;
	readonly onOpenDiff: (id: string) => void;
}

const STATUS_LABEL: Record<Change['status'], string> = {
	added: 'Added',
	modified: 'Modified',
	deleted: 'Deleted',
};

const STAGED = 'group:staged';
const UNSTAGED = 'group:unstaged';

/** Directory part of the path, shown muted after the file name. */
function directoryOf(id: string): string | undefined {
	const cut = id.lastIndexOf('/');
	return cut < 0 ? undefined : id.slice(0, cut);
}

export function ChangesView({ provider, activeDiffId, onOpenDiff }: ChangesViewProps) {
	const [changes, setChanges] = useState<readonly Change[]>([]);
	const [menu, setMenu] = useState<{ id: string; x: number; y: number } | undefined>(undefined);
	const [confirmRevertId, setConfirmRevertId] = useState<string | undefined>(undefined);

	// The provider owns the change set; this view re-reads it on every signal
	// rather than trying to apply each mutation to local state as well.
	const refresh = useCallback(() => {
		void provider.getChanges().then(setChanges);
	}, [provider]);

	useEffect(() => {
		refresh();
		return provider.subscribe(refresh);
	}, [provider, refresh]);

	const nodes = useMemo<TreeNode[]>(() => {
		const groups: TreeNode[] = [];
		for (const [groupId, label, staged] of [
			[STAGED, 'Staged changes', true],
			[UNSTAGED, 'Changes', false],
		] as const) {
			const members = changes.filter((change) => change.staged === staged);
			if (members.length === 0) {
				continue;
			}
			groups.push({
				id: groupId,
				label,
				expandable: true,
				accessory: <Badge label={String(members.length)} title={`${members.length} files`} />,
			});
			for (const change of members) {
				groups.push({
					id: change.id,
					parentId: groupId,
					label: change.name,
					description: directoryOf(change.id),
					icon: 'file',
					accessory: (
						<Badge
							label={change.status.charAt(0).toUpperCase()}
							title={STATUS_LABEL[change.status]}
							tone={change.status}
						/>
					),
				});
			}
		}
		return groups;
	}, [changes]);

	const target = menu && changes.find((change) => change.id === menu.id);

	return (
		<>
			<ActionBar label="Changes actions">
				<IconButton
					icon="add"
					label="Stage all changes"
					disabled={changes.every((change) => change.staged)}
					onClick={() => {
						for (const change of changes) {
							if (!change.staged) {
								void provider.stage(change.id);
							}
						}
					}}
				/>
				<IconButton
					icon="remove"
					label="Unstage all changes"
					disabled={changes.every((change) => !change.staged)}
					onClick={() => {
						for (const change of changes) {
							if (change.staged) {
								void provider.unstage(change.id);
							}
						}
					}}
				/>
			</ActionBar>

			<WorkbenchTree
				label="Changes"
				nodes={nodes}
				// The tree speaks workspace ids; the editor speaks diff ids.
				activeId={activeDiffId?.replace(/^diff:/, '')}
				emptyMessage="No changes"
				defaultExpandedIds={[STAGED, UNSTAGED]}
				onActivate={onOpenDiff}
				onContextMenu={(id, x, y) => setMenu({ id, x, y })}
			/>

			<ContextMenu
				anchor={menu ? { x: menu.x, y: menu.y } : undefined}
				label={target ? `Actions for ${target.name}` : 'Change actions'}
				items={
					target
						? [
								target.staged
									? {
											id: 'unstage',
											label: 'Unstage',
											run: () => void provider.unstage(target.id),
										}
									: {
											id: 'stage',
											label: 'Stage',
											run: () => void provider.stage(target.id),
										},
								{
									id: 'revert',
									label: 'Revert file',
									danger: true,
									// Confirmed before it runs: this one destroys work.
									run: () => setConfirmRevertId(target.id),
								},
							]
						: []
				}
				onClose={() => setMenu(undefined)}
			/>

			<Overlay
				open={confirmRevertId !== undefined}
				title="Revert file"
				onClose={() => setConfirmRevertId(undefined)}
			>
				<p className="ide-help-note">
					Discard the changes in {confirmRevertId}? This cannot be undone.
				</p>
				<div className="ide-dialog-actions">
					<button
						type="button"
						className="ide-button"
						onClick={() => setConfirmRevertId(undefined)}
					>
						Cancel
					</button>
					<button
						type="button"
						className="ide-button ide-button-danger"
						onClick={() => {
							if (confirmRevertId) {
								void provider.revert(confirmRevertId);
							}
							setConfirmRevertId(undefined);
						}}
					>
						Revert
					</button>
				</div>
			</Overlay>
		</>
	);
}
