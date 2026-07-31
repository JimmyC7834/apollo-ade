/*
 * Commands are data plus callbacks. The command center renders whatever is in
 * this list and never asks what a command means — no `if (id === 'toggle...')`
 * branches in the UI, which is what keeps the palette and the keybindings from
 * drifting apart as features are added.
 */

export interface Command {
	readonly id: string;
	/** Shown in the palette; also what the query is matched against. */
	readonly title: string;
	/** Optional grouping prefix, rendered muted, e.g. "View". */
	readonly category?: string;
	readonly run: () => void;
}

/** The full label used for matching and display: "View: Toggle Panel". */
export function commandLabel(command: Command): string {
	return command.category ? `${command.category}: ${command.title}` : command.title;
}

export interface WorkbenchActions {
	togglePrimarySidebar: () => void;
	toggleSecondarySidebar: () => void;
	togglePanel: () => void;
	closeActiveEditor: () => void;
	saveActiveEditor: () => void;
	showExplorer: () => void;
	showSearch: () => void;
	openFolder: (() => void) | undefined;
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
		// Omitted rather than shown-and-disabled: in the browser there is no
		// folder to open, and an unrunnable palette entry is just noise.
		...(openFolder
			? [{ id: 'file.openFolder', category: 'File', title: 'Open Folder', run: openFolder }]
			: []),
		{
			id: 'file.save',
			category: 'File',
			title: 'Save',
			run: actions.saveActiveEditor,
		},
		{
			id: 'view.showExplorer',
			category: 'View',
			title: 'Show Explorer',
			run: actions.showExplorer,
		},
		{
			id: 'view.showSearch',
			category: 'View',
			title: 'Show Search',
			run: actions.showSearch,
		},
		{
			id: 'view.togglePrimarySidebar',
			category: 'View',
			title: 'Toggle Primary Sidebar',
			run: actions.togglePrimarySidebar,
		},
		{
			id: 'view.toggleSecondarySidebar',
			category: 'View',
			title: 'Toggle Secondary Sidebar',
			run: actions.toggleSecondarySidebar,
		},
		{
			id: 'view.togglePanel',
			category: 'View',
			title: 'Toggle Panel',
			run: actions.togglePanel,
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
