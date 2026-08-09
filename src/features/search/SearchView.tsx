import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, WorkbenchTree, type TreeNode } from '../../ui';
import type { SearchResult, WorkspaceProvider } from '../../workspace';
import { planFile, planSummary, type Replacement } from './replace';

export interface SearchViewProps {
	readonly provider: WorkspaceProvider;
	readonly onOpenResult: (id: string, line: number) => void;
	/**
	 * Show one planned file as a diff — ticket 30's preview.
	 *
	 * The workbench opens it, because the editor and its tab strip belong to the
	 * workbench and a sidebar that mounted its own diff editor would be a second
	 * `MonacoDiffEditor` consumer that does not share the first one's shape.
	 */
	readonly onPreviewReplace?: (plan: Replacement) => void;
	/**
	 * Write the planned files, and say what happened.
	 *
	 * The controller does it rather than this view, and the reason is not
	 * layering: it is the only thing that knows which files are open and which
	 * of those are dirty, and that is half of the safety rule.
	 */
	readonly onApplyReplace?: (plans: readonly Replacement[]) => Promise<string>;
}

const DEBOUNCE_MS = 250;

/** `src/a/b.ts:12` — unique per match, and parseable back on activation. */
function resultId(result: SearchResult): string {
	return `${result.id}:${result.line}`;
}

