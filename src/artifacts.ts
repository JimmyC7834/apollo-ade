// What an artifact is.
//
// The Shell Guide's workbench model has no `primarySidebar`, `secondarySidebar`
// or `panel`. Those three regions are where the terminal, the Changes view and
// Search + replace-across-files live today, so deleting them without putting
// something in their place would delete four working features. The dock is that
// place, and this is the model that makes it possible: everything that used to
// be a permanent panel becomes an artifact that can sit in the Modal Workbench
// or be pinned into the Pinned Workbench.
//
// Files and diffs are already modelled by `EditorInput`, which owns their
// content and their dirty state. They are not duplicated here — `kind: 'editor'`
// points at an `EditorInput` id and nothing more.

/**
 * The artifacts that are not files.
 *
 * Each one is a singleton: there is one terminal panel, one Changes view, one
 * Replace surface. Giving them ids rather than a boolean apiece is what lets
 * the dock hold "whatever is pinned" as a list instead of a set of flags.
 */
export type ToolArtifactKind = 'terminal' | 'changes' | 'replace' | 'explorer' | 'problems';

export interface ArtifactRef {
	readonly id: string;
	readonly title: string;
	/** Codicon name. The Guide's icon rule: one library, 12–16px. */
	readonly icon: string;
}

export const TOOL_ARTIFACTS: Record<ToolArtifactKind, ArtifactRef> = {
	terminal: { id: 'artifact:terminal', title: 'Terminal', icon: 'terminal' },
	changes: { id: 'artifact:changes', title: 'Changes', icon: 'source-control' },
	replace: { id: 'artifact:replace', title: 'Replace', icon: 'replace-all' },
	/*
	 * The Explorer tree, kept as an artifact rather than deleted. Slice 42
	 * replaces it with the Context Explorer, which is a different thing wearing
	 * a similar name; until that lands, deleting the tree would lose the only
	 * way to open a file that is not a search result.
	 */
	explorer: { id: 'artifact:explorer', title: 'Explorer', icon: 'files' },
	/*
	 * Errors and warnings — ticket 32. An artifact rather than a region, like
	 * everything else that used to be a panel, so it can be pinned beside the
	 * file it is complaining about.
	 */
	problems: { id: 'artifact:problems', title: 'Problems', icon: 'warning' },
};

export const TOOL_ARTIFACT_IDS = Object.values(TOOL_ARTIFACTS).map((artifact) => artifact.id);

export function isToolArtifact(id: string): boolean {
	return id.startsWith('artifact:');
}

/** Which of the four a tool-artifact id names, or undefined for a file. */
export function toolArtifactKind(id: string): ToolArtifactKind | undefined {
	return (Object.keys(TOOL_ARTIFACTS) as ToolArtifactKind[]).find(
		(kind) => TOOL_ARTIFACTS[kind].id === id
	);
}

/**
 * Where the dock sits, and therefore which edge resizes it.
 *
 * Landscape is the default; portrait is also what a window narrower than 760px
 * gets, because a dock beside a 300px chat column is not a dock.
 */
export type DockSide = 'right' | 'bottom';

export const PORTRAIT_BREAKPOINT = 760;

export function dockSide(width: number, height: number): DockSide {
	return width < PORTRAIT_BREAKPOINT || height > width ? 'bottom' : 'right';
}

/** The Guide's bounds: never below a quarter, never above two thirds. */
export const DOCK_MIN_FRACTION = 0.24;
export const DOCK_MAX_FRACTION = 0.65;

export function clampDock(fraction: number): number {
	return Math.min(DOCK_MAX_FRACTION, Math.max(DOCK_MIN_FRACTION, fraction));
}
