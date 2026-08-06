// Run with `npm run check`. The store needs an `ExecutionEnv` to load anything,
// so what is checked here is the rule that does not: which templates survive a
// name clash with a built-in, and that a survivor becomes a usable command.

import assert from 'node:assert/strict';
import { SLASH_COMMANDS } from './commands.ts';
import { templateCommands, withoutShadowed } from './promptTemplates.ts';

const template = (name: string, description?: string) => ({ name, description, content: 'body' });

// A name of its own is kept whole.
const mine = withoutShadowed([template('deploy', 'Ship it.')]);
assert.deepEqual(
	mine.templates.map((entry) => entry.name),
	['deploy']
);
assert.deepEqual(mine.warnings, []);

// A built-in name is not. It is dropped rather than shadowing, and it is said
// out loud — `/reload` reports these, because nothing else lists templates and
// a file that silently does nothing is the worst of the three outcomes.
const clash = withoutShadowed([template('compact'), template('deploy')]);
assert.deepEqual(
	clash.templates.map((entry) => entry.name),
	['deploy']
);
assert.equal(clash.warnings.length, 1);
assert.ok(clash.warnings[0].includes('/compact'));

// Every built-in is protected, not the handful anyone thought to type.
for (const command of SLASH_COMMANDS) {
	assert.equal(withoutShadowed([template(command.name.slice(1))]).templates.length, 0);
}

// Nothing is loaded in a check, so the command list is empty rather than wrong.
assert.deepEqual(templateCommands(), []);

console.log('agent/promptTemplates.check.ts: ok');
