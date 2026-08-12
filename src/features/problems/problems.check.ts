import assert from 'node:assert/strict';

import {
	MARKER_SEVERITY,
	groupProblems,
	problemLabel,
	problemSummary,
	severityOf,
	type Problem,
} from './problems.ts';

function problem(over: Partial<Problem> = {}): Problem {
	return {
		fileId: 'src/a.ts',
		severity: 'error',
		message: 'Type error',
		line: 1,
		column: 1,
		...over,
	};
}

{
	assert.equal(severityOf(MARKER_SEVERITY.error), 'error');
	assert.equal(severityOf(MARKER_SEVERITY.warning), 'warning');
	// A hint is not a problem. Putting them in the list is how the list stops
	// being read.
	assert.equal(severityOf(MARKER_SEVERITY.hint), undefined);
	assert.equal(severityOf(MARKER_SEVERITY.info), undefined);
}

{
	const files = groupProblems([
		problem({ fileId: 'src/b.ts', severity: 'warning', line: 9 }),
		problem({ fileId: 'src/a.ts', line: 4 }),
		problem({ fileId: 'src/a.ts', severity: 'warning', line: 2 }),
		problem({ fileId: 'src/a.ts', line: 1 }),
	]);

	assert.equal(files.length, 2);
	// The file with errors leads.
	assert.equal(files[0]?.id, 'src/a.ts');
	assert.equal(files[0]?.name, 'a.ts', 'the tree shows names, not paths');
	assert.deepEqual(
		files[0]?.problems.map((item) => [item.severity, item.line]),
		[
			['error', 1],
			['error', 4],
			['warning', 2],
		],
		'errors before warnings, then by line'
	);
	assert.equal(files[0]?.errors, 2);
	assert.equal(files[0]?.warnings, 1);
	assert.equal(files[1]?.errors, 0);
}

{
	// One file, two models: open in the Modal Workbench and pinned in the dock
	// at the same time. One mistake must not be listed twice.
	const twice = groupProblems([problem(), problem()]);
	assert.equal(twice[0]?.problems.length, 1);
	assert.equal(twice[0]?.errors, 1);

	// Same line, different message, is two problems.
	const distinct = groupProblems([problem(), problem({ message: 'Another' })]);
	assert.equal(distinct[0]?.problems.length, 2);
}

{
	assert.equal(problemSummary([]), 'No problems');
	assert.equal(problemSummary(groupProblems([problem()])), '1 error');
	assert.equal(
		problemSummary(groupProblems([problem(), problem({ line: 2 })])),
		'2 errors'
	);
	assert.equal(
		problemSummary(groupProblems([problem(), problem({ severity: 'warning', line: 2 })])),
		'1 error, 1 warning'
	);
	assert.equal(
		problemSummary(groupProblems([problem({ severity: 'warning' })])),
		'1 warning',
		'no empty error clause'
	);
}

{
	assert.equal(problemLabel(problem({ message: 'Bad', line: 3, column: 7 })), 'Bad (3:7)');
}

console.log('problems.check.ts ok');
