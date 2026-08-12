import assert from 'node:assert/strict';

import { undoNote } from './undo.ts';

// The note is the only thing standing between an undo and a model that believes
// an edit survives. Every branch of it is asserted for that reason.

{
	const note = undoNote({ restored: ['src/a.ts'], removed: [], told: true });
	assert.match(note, /1 file restored \(src\/a\.ts\)/, 'singular, and names the file');
	assert.match(note, /Untracked files were not touched/);
	assert.match(note, /edits made during it are gone from disk/, 'says it plainly');
}

{
	const note = undoNote({ restored: ['a.ts', 'b.ts'], removed: ['c.ts'], told: true });
	assert.match(note, /2 files restored \(a\.ts, b\.ts\)/);
	assert.match(note, /1 file removed \(c\.ts\)/);
}

{
	// Five names is four too many for a context window; three then a count.
	const note = undoNote({
		restored: ['a', 'b', 'c', 'd', 'e'],
		removed: [],
		told: true,
	});
	assert.match(note, /5 files restored \(a, b, c and 2 more\)/);
}

{
	// The clean case has to read as a fact rather than as a failure: the turn
	// really did change nothing on disk.
	const note = undoNote({ restored: [], removed: [], told: true });
	assert.match(note, /Nothing on disk had changed/);
	assert.doesNotMatch(note, /Untracked/, 'nothing to caveat when nothing moved');
}

{
	// The failure the spec review found: the tree is already back, so the note
	// must still be produced — and must say the model was not told, because
	// silence here is exactly the state ticket 28 forbids.
	const note = undoNote({ restored: ['a.ts'], removed: [], told: false });
	assert.match(note, /1 file restored/, 'still says what happened to the files');
	assert.match(note, /could not be recorded in the agent's context/);
	assert.match(note, /still\s+believes those edits exist/);
	assert.match(note, /Say so in your next message/, 'and what to do about it');
}

console.log('undo.check.ts ok');
