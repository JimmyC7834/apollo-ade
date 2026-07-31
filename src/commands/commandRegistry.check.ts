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
	showAgent: noop,
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

// Native, unsaved work: still present, carrying the reason. This is the case
// that used to vanish from the palette entirely.
const blocked = find({
	...base,
	openFolder: noop,
	openFolderDisabled: 'Save your changes first',
});
assert.ok(blocked);
assert.equal(blocked.disabled, 'Save your changes first');

// A disabled reason on its own must not conjure an entry that has no capability.
assert.equal(find({ ...base, openFolderDisabled: 'Save your changes first' }), undefined);

assert.equal(commandLabel(blocked), 'File: Open Folder');
// Every command is addressable and uniquely identified.
const ids = buildCommands({ ...base, openFolder: noop }).map((command) => command.id);
assert.equal(new Set(ids).size, ids.length);

console.log('commandRegistry.check.ts: ok');
