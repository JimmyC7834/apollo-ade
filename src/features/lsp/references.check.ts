import assert from 'node:assert/strict';

import { groupReferences, referenceLabel, referenceSummary, type Reference } from './references.ts';

function reference(over: Partial<Reference> = {}): Reference {
	return { fileId: 'src/a.rs', line: 1, column: 1, ...over };
}

{
	const files = groupReferences([
		reference({ fileId: 'src/b.rs', line: 9 }),
		reference({ line: 4 }),
		reference({ line: 2, column: 8 }),
		reference({ line: 2, column: 3 }),
	]);

	assert.deepEqual(
		files.map((file) => file.id),
		['src/a.rs', 'src/b.rs']
	);
	assert.equal(files[0]?.name, 'a.rs', 'the tree shows names, not paths');
	assert.deepEqual(
		files[0]?.references.map((item) => [item.line, item.column]),
		[
			[2, 3],
			[2, 8],
			[4, 1],
		],
		'by line, then by column within a line'
	);
}

{
	// One file open twice, and a declaration reported as a reference to itself.
	const files = groupReferences([reference(), reference(), reference({ column: 2 })]);
	assert.equal(files[0]?.references.length, 2);
}

{
	assert.equal(referenceSummary([]), 'No references');
	assert.equal(referenceSummary(groupReferences([reference()])), '1 reference in 1 file');
	assert.equal(
		referenceSummary(groupReferences([reference(), reference({ fileId: 'src/b.rs' })])),
		'2 references in 2 files'
	);
}

{
	assert.equal(referenceLabel(reference({ preview: '    let total = 1;' })), 'let total = 1;');
	// A file that is not open has no text to show, so the position is the label
	// rather than an empty row.
	assert.equal(referenceLabel(reference({ line: 12 })), 'Line 12');
	assert.equal(referenceLabel(reference({ line: 12, preview: '   ' })), 'Line 12');
}

console.log('references.check.ts ok');