export function SearchView({
	provider,
	onOpenResult,
	onPreviewReplace,
	onApplyReplace,
}: SearchViewProps) {
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<readonly SearchResult[]>([]);
	const [status, setStatus] = useState('');
	const [replacement, setReplacement] = useState('');
	/*
	 * The planned files, or nothing.
	 *
	 * Built on demand rather than as you type, and that is the feature: a live
	 * plan would read every matching file on every keystroke, and — worse — it
	 * would make "what would change" look like something that is already
	 * changing. Cleared whenever the search moves underneath it, so what is on
	 * screen is never a plan for a different query.
	 */
	const [plans, setPlans] = useState<readonly Replacement[] | undefined>(undefined);
	const [replaceStatus, setReplaceStatus] = useState('');

	/*
	 * Searching on every keystroke would re-walk the workspace per character.
	 * A late response must also never overwrite a newer one, so each run
	 * checks whether it is still the current one before committing.
	 */
	useEffect(() => {
		const trimmed = query.trim();
		if (!trimmed) {
			setResults([]);
			setStatus('');
			setPlans(undefined);
			setReplaceStatus('');
			return;
		}
		let cancelled = false;
		setStatus('Searching…');
		// A plan belongs to the query it was built from. Leaving it up while the
		// results move underneath it is how someone applies a replacement to a
		// search they have already changed.
		setPlans(undefined);
		setReplaceStatus('');
		const timer = setTimeout(() => {
			void provider
				.search(trimmed)
				.then((found) => {
					if (cancelled) {
						return;
					}
					setResults(found);
					const files = new Set(found.map((result) => result.id)).size;
					setStatus(
						found.length === 0
							? 'No results'
							: `${found.length} result${found.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}`
					);
				})
				.catch((error: unknown) => {
					if (!cancelled) {
						setResults([]);
						setStatus(error instanceof Error ? error.message : 'Search failed');
					}
				});
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [provider, query]);

	// Grouped by file: a parent per file, one child per matching line.
	const nodes = useMemo<TreeNode[]>(() => {
		const out: TreeNode[] = [];
		const seen = new Set<string>();
		for (const result of results) {
			if (!seen.has(result.id)) {
				seen.add(result.id);
				const count = results.filter((other) => other.id === result.id).length;
				out.push({
					id: `file:${result.id}`,
					label: result.name,
					description: result.id,
					icon: 'file',
					expandable: true,
					accessory: <Badge label={String(count)} title={`${count} matches`} />,
				});
			}
			out.push({
				id: resultId(result),
				parentId: `file:${result.id}`,
				label: result.preview,
				description: `line ${result.line}`,
			});
		}
		return out;
	}, [results]);

	/*
	 * Read every matching file and work out what would change.
	 *
	 * One read per file rather than per match, and unreadable files are dropped
	 * rather than failing the plan: a binary or oversized file among the results
	 * is not a reason to refuse to replace in the other thirty. It cannot be in
	 * the plan, so it cannot be written, which is the property that matters.
	 */
	const preview = useCallback(async () => {
		const needle = query.trim();
		const ids = [...new Set(results.map((result) => result.id))];
		const built: Replacement[] = [];
		for (const id of ids) {
			try {
				const file = await provider.readFile(id);
				const plan = planFile(id, file.name, file.content, needle, replacement);
				if (plan) {
					built.push(plan);
				}
			} catch {
				// Not readable now; not something this can offer to rewrite.
			}
		}
		setPlans(built);
		setReplaceStatus(planSummary(built));
	}, [provider, query, replacement, results]);

	const apply = useCallback(
		async (targets: readonly Replacement[]) => {
			if (!onApplyReplace) {
				return;
			}
			const report = await onApplyReplace(targets);
			setReplaceStatus(report);
			// Every remaining plan now holds an `original` that may no longer be on
			// disk — including the ones just written. Keeping them would leave a
			// second apply either refusing everything or, worse, not.
			setPlans(undefined);
		},
		[onApplyReplace]
	);

	// Replacing an empty string is not a replacement, and neither is replacing
	// something with itself.
	const replaceable =
		onApplyReplace !== undefined && results.length > 0 && query.trim() !== '' &&
		replacement !== query.trim();

	return (
		<div className="ide-search">
			<div className="ide-search-field">
				<label className="ide-visually-hidden" htmlFor="ide-search-input">
					Search in workspace
				</label>
				<input
					id="ide-search-input"
					className="ide-search-input"
					type="search"
					placeholder="Search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>
			{/* Offered only where the workbench can write. The browser fixture can,
			    so this is not a native-only surface — it is absent only where no
			    apply was wired at all. */}
			{onApplyReplace ? (
				<div className="ide-search-field">
					<label className="ide-visually-hidden" htmlFor="ide-replace-input">
						Replace with
					</label>
					<input
						id="ide-replace-input"
						className="ide-search-input"
						type="text"
						placeholder="Replace with"
						value={replacement}
						onChange={(event) => {
							setReplacement(event.target.value);
							// The plan was for the old replacement text.
							setPlans(undefined);
							setReplaceStatus('');
						}}
					/>
					<div className="ide-search-actions">
						<button
							type="button"
							className="ide-button"
							disabled={!replaceable}
							onClick={() => void preview()}
						>
							Preview
						</button>
						<button
							type="button"
							className="ide-button"
							// Nothing is ever written from an unpreviewed plan. The button
							// exists in both states so the order reads as a sequence
							// rather than as a button that comes and goes.
							disabled={!plans || plans.length === 0}
							onClick={() => void apply(plans ?? [])}
						>
							Replace all
						</button>
					</div>
				</div>
			) : null}

			{/* Announced, not just shown: the result count is the only feedback
			    that a search finished at all. */}
			<p className="ide-search-status" role="status">
				{status}
			</p>

			{replaceStatus ? (
				<p className="ide-search-status" role="status">
					{replaceStatus}
				</p>
			) : null}

			{/*
			 * The plan, one row per file, each with its own diff and its own apply.
			 * Per file rather than per match because that is what the results above
			 * are already grouped by — and because "apply this file" needs no
			 * selection model, where per-match would need one.
			 */}
			{plans && plans.length > 0 ? (
				<ul className="ide-search-plan" aria-label="Planned replacements">
					{plans.map((plan) => (
						<li key={plan.id} className="ide-search-plan-row">
							<span className="ide-search-plan-name" title={plan.id}>
								{plan.name}
							</span>
							<Badge label={String(plan.count)} title={`${plan.count} replacements`} />
							{onPreviewReplace ? (
								<button
									type="button"
									className="ide-button"
									onClick={() => onPreviewReplace(plan)}
								>
									Diff
								</button>
							) : null}
							<button type="button" className="ide-button" onClick={() => void apply([plan])}>
								Replace
							</button>
						</li>
					))}
				</ul>
			) : null}

			<WorkbenchTree
				label="Search results"
				nodes={nodes}
				emptyMessage={query.trim() ? '' : 'Type to search the workspace.'}
				defaultExpandedIds={nodes.filter((node) => node.expandable).map((node) => node.id)}
				onActivate={(id) => {
					const result = results.find((candidate) => resultId(candidate) === id);
					if (result) {
						onOpenResult(result.id, result.line);
					}
				}}
			/>
		</div>
	);
}
