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
	/** Undefined where the capability does not exist at all, as in the browser. */
	openFolder: (() => void) | undefined;
	/** Set when a folder could be opened but not right now. */
	openFolderDisabled?: string;
	showAccessibilityHelp: () => void;
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
						id: 'file.openFolder',
						category: 'File',
						title: 'Open Folder',
						disabled: actions.openFolderDisabled,
						run: openFolder,
					},
				]
			: []),
		{
			id: 'file.save',
			category: 'File',
			title: 'Save',
			run: actions.saveActiveEditor,
		},
		{
			id: 'view.showEditor',
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
			id: `view.show.${artifact.id}`,
			category: 'View',
			title: `Show ${artifact.title}`,
			run: () => actions.showArtifact(artifact.id),
		})),
		{
			id: 'view.toggleDock',
			category: 'View',
			title: 'Toggle Artifact Dock',
			run: actions.toggleDock,
		},
		{
			id: 'editor.closeActive',
			category: 'Editor',
			title: 'Close Active Editor',
			run: actions.closeActiveEditor,
		},
		{
			id: 'help.accessibility',
			category: 'Help',
			title: 'Show Keyboard Help',
			run: actions.showAccessibilityHelp,
		},
	];
}
