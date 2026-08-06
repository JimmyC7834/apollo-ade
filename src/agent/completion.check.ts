// Run with `npm run check`. The interesting cases are the ones where the menu
// must stay *shut* — an open menu steals Enter, so a wrong one breaks sending.

import assert from 'node:assert/strict';
import { complete } from './completion.ts';

const sources = { skill: ['grilling', 'implement'], profile: ['auto', 'careful'] };
const values = (text: string, running = false) =>
	complete(text, sources, running).map((entry) => entry.value);

// The first word: the command names, best first.
assert.deepEqual(values('/prof'), ['/profile ']);
assert.ok(values('/').length > 0);
// A command with an argument leaves a space, so accepting it opens menu two.
assert.deepEqual(values('/skil')[0], '/skill ');

// Finished typing closes the menu, because the menu owns Enter while it is open
// and an entry that changes nothing would cost a second press to send.
assert.deepEqual(values('/compact'), []);
assert.deepEqual(values('/skill grilling'), []);

// The second word: the argument's own list, and the whole line comes back.
assert.deepEqual(values('/skill '), ['/skill grilling', '/skill implement']);
assert.deepEqual(values('/skill gr'), ['/skill grilling']);
assert.deepEqual(values('/profile car'), ['/profile careful']);

// Shut. Prose is not a command; free text is not a name; and past the argument
// everything belongs to the model.
assert.deepEqual(values('read the file'), []);
assert.deepEqual(values('see /profile for that'), []);
assert.deepEqual(values('/steer stop'), []);
assert.deepEqual(values('/skill grilling this plan'), []);
assert.deepEqual(values('/compact '), []);
assert.deepEqual(values('/nonsense arg'), []);

// The menu says what `send` would accept, in both directions: offering a
// command that is about to be refused is a menu that lies.
assert.deepEqual(values('/', true), ['/steer ']);
assert.deepEqual(values('/comp', true), []);
assert.deepEqual(values('/steer', false), []);
// Including the argument, which the first-word filter does not cover: a user can
// type `/skill ` in full while a turn runs, and completing it would finish a
// line that is then refused.
assert.deepEqual(values('/skill gr', true), []);
assert.deepEqual(values('/profile ', true), []);

console.log('agent/completion.check.ts: ok');
