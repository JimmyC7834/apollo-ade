import { useMemo, useState } from 'react';

import { basename, dirname } from '../../ids';
import { Confirm, ContextMenu, Prompt, WorkbenchTree, type TreeNode } from '../../ui';
import type { WorkspaceEntry } from '../../workspace';
import { childId, deleteMessage, nameProblem, renamedId, type DeletePlan } from './fileOperations';

/**
 * What the explorer may do to the tree — ticket 29.
 *
 * One object rather than four callbacks, because they are never present
 * separately: they all exist exactly when a workspace is open, and the four of
 * them travelling together through every layer is a type asking to be born.
 *
 * None of them rejects. Reporting a refusal is the controller's job — it owns
 * the announcement channel — so the dialogs here close on invoke rather than
 * waiting to find out.
 */
export interface FileOperations {
	/** Whether a delete can be undone afterwards. See `WorkspaceProvider`. */
	readonly deletesToTrash: boolean;
	create(id: string, kind: 'file' | 'folder'): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/**
	 * What a delete would take. Reads only.
	 *
	 * Undefined when the workspace refused to say — a browser folder, which has
	 * no trash to delete into. The refusal is announced by the controller; this
	 * is how the dialog knows not to open and offer an action that cannot run.
	 */
	plan(id: string): Promise<DeletePlan | undefined>;
	remove(id: string): Promise<void>;
}

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
	/** Absent when there is no workspace to operate on. */
	readonly operations?: FileOperations;
}

/** Which dialog is open, and about what. */
type Pending =
	| { readonly kind: 'file' | 'folder'; readonly parentId: string | undefined }
	| { readonly kind: 'rename'; readonly id: string };

/*
 * Tree behavior moved to `WorkbenchTree` in Slice 5, once Changes became a
 * second consumer and the shared contract was actually visible. What is left
 * here is the workspace-specific part: entry-to-node mapping, file icons, and
 * — since ticket 29 — the operations the agent could already do and the person
 * at the keyboard could not.
 */
export function ExplorerTree({
	entries,
	activeId,
	onOpenFile,
	onOpenFolder,
	operations,
}: ExplorerTreeProps) {
	const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number }>();
	const [pending, setPending] = useState<Pending>();
	const [deleting, setDeleting] = useState<{ id: string; plan: DeletePlan }>();

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

	/** New entries land *in* a folder, and *beside* a file. */
	function parentFor(id: string): string | undefined {
		return entries.find((entry) => entry.id === id)?.kind === 'dir' ? id : dirname(id);
	}

	const dialogs = operations ? (
		<>
			<ContextMenu
				anchor={menuFor}
				label="File actions"
				items={
					menuFor
						? [
								{
									id: 'new-file',
									label: 'New file',
									run: () => setPending({ kind: 'file', parentId: parentFor(menuFor.id) }),
								},
								{
									id: 'new-folder',
									label: 'New folder',
									run: () => setPending({ kind: 'folder', parentId: parentFor(menuFor.id) }),
								},
								{
									id: 'rename',
									label: 'Rename',
									run: () => setPending({ kind: 'rename', id: menuFor.id }),
								},
								{
									id: 'delete',
									label: 'Delete',
									danger: true,
									/*
									 * The plan is fetched before the dialog opens, not
									 * inside it: a confirmation that appeared and then
									 * changed what it said would be asking about one
									 * thing and answering about another.
									 */
									run: () => {
										const id = menuFor.id;
										void operations.plan(id).then((plan) => {
											if (plan) {
												setDeleting({ id, plan });
											}
										});
									},
								},
							]
						: []
				}
				onClose={() => setMenuFor(undefined)}
			/>
			<Prompt
				open={pending !== undefined}
				title={
					pending?.kind === 'rename'
						? 'Rename'
						: `New ${pending?.kind === 'folder' ? 'folder' : 'file'}`
				}
				label={pending?.kind === 'rename' ? 'New name' : 'Name'}
				initialValue={pending?.kind === 'rename' ? basename(pending.id) : ''}
				confirmLabel={pending?.kind === 'rename' ? 'Rename' : 'Create'}
				validate={nameProblem}
				onCancel={() => setPending(undefined)}
				onSubmit={(name) => {
					const request = pending;
					setPending(undefined);
					if (!request) {
						return;
					}
					if (request.kind === 'rename') {
						void operations.rename(request.id, renamedId(request.id, name));
					} else {
						void operations.create(childId(request.parentId, name), request.kind);
					}
				}}
			/>
			<Confirm
				open={deleting !== undefined}
				title="Delete"
				message={
					deleting ? deleteMessage(deleting.id, deleting.plan, operations.deletesToTrash) : ''
				}
				onCancel={() => setDeleting(undefined)}
				actions={[
					{
						label: 'Delete',
						danger: true,
						run: () => {
							const id = deleting?.id;
							setDeleting(undefined);
							if (id) {
								void operations.remove(id);
							}
						},
					},
				]}
			/>
		</>
	) : null;

	if (nodes.length === 0) {
		// A folder is open and empty. Without this the one thing ticket 29 set
		// out to fix — that the human cannot create a file — would still be true
		// for a new project, which is exactly when it is most needed.
		return (
			<div className="ide-empty-state">
				<p>No files.</p>
				{operations ? (
					<button
						type="button"
						className="ide-button"
						onClick={() => setPending({ kind: 'file', parentId: undefined })}
					>
						New file
					</button>
				) : null}
				{dialogs}
			</div>
		);
	}

	return (
		<>
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
				onContextMenu={
					operations ? (id, x, y) => setMenuFor({ id, x, y }) : undefined
				}
			/>
			{dialogs}
		</>
	);
}
