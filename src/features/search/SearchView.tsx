import { useEffect, useMemo, useState } from 'react';

import { Badge, WorkbenchTree, type TreeNode } from '../../ui';
import type { SearchResult, WorkspaceProvider } from '../../workspace';

export interface SearchViewProps {
	readonly provider: WorkspaceProvider;
	readonly onOpenResult: (id: string, line: number) => void;
}

const DEBOUNCE_MS = 250;

/** `src/a/b.ts:12` — unique per match, and parseable back on activation. */
function resultId(result: SearchResult): string {
	return `${result.id}:${result.line}`;
}

export function SearchView({ provider, onOpenResult }: SearchViewProps) {
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<readonly SearchResult[]>([]);
	const [status, setStatus] = useState('');

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
			return;
		}
		let cancelled = false;
		setStatus('Searching…');
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
			{/* Announced, not just shown: the result count is the only feedback
			    that a search finished at all. */}
			<p className="ide-search-status" role="status">
				{status}
			</p>
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
