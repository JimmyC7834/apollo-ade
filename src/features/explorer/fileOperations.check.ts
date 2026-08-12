import assert from 'node:assert/strict';

import {
	childId,
	deleteMessage,
	movedId,
	nameProblem,
	renamedId,
} from './fileOperations.ts';

// A name is a name, not a path. Rust refuses the rest anyway; this is what
// turns the refusal into a message beside the field.
{
	assert.equal(nameProblem('notes.md'), undefined);
	assert.equal(nameProblem('  notes.md  '), undefined, 'trimmed before judging');
	assert.match(nameProblem('') ?? '', /Give it a name/);
	assert.match(nameProblem('   ') ?? '', /Give it a name/);
	assert.match(nameProblem('a/b.ts') ?? '', /slash/);
	assert.match(nameProblem('..\\out.txt') ?? '', /slash/, 'both separators');
	assert.match(nameProblem('..') ?? '', /reserved/);
	assert.match(nameProblem('.') ?? '', /reserved/);
}

{
	assert.equal(childId('src', 'a.ts'), 'src/a.ts');
	assert.equal(childId(undefined, 'a.ts'), 'a.ts', 'the root has no prefix');
	assert.equal(childId('src', '  a.ts '), 'src/a.ts');
	assert.equal(renamedId('src/a.ts', 'b.ts'), 'src/b.ts');
	assert.equal(renamedId('a.ts', 'b.ts'), 'b.ts', 'at the root too');
}

{
	// Renaming a folder has to move every open editor underneath it.
	assert.equal(movedId('src/a.ts', 'src', 'lib'), 'lib/a.ts');
	assert.equal(movedId('src/deep/a.ts', 'src', 'lib'), 'lib/deep/a.ts');
	assert.equal(movedId('src', 'src', 'lib'), 'lib', 'the folder itself');

	// The whole reason this is a function: a prefix test without the slash
	// would drag the neighbour along.
	assert.equal(movedId('src-old/a.ts', 'src', 'lib'), undefined);
	assert.equal(movedId('other/a.ts', 'src', 'lib'), undefined);
	assert.equal(movedId('srcx', 'src', 'lib'), undefined);
}

{
	// The message has to say the delete is recoverable — that is the fact the
	// click actually turns on.
	const file = deleteMessage('src/a.ts', { kind: 'file', entries: 0, capped: false }, true);
	assert.match(file, /Delete a\.ts\?/, 'the name, not the path');
	assert.match(file, /trash/);
	assert.doesNotMatch(file, /inside/, 'a file has nothing under it');

	const empty = deleteMessage('src/empty', { kind: 'directory', entries: 0, capped: false }, true);
	assert.match(empty, /It is empty\./);

	const one = deleteMessage('src/one', { kind: 'directory', entries: 1, capped: false }, true);
	assert.match(one, /1 item inside it/, 'singular');

	const many = deleteMessage('src/many', { kind: 'directory', entries: 12, capped: false }, true);
	assert.match(many, /12 items inside it, and they go too/);

	// A capped count is a floor, and must not be shown as a total.
	const capped = deleteMessage(
		'node_modules',
		{ kind: 'directory', entries: 10_000, capped: true },
		true
	);
	assert.match(capped, /more than 10000 items/);

	// The trash makes the file recoverable. An unsaved buffer is the one thing
	// in this operation that is not, so it has to be said.
	assert.doesNotMatch(file, /unsaved/, 'nothing open, nothing to warn about');
	const dirtyOne = deleteMessage(
		'src/a.ts',
		{ kind: 'file', entries: 0, capped: false, unsaved: 1 },
		true
	);
	assert.match(dirtyOne, /1 open editor has unsaved changes, and those are lost/);
	const dirtyTwo = deleteMessage(
		'src',
		{ kind: 'directory', entries: 3, capped: false, unsaved: 2 },
		true
	);
	assert.match(dirtyTwo, /2 open editors have unsaved changes/);
	assert.match(dirtyTwo, /3 items inside it/, 'and still says what it takes');

	// A workspace with no trash must not promise one. The browser fixture is the
	// case, and "you can put it back" is the sentence that would change a mind.
	const gone = deleteMessage('src/a.ts', { kind: 'file', entries: 0, capped: false }, false);
	assert.match(gone, /no trash, so it is simply gone/);
	assert.doesNotMatch(gone, /put it back/);
}

console.log('fileOperations.check.ts ok');
