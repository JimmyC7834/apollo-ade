// Run with `npm run check`. The interesting cases are the ones where the menu
// must stay *shut* — an open menu steals Enter, so a wrong one breaks sending.

import assert from 'node:assert/strict';
import { complete } from './completion.ts';

const sources = {
	skill: ['grilling', 'implement'],
	profile: ['auto', 'careful'],
	file: ['README.md', 'src/main.ts', 'src/util.ts', 'src/agent/env.ts'],
};
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

/*
 * `@` — ticket 27. The mirror image of the slash rules above: this menu is the
 * one that *must* open mid-sentence, because a file mention belongs inside a
 * request rather than instead of one. Everything else stays the same, including
 * that a fully typed entry closes the menu.
 */
{
	// Mid-sentence, and the rest of the line survives untouched — the entry
	// replaces the token, not the prompt.
	assert.deepEqual(values('read @src/ma'), ['read @src/main.ts']);
	assert.deepEqual(values('@READ'), ['@README.md']);
	// A bare `@` offers everything, so the menu is discoverable rather than
	// something you have to already know the shape of.
	assert.equal(values('@').length, 4);
	// The palette's scorer, not a second matcher: `env` finds a nested path by
	// subsequence, which a `startsWith` would miss.
	assert.deepEqual(values('look at @env'), ['look at @src/agent/env.ts']);

	// Shut. An `@` must start a word, or every email address in a prompt opens a
	// file menu over the sentence being written.
	assert.deepEqual(values('write to me@example.com'), []);
	assert.deepEqual(values('read src/main.ts'), []);
	// Past the mention: a space ends it, and the words after it are for the model.
	assert.deepEqual(values('@src/main.ts and explain it'), []);
	// Finished typing closes it, same as a command — the menu owns Enter.
	assert.deepEqual(values('@src/main.ts'), []);
	// Nothing matches, so nothing is offered rather than the whole list.
	assert.deepEqual(values('@zzzz'), []);

	// A mention inside a command line still completes. `/steer` takes free text,
	// and free text is exactly where a path belongs.
	assert.deepEqual(values('/steer look at @src/ut', true), ['/steer look at @src/util.ts']);

	// An empty workspace offers nothing and throws nothing — browser mode before
	// a folder is chosen, and every mention typed before the tree has loaded.
	assert.deepEqual(complete('@src', { ...sources, file: [] }), []);
}

console.log('agent/completion.check.ts: ok');
