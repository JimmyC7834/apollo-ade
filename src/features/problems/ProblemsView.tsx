import * as monaco from 'monaco-editor';
import { useEffect, useMemo, useState } from 'react';

import { fileIdForModel } from '../../editor/modelRegistry';
import { Badge, WorkbenchTree, type TreeNode } from '../../ui';
import type { LspStatus } from '../lsp/client';
import { LspStatusNote } from '../lsp/LspStatusNote';
import {
	groupProblems,
	problemLabel,
	problemSummary,
	severityOf,
	type Problem,
	type ProblemFile,
} from './problems';

/** Every marker Monaco currently holds, as problems this app can show. */
function currentProblems(): readonly Problem[] {
	const out: Problem[] = [];
	for (const marker of monaco.editor.getModelMarkers({})) {
		const severity = severityOf(marker.severity);
		const fileId = fileIdForModel(marker.resource.toString());
		// A marker with no file is a model this workbench did not open — a diff
		// side, or Monaco's own scratch model. Neither is a workspace problem.
		if (!severity || !fileId) {
			continue;
		}
		out.push({
			fileId,
			severity,
			message: marker.message,
			line: marker.startLineNumber,
			column: marker.startColumn,
			source: marker.source,
		});
	}
	return out;
}

export interface ProblemsViewProps {
	/** Open the file at the problem. The same call a search result makes. */
	readonly onOpen: (id: string, line: number) => void;
	/**
	 * What the language server is doing — ticket 33. Its diagnostics arrive as
	 * markers and need nothing here; its *absence* does, because an empty list
	 * with no explanation reads as "nothing is wrong".
	 */
	readonly lspStatus?: LspStatus;
	readonly onRestartLsp?: () => void;
}

/**
 * Errors and warnings for open files — ticket 32.
 *
 * There is no new dependency and no new bundle weight here, which was a
 * condition of the ticket rather than a nice result: `ts.worker` is already the
 * largest asset this app ships and is *already* computing these markers, because
 * that is how a type error gets underlined. All that was missing was somewhere
 * to put them.
 *
 * **The scope is open files, and the panel says so.** Monaco's worker only knows
 * about models that exist, and models are created when a file is opened. The
 * note under the count is not an apology — a problems list that silently covered
 * a subset would be worse than one that names its own edge, because the useful
 * reading of an empty list is "nothing is wrong" and that would be a lie.
 */
export function ProblemsView({ onOpen, lspStatus, onRestartLsp }: ProblemsViewProps) {
	const [files, setFiles] = useState<readonly ProblemFile[]>([]);

	useEffect(() => {
		const refresh = () => setFiles(groupProblems(currentProblems()));
		// Once now, because markers for files opened before this panel was
		// pinned already exist and no event is coming for them.
		refresh();
		/*
		 * The worker re-runs on every keystroke and fires this each time, which
		 * is what makes the count update without a refresh button. It is also why
		 * nothing here polls.
		 */
		const subscription = monaco.editor.onDidChangeMarkers(refresh);
		return () => subscription.dispose();
	}, []);

	const nodes = useMemo<TreeNode[]>(
		() =>
			files.flatMap((file): TreeNode[] => [
				{
					id: file.id,
					label: file.name,
					description: file.id,
					icon: 'file',
					expandable: true,
					// The count only; the row icons below carry the severity, so a
					// tone here would be a second, quieter way to say the same
					// thing — and a red badge on a file of warnings would say it
					// wrongly.
					accessory: (
						<Badge label={String(file.errors + file.warnings)} title={problemSummary([file])} />
					),
				},
				...file.problems.map((problem, index): TreeNode => ({
					// Position is not unique on its own — two rules can fault the
					// same character — so the index is what keeps rows distinct.
					id: `${file.id}#${index}`,
					parentId: file.id,
					label: problemLabel(problem),
					description: problem.source,
					icon: problem.severity === 'error' ? 'error' : 'warning',
				})),
			]),
		[files]
	);

	// Files with problems open by default. A panel that has to be unfolded
	// before it says anything is a panel that gets pinned and then ignored.
	const expanded = useMemo(() => files.map((file) => file.id), [files]);

	return (
		<div className="ide-problems">
			<p className="ide-problems-scope">
				<strong>{problemSummary(files)}</strong> in open files. Nothing else has been looked
				at — a file no editor has opened is not checked.
			</p>
			<LspStatusNote status={lspStatus} onRestart={onRestartLsp ?? (() => {})} />
			<WorkbenchTree
				label="Problems"
				nodes={nodes}
				emptyMessage="No problems in the files you have open."
				defaultExpandedIds={expanded}
				onActivate={(id) => {
					const [fileId, index] = id.split('#');
					const problem = files.find((file) => file.id === fileId)?.problems[Number(index)];
					if (fileId && problem) {
						onOpen(fileId, problem.line);
					}
				}}
			/>
		</div>
	);
}
