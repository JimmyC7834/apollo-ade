// Run with `npm run check`. The distinction this guards is easy to collapse by
// accident: a capability that is absent must not appear in the palette, but a
// capability that is merely blocked must appear, with its reason.

import assert from 'node:assert/strict';

import { buildCommands, commandLabel, type WorkbenchActions } from './commandRegistry.ts';

const noop = (): void => {};

const base: WorkbenchActions = {
	togglePrimarySidebar: noop,
	toggleSecondarySidebar: noop,
	togglePanel: noop,
	closeActiveEditor: noop,
	saveActiveEditor: noop,
	showExplorer: noop,
	showSearch: noop,
	showEditor: noop,
	openFolder: undefined,
	showAccessibilityHelp: noop,
};

const find = (actions: WorkbenchActions) =>
	buildCommands(actions).find((command) => command.id === 'file.openFolder');

// Browser mode: no folder can ever be opened, so the entry is absent.
assert.equal(find(base), undefined);

// Native, nothing unsaved: present and runnable.
let ran = 0;
const enabled = find({ ...base, openFolder: () => (ran += 1) });
assert.ok(enabled);
assert.equal(enabled.disabled, undefined);
enabled.run();
assert.equal(ran, 1);

/*
 * **Nothing disables it any more**, and the `openFolderDisabled` field is gone
 * with the state it described: since ticket 49 a folder can always be opened —
 * choosing one starts a conversation there, and the editors of the folder you
 * leave are kept rather than discarded, so unsaved work is no longer a reason to
 * refuse. The capability test above is the whole of the rule now.
 */
assert.equal(commandLabel(enabled), 'File: Open Folder');

// The editor command still uses the blocked-not-hidden rule: it always exists,
// and says why when there is nothing to show.
const editor = (actions: WorkbenchActions) =>
	buildCommands(actions).find((command) => command.id === 'view.showEditor');
assert.equal(editor(base)?.disabled, undefined);
assert.equal(editor({ ...base, showEditorDisabled: 'No open editors' })?.disabled, 'No open editors');
// Every command is addressable and uniquely identified.
const ids = buildCommands({ ...base, openFolder: noop }).map((command) => command.id);
assert.equal(new Set(ids).size, ids.length);

console.log('commandRegistry.check.ts: ok');
