import assert from 'node:assert/strict';

import { applyEdits, planWorkspaceEdit, toReplacement, type LspWorkspaceEdit } from './workspaceEdit.ts';

const ROOT = 'C:\\work\\repo';

function edit(line: number, from: number, to: number, newText: string) {
	return { range: { start: { line, character: from }, end: { line, character: to } }, newText };
}

{
	const text = 'let total = 1;\nlet next = total + total;\n';
	// Three occurrences of `total`, renamed to `sum`. The two on line 1 are the
	// case that goes wrong when edits are applied top-first: the first one
	// shifts the second by two characters.
	const applied = applyEdits(text, [
		edit(0, 4, 9, 'sum'),
		edit(1, 11, 16, 'sum'),
		edit(1, 19, 24, 'sum'),
	]);
	assert.equal(applied?.text, 'let sum = 1;\nlet next = sum + sum;\n');
	assert.equal(applied?.count, 3);

	// Order in is irrelevant; the sort is what makes that true.
	assert.equal(
		applyEdits(text, [edit(1, 19, 24, 'sum'), edit(0, 4, 9, 'sum'), edit(1, 11, 16, 'sum')])?.text,
		applied?.text
	);
}

{
	// CRLF. Line starts are computed from `\n`, so the `\r` sits past every
	// position a server names — a file that gained a stray `\r` per line would
	// be corruption nobody notices until git shows the whole file changed.
	const applied = applyEdits('let a = 1;\r\nlet b = a;\r\n', [edit(0, 4, 5, 'x'), edit(1, 8, 9, 'x')]);
	assert.equal(applied?.text, 'let x = 1;\r\nlet b = x;\r\n');
}

{
	// A multi-line range, and an insertion (empty range).
	assert.equal(
		applyEdits('a\nb\nc\n', [
			{ range: { start: { line: 0, character: 1 }, end: { line: 2, character: 0 } }, newText: 'Z' },
		])?.text,
		'aZc\n'
	);
	assert.equal(applyEdits('ac', [edit(0, 1, 1, 'b')])?.text, 'abc');
}

{
	// Overlaps are refused, not resolved. The spec forbids them, so an overlap
	// means the server and this client disagree about the document.
	assert.equal(applyEdits('abcdef', [edit(0, 0, 4, 'X'), edit(0, 2, 6, 'Y')]), undefined);
	assert.equal(applyEdits('abcdef', [edit(0, 4, 2, 'X')]), undefined, 'inverted range');
	// Touching at the boundary is not overlapping.
	assert.equal(applyEdits('abcdef', [edit(0, 0, 3, 'X'), edit(0, 3, 6, 'Y')])?.text, 'XY');
}

{
	// A position past the end of the line is clamped rather than fatal — a
	// server one keystroke stale must not abort the rename, because the check
	// that actually protects the file is ticket 30's contents comparison.
	assert.equal(applyEdits('ab\n', [edit(0, 1, 99, 'X')])?.text, 'aX\n');
	assert.equal(applyEdits('ab\n', [edit(99, 0, 0, 'X')])?.text, 'ab\nX');
}

{
	const plan = planWorkspaceEdit(
		{
			changes: {
				'file:///c:/work/repo/src/b.rs': [edit(0, 0, 1, 'x')],
				'file:///c:/work/repo/src/a.rs': [edit(0, 0, 1, 'x')],
			},
		},
		ROOT
	);
	assert.equal(plan.ok, true);
	assert.deepEqual(plan.ok && plan.files.map((file) => file.id), ['src/a.rs', 'src/b.rs']);
}

{
	// `documentChanges` is the newer shape and the one rust-analyzer sends.
	const plan = planWorkspaceEdit(
		{
			documentChanges: [
				{ textDocument: { uri: 'file:///c:/work/repo/src/a.rs', version: 1 }, edits: [edit(0, 0, 1, 'x')] },
			],
		},
		ROOT
	);
	assert.equal(plan.ok, true);
	assert.equal(plan.ok && plan.files[0]?.id, 'src/a.rs');
}

{
	// A file rename inside the edit. The preview carries contents, not file
	// operations, so this is refused whole and said out loud.
	const moves: LspWorkspaceEdit = {
		documentChanges: [{ kind: 'rename', oldUri: 'file:///c:/work/repo/src/a.rs', newUri: 'file:///c:/work/repo/src/b.rs' }],
	};
	const plan = planWorkspaceEdit(moves, ROOT);
	assert.equal(plan.ok, false);
	assert.match(plan.ok === false ? plan.reason : '', /moves or deletes files/);
}

{
	// One edit outside the root refuses the whole rename. Applying the rest
	// would rename the symbol everywhere except where it is defined.
	const plan = planWorkspaceEdit(
		{
			changes: {
				'file:///c:/work/repo/src/a.rs': [edit(0, 0, 1, 'x')],
				'file:///c:/Users/j/.cargo/registry/src/x.rs': [edit(0, 0, 1, 'x')],
			},
		},
		ROOT
	);
	assert.equal(plan.ok, false);
	assert.match(plan.ok === false ? plan.reason : '', /outside the workspace/);
}

{
	assert.equal(planWorkspaceEdit({}, ROOT).ok, false, 'no edits is not a rename');
}

{
	const replacement = toReplacement('src/a.rs', 'let total = 1;\n', [edit(0, 4, 9, 'sum')]);
	assert.equal(replacement?.name, 'a.rs');
	assert.equal(replacement?.original, 'let total = 1;\n');
	assert.equal(replacement?.modified, 'let sum = 1;\n');
	assert.equal(replacement?.count, 1);

	// A file the edits do not change is not listed. A file in a preview reads
	// as a file about to be written.
	assert.equal(toReplacement('src/a.rs', 'let total = 1;\n', [edit(0, 4, 9, 'total')]), undefined);
	assert.equal(toReplacement('src/a.rs', 'abcdef', [edit(0, 0, 4, 'X'), edit(0, 2, 6, 'Y')]), undefined);
}

console.log('workspaceEdit.check.ts ok');
