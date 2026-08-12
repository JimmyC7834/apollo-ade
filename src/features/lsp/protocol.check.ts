import assert from 'node:assert/strict';

import { MARKER_SEVERITY } from '../problems/problems.ts';
import {
	fileIdFromUri,
	fileUri,
	toEditorPosition,
	toEditorRange,
	toLspPosition,
	toMarkerSeverity,
	toProblemSeverity,
} from './protocol.ts';

{
	// Off by one in either direction is a cursor that lands on the wrong line
	// and a diagnostic that underlines the wrong word.
	assert.deepEqual(toEditorPosition({ line: 0, character: 0 }), { lineNumber: 1, column: 1 });
	assert.deepEqual(toLspPosition({ lineNumber: 1, column: 1 }), { line: 0, character: 0 });
	assert.deepEqual(toLspPosition(toEditorPosition({ line: 12, character: 4 })), {
		line: 12,
		character: 4,
	});
	assert.deepEqual(
		toEditorRange({ start: { line: 2, character: 3 }, end: { line: 2, character: 9 } }),
		{ startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 10 }
	);
}

{
	assert.equal(toMarkerSeverity(1), MARKER_SEVERITY.error);
	assert.equal(toMarkerSeverity(2), MARKER_SEVERITY.warning);
	assert.equal(toMarkerSeverity(3), undefined, 'information is not a problem');
	assert.equal(toMarkerSeverity(4), undefined, 'nor is a hint');
	// The specification's default, and the one that fails dangerously if it is
	// guessed the other way: a dropped error is a mistake nobody is shown.
	assert.equal(toMarkerSeverity(undefined), MARKER_SEVERITY.error);

	assert.equal(toProblemSeverity(1), 'error');
	assert.equal(toProblemSeverity(2), 'warning');
	assert.equal(toProblemSeverity(4), undefined);
}

{
	// Windows: three slashes, forward separators, lowercased drive.
	assert.equal(fileUri('C:\\work\\repo', 'src/a.rs'), 'file:///c:/work/repo/src/a.rs');
	assert.equal(fileUri('C:\\work\\repo\\', 'src/a.rs'), 'file:///c:/work/repo/src/a.rs');
	assert.equal(fileUri('/home/j/repo', 'src/a.rs'), 'file:///home/j/repo/src/a.rs');
	// A `#` in a filename would otherwise start a fragment and truncate the path.
	assert.equal(fileUri('/r', 'a#b.rs'), 'file:///r/a%23b.rs');
	// A separator must survive encoding as a separator.
	assert.equal(fileUri('/r', 'a/b/c.rs'), 'file:///r/a/b/c.rs');
}

{
	const root = 'C:\\work\\repo';
	assert.equal(fileIdFromUri(root, 'file:///c:/work/repo/src/a.rs'), 'src/a.rs');
	// The drive letter's case is the one thing servers are reliably inconsistent
	// about, and a mismatch here reads to the user as "go to definition is broken".
	assert.equal(fileIdFromUri(root, 'file:///C:/work/repo/src/a.rs'), 'src/a.rs');
	assert.equal(fileIdFromUri(root, fileUri(root, 'src/a.rs')), 'src/a.rs', 'round trip');
	assert.equal(fileIdFromUri('/home/j/repo', 'file:///home/j/repo/src/a.rs'), 'src/a.rs');
	assert.equal(fileIdFromUri('/r', 'file:///r/a%23b.rs'), 'a#b.rs');

	// Containment. Every one of these is a real place rust-analyzer sends a
	// definition to, and every one of them must fail rather than widen the root.
	assert.equal(fileIdFromUri(root, 'file:///c:/Users/j/.cargo/registry/src/x.rs'), undefined);
	assert.equal(fileIdFromUri(root, 'file:///c:/work/repo-other/src/a.rs'), undefined, 'prefix is not containment');
	assert.equal(fileIdFromUri(root, 'file:///c:/work/repo/../out.rs'), undefined);
	assert.equal(fileIdFromUri(root, 'file:///c:/work/repo'), undefined, 'the root is not a file in it');
	assert.equal(fileIdFromUri(root, 'untitled:Untitled-1'), undefined, 'not a file at all');
	assert.equal(fileIdFromUri(root, 'file:///c:/work/repo/a%GG.rs'), 'a%GG.rs', 'a stray % is not fatal');
}

console.log('protocol.check.ts ok');
