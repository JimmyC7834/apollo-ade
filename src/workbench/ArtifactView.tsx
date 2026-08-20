// What the dock actually renders, per artifact.
//
// Split out of the controller so the controller keeps holding state and wiring
// and does not also become a switch over artifact kinds. Everything here is a
// component that already existed and already worked in a region; slice 40 moved
// where it is mounted, not what it does.

import { TOOL_ARTIFACTS, isBrowserTab, toolArtifactKind, type ArtifactRef } from '../artifacts';
import type { ChangesProvider } from '../changes';
import { MonacoDiffEditor } from '../editor/MonacoDiffEditor';
import { MonacoEditor } from '../editor/MonacoEditor';
import type { EditorInput } from '../editor/EditorWorkbench';
import { ChangesView } from '../features/changes/ChangesView';
import { ExplorerTree, type FileOperations } from '../features/explorer/ExplorerTree';
import { ReferencesView } from '../features/lsp/ReferencesView';
import type { Lsp } from '../features/lsp/useLsp';
import { ProblemsView } from '../features/problems/ProblemsView';
import { SearchView } from '../features/search/SearchView';
import type { Replacement } from '../features/search/replace';
import type { WorkspaceEntry, WorkspaceProvider } from '../workspace';

export interface ArtifactViewProps {
	readonly id: string;
	readonly provider: WorkspaceProvider;
	readonly changesProvider: ChangesProvider;
	readonly entries: readonly WorkspaceEntry[];
	readonly inputs: readonly EditorInput[];
	readonly activeEditorId: string | undefined;
	readonly onOpenFile: (id: string, line?: number) => void;
	readonly onOpenDiff: (id: string) => void;
	readonly onOpenFolder: (() => void) | undefined;
	/** The explorer's file operations. Absent without a root. */
	readonly fileOperations: FileOperations | undefined;
	/** The language server, for the Problems status line and References. */
	readonly lsp: Lsp;
	readonly onPreviewReplace: (plan: Replacement) => void;
	readonly onApplyReplace: (plans: readonly Replacement[]) => Promise<string>;
	readonly onChange: (id: string, content: string) => void;
}

export function ArtifactView(props: ArtifactViewProps) {
	const kind = toolArtifactKind(props.id);

	/*
	 * Not the terminal: it is mounted by the controller for as long as it is
	 * *pinned*, rather than for as long as it is the tab being looked at.
	 * Unmounting a `TerminalInstance` kills its shell, and this component's
	 * subtree is swapped wholesale every time the active artifact changes — so
	 * rendering it here meant a glance at the file tree killed every shell in
	 * every root. See `WorkbenchController`.
	 */
	if (kind === 'terminal') {
		return null;
	}
	/*
	 * Nor a browser tab, and for a stronger version of the same reason. Its page
	 * is a child webview Rust is holding, so unmounting this component destroys
	 * the page — and this subtree is swapped whole on every tab switch. The
	 * controller mounts one layer per *pinned* browser tab and hides the ones
	 * that are not in front. See `BrowserTab`.
	 */
	if (isBrowserTab(props.id)) {
		return null;
	}
	if (kind === 'changes') {
		return (
			<ChangesView
				provider={props.changesProvider}
				activeDiffId={
					props.activeEditorId?.startsWith('diff:') ? props.activeEditorId : undefined
				}
				onOpenDiff={props.onOpenDiff}
			/>
		);
	}
	if (kind === 'replace') {
		/*
		 * The Replace Artifact. `replace.ts`, its check and the controller's
		 * `applyReplacements` are untouched by slice 40 — only where this view
		 * is mounted changed. Slice 44 owns find; this owns replace.
		 */
		return (
			<SearchView
				provider={props.provider}
				onOpenResult={props.onOpenFile}
				onPreviewReplace={props.onPreviewReplace}
				onApplyReplace={props.onApplyReplace}
			/>
		);
	}
	if (kind === 'problems') {
		return (
			<ProblemsView
				onOpen={props.onOpenFile}
				lspStatus={props.lsp.status}
				onRestartLsp={props.lsp.restart}
			/>
		);
	}
	if (kind === 'references') {
		return (
			<ReferencesView
				symbol={props.lsp.symbol}
				references={props.lsp.references}
				onOpen={props.onOpenFile}
			/>
		);
	}
	if (kind === 'explorer') {
		return (
			<ExplorerTree
				entries={props.entries}
				activeId={props.activeEditorId}
				onOpenFile={(entry) => props.onOpenFile(entry.id)}
				onOpenFolder={props.onOpenFolder}
				operations={props.fileOperations}
			/>
		);
	}

	/*
	 * A file artifact. The Guide: file artifacts render with Monaco in both
	 * workbenches, so this is the same editor the Modal Workbench builds, with
	 * no tab strip — the dock's own tabs are the tab strip.
	 */
	const input = props.inputs.find((candidate) => candidate.id === props.id);
	if (!input) {
		return <div className="ide-editor-empty">This file is no longer open.</div>;
	}
	return input.kind === 'diff' ? (
		<MonacoDiffEditor name={input.name} original={input.original} modified={input.modified} />
	) : (
		<MonacoEditor
			id={input.id}
			content={input.content}
			revealLine={input.revealLine}
			onChange={props.onChange}
		/>
	);
}

/** The tab a pinned id draws, whether it names a tool artifact or a file. */
export function artifactRef(
	id: string,
	inputs: readonly EditorInput[],
	/** The host each browser tab is showing, so its dock tab can say where it is. */
	hosts?: ReadonlyMap<string, string>
): ArtifactRef {
	const kind = toolArtifactKind(id);
	if (kind) {
		return TOOL_ARTIFACTS[kind];
	}
	if (isBrowserTab(id)) {
		// The host, not the id: two tabs called "Browser" tell the dev nothing,
		// and the host is the one word that says which page this is.
		return { id, title: hosts?.get(id) ?? 'Browser', icon: 'browser' };
	}
	const input = inputs.find((candidate) => candidate.id === id);
	return {
		id,
		title: input ? (input.kind === 'diff' ? `${input.name} (diff)` : input.name) : id,
		icon: input?.kind === 'diff' ? 'diff' : 'file',
	};
}
