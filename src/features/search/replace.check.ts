// Run with `npm run check`. Everything here is a way to lose a file: an empty
// query that splices itself between every character, a case-insensitive match
// that eats the wrong span, and an apply that writes over an edit made after
// the preview was built.

import assert from 'node:assert/strict';
import { planFile, planSummary, refuseReason, replaceAll } from './replace.ts';

// The ordinary case, and the count is what the preview promises.
assert.deepEqual(replaceAll('a b a', 'a', 'X'), { text: 'X b X', count: 2 });

// Case-insensitive, matching the search that produced the results. The
// *replacement* keeps its own case — it is what the user typed, not a
// transformation of what was found.
assert.deepEqual(replaceAll('Foo foo FOO', 'foo', 'bar'), { text: 'bar bar bar', count: 3 });

// Overlapping candidates advance past the whole match, so `aa` in `aaa` is one
// replacement and a leftover, not an infinite loop.
assert.deepEqual(replaceAll('aaa', 'aa', 'b'), { text: 'ba', count: 1 });

// An empty query matches nothing. `''.indexOf` succeeds at every position, so
// the loop without this guard inserts the replacement between every character
// and returns a file nobody would recognise.
assert.deepEqual(replaceAll('hello', '', 'X'), { text: 'hello', count: 0 });

// No match returns the original string, not a rebuilt copy of it.
{
	const text = 'nothing here';
	assert.equal(replaceAll(text, 'zzz', 'X').text, text);
}

// A replacement containing the query does not re-match itself.
assert.deepEqual(replaceAll('log', 'log', 'log.debug'), { text: 'log.debug', count: 1 });

// A file with no matches is absent from the plan rather than listed with zero,
// because a listed file reads as a file about to be written.
assert.equal(planFile('a.ts', 'a.ts', 'nothing', 'zzz', 'X'), undefined);
assert.deepEqual(planFile('a.ts', 'a.ts', 'one two', 'two', 'three'), {
	id: 'a.ts',
	name: 'a.ts',
	original: 'one two',
	modified: 'one three',
	count: 1,
});

// The summary says the one thing that matters before an apply.
{
	const plan = planFile('a.ts', 'a.ts', 'x x', 'x', 'y')!;
	assert.match(planSummary([plan]), /^2 replacements in 1 file\. Nothing is written/);
	assert.equal(planSummary([]), 'Nothing to replace.');
	// Singular reads correctly; a "1 replacements" is the sort of thing that
	// makes a reader doubt the number itself.
	assert.match(planSummary([planFile('a.ts', 'a.ts', 'x', 'x', 'y')!]), /^1 replacement in 1 file\./);
}

/*
 * The refusals. Each is a file that would otherwise be written over silently,
 * and each names the file and what to do — a refusal the user cannot act on is
 * the same as no refusal.
 */
{
	const plan = planFile('src/a.ts', 'a.ts', 'one two', 'two', 'three')!;

	// Unchanged since the preview: this is the only case that writes.
	assert.equal(refuseReason(plan, 'one two', false), undefined);

	// Changed on disk. The preview is a picture of a file that no longer exists,
	// and applying `modified` would discard whatever changed it.
	assert.match(refuseReason(plan, 'one two three', false)!, /changed on disk/);

	// Gone, renamed, or now unreadable.
	assert.match(refuseReason(plan, undefined, false)!, /could not be read/);

	// Open and dirty. Refused rather than confirmed: the only two answers are
	// losing the edit or losing the replacement, and leaving it alone is the one
	// the user can undo.
	assert.match(refuseReason(plan, 'one two', true)!, /unsaved changes/);
	// Dirty wins over content, so a dirty editor whose disk copy also moved is
	// reported as the thing the user can act on.
	assert.match(refuseReason(plan, 'something else', true)!, /unsaved changes/);

	// Every refusal names the file. The report is a list, and an entry that does
	// not say which file is an entry nobody can use.
	for (const reason of [
		refuseReason(plan, 'one two three', false),
		refuseReason(plan, undefined, false),
		refuseReason(plan, 'one two', true),
	]) {
		assert.ok(reason!.includes('src/a.ts'));
	}
}

console.log('features/search/replace.check.ts: ok');
