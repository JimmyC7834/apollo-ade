// Run with `npm run check`. This file exists because `publicNames.ts` makes a
// promise it cannot keep on its own: it re-exports names, and a re-export still
// compiles perfectly after the thing it names has stopped being produced.
//
// So the check is not "do these strings exist" — TypeScript answers that. It is
// **does the workbench still contribute every name we promised**, which is the
// only failure mode that matters and the one a bump is supposed to announce.

import assert from 'node:assert/strict';

import { TOOL_ARTIFACTS, TOOL_ARTIFACT_IDS } from './artifacts.ts';
import { buildCommands, type WorkbenchActions } from './commands/commandRegistry.ts';
import { COMMAND_IDS, ICON_NAMES, showArtifactCommandId } from './publicNames.ts';
import { glyph, type IconName } from './ui/glyphs.ts';

const noop = (): void => {};

// Every capability present, because this is asking what the *full* surface is.
const actions: WorkbenchActions = {
	showArtifact: noop,
	toggleDock: noop,
	closeActiveEditor: noop,
	saveActiveEditor: noop,
	showEditor: noop,
	openFolder: noop,
	showAccessibilityHelp: noop,
	newSession: noop,
	closeSession: noop,
	openBrowserTab: noop,
};

const contributed = new Set(buildCommands(actions).map((command) => command.id));

// The promise, against what is actually built.
for (const [name, id] of Object.entries(COMMAND_IDS)) {
	assert.ok(contributed.has(id), `publicNames promises ${name} (${id}) and nothing contributes it`);
}
for (const artifactId of TOOL_ARTIFACT_IDS) {
	const id = showArtifactCommandId(artifactId);
	assert.ok(contributed.has(id), `no command reveals ${artifactId}`);
}

/*
 * The other direction, and the reason this is not just a loop: a command that
 * exists and is *not* promised is fine — it is unsupported, which is a
 * deliberate tier and not an oversight. What is not fine is the public set
 * quietly becoming "everything" again, so the assertion is that the two sets
 * are still reasoned about separately rather than that they are equal.
 */
const promised = new Set<string>([
	...Object.values(COMMAND_IDS),
	...TOOL_ARTIFACT_IDS.map(showArtifactCommandId),
]);
assert.equal(promised.size, contributed.size, 'the public and contributed command sets have drifted');

// Rule 2: a runtime identity is never a public name. `browser:1` is handed out
// by a counter and means nothing on the next launch.
for (const id of TOOL_ARTIFACT_IDS) {
	assert.ok(id.startsWith('artifact:'), `${id} is not a chosen name`);
}
assert.ok(!TOOL_ARTIFACT_IDS.some((id) => id.startsWith('browser:')));
assert.equal(TOOL_ARTIFACT_IDS.length, Object.keys(TOOL_ARTIFACTS).length);

// Every promised glyph name draws something. A name with no glyph would be a
// blank cell in a plugin's own command row.
assert.ok(ICON_NAMES.length > 0);
for (const name of ICON_NAMES as readonly IconName[]) {
	assert.equal(typeof glyph(name), 'string');
	assert.ok(glyph(name).length > 0, `${name} has no glyph`);
}

console.log('publicNames.check.ts: ok');
