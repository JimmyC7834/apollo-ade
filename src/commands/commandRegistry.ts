/*
 * Commands are data plus callbacks. The command center renders whatever is in
 * this list and never asks what a command means — no `if (id === 'toggle...')`
 * branches in the UI, which is what keeps the palette and the keybindings from
 * drifting apart as features are added.
 */

import { TOOL_ARTIFACTS } from '../artifacts.ts';

const TOOL_ARTIFACT_LIST = Object.values(TOOL_ARTIFACTS);

export interface Command {
	readonly id: string;
	/** Shown in the palette; also what the query is matched against. */
	readonly title: string;
	/** Optional grouping prefix, rendered muted, e.g. "View". */
	readonly category?: string;
	/**
	 * Why this command cannot run right now. Present means unrunnable: the
	 * palette shows it with the reason instead of hiding it. A command that
	 * exists but is temporarily blocked must stay visible — silently vanishing
	 * looks identical to never having existed.
	 */
	readonly disabled?: string;
	readonly run: () => void;
}

/**
 * The ids, named once.
 *
 * They were literals inside `buildCommands` until ticket 71, and they still
 * could be — except that a plugin may now *say* one of these strings, which
 * makes them an API rather than an internal label. `publicNames.ts` re-exports
 * this object; a rename here is an `api` bump.
 */
export const COMMAND_IDS = {
	openFolder: 'file.openFolder',
	newSession: 'session.new',
	closeSession: 'session.close',
	save: 'file.save',
	showEditor: 'view.showEditor',
	browser: 'view.browser',
	toggleDock: 'view.toggleDock',
	closeActiveEditor: 'editor.closeActive',
	accessibility: 'help.accessibility',
} as const;

/**
 * The id of the command that reveals one artifact.
 *
 * Derived rather than listed, because the artifacts themselves are the list —
 * adding one has always added its command for free, and writing them out here
 * would be the second place that fact lives.
 */
export function showArtifactCommandId(artifactId: string): string {
	return `view.show.${artifactId}`;
}

/** The full label used for matching and display: "View: Toggle Panel". */
export function commandLabel(command: Command): string {
	return command.category ? `${command.category}: ${command.title}` : command.title;
}

export interface WorkbenchActions {
	/** Pin an artifact into the dock, or raise it if it is already there. */
	showArtifact: (id: string) => void;
	toggleDock: () => void;
	closeActiveEditor: () => void;
	saveActiveEditor: () => void;
	/** Raise the editor dialog over the workbench. */
	showEditor: () => void;
	/** Set when the editor could be raised but has nothing to show. */
	showEditorDisabled?: string;
	/**
	 * Undefined where the capability does not exist at all, as in the browser.
	 *
	 * Never merely *disabled*: since ticket 49 a folder can always be opened —
	 * choosing one starts a conversation there and the editors of the folder you
	 * leave are kept rather than discarded, so there is nothing left to refuse on.
	 */
	openFolder: (() => void) | undefined;
	showAccessibilityHelp: () => void;
	/** A conversation of its own, in the root you are in — ticket 47. */
	newSession: () => void;
	/** Stop watching the focused conversation. The file stays on disk. */
	closeSession: () => void;
	/** A page in the dock, for looking at the app under development — ticket 69. */
	openBrowserTab: () => void;
}

/*
 * ponytail: a builder over the workbench's own actions, not a mutable
 * registry with register/unregister. Nothing contributes commands dynamically
 * yet. Add registration when a feature needs to contribute commands it owns —
 * the Command shape stays the same either way, so the palette will not change.
 */
export function buildCommands(actions: WorkbenchActions): readonly Command[] {
	const { openFolder } = actions;
	return [
		// Omitted only where the capability is absent: in the browser there is
		// no folder to open at all, and an entry that can never run is noise.
		// A capability that exists but is blocked is shown with its reason.
		...(openFolder
			? [
					{
						id: COMMAND_IDS.openFolder,
						category: 'File',
						title: 'Open Folder',
						run: openFolder,
					},
				]
			: []),
		{
			id: COMMAND_IDS.newSession,
			category: 'Session',
			title: 'New Session',
			run: actions.newSession,
		},
		{
			id: COMMAND_IDS.closeSession,
			category: 'Session',
			title: 'Close Session',
			run: actions.closeSession,
		},
		{
			id: COMMAND_IDS.save,
			category: 'File',
			title: 'Save',
			run: actions.saveActiveEditor,
		},
		{
			id: COMMAND_IDS.showEditor,
			category: 'View',
			title: 'Show Editor',
			disabled: actions.showEditorDisabled,
			run: actions.showEditor,
		},
		/*
		 * One command per artifact, from `TOOL_ARTIFACTS`, rather than one per
		 * region. Slice 40 replaced the three regions with the dock; these are
		 * how the features that lived in them are still reachable from the
		 * palette. Adding an artifact adds its command for free — which is how
		 * References arrived with ticket 34 and needed nothing here.
		 */
		...TOOL_ARTIFACT_LIST.map((artifact) => ({
			id: showArtifactCommandId(artifact.id),
			category: 'View',
			title: `Show ${artifact.title}`,
			run: () => actions.showArtifact(artifact.id),
		})),
		{
			id: COMMAND_IDS.browser,
			category: 'View',
			title: 'Open a Browser Tab',
			run: actions.openBrowserTab,
		},
		{
			id: COMMAND_IDS.toggleDock,
			category: 'View',
			title: 'Toggle Artifact Dock',
			run: actions.toggleDock,
		},
		{
			id: COMMAND_IDS.closeActiveEditor,
			category: 'Editor',
			title: 'Close Active Editor',
			run: actions.closeActiveEditor,
		},
		{
			id: COMMAND_IDS.accessibility,
			category: 'Help',
			title: 'Show Keyboard Help',
			run: actions.showAccessibilityHelp,
		},
	];
}
