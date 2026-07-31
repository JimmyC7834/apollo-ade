/*
 * Runnable self-check for the scoring tie-breaks: `npm run check`.
 *
 * No test framework — Node strips the types and `assert` is enough. What
 * matters here is ranking order, not exact scores, so every assertion is about
 * which candidate wins.
 */

import assert from 'node:assert/strict';

import { fuzzyFilter, fuzzyScore } from './fuzzy.ts';

function best(query: string, candidates: string[]): string {
	return fuzzyFilter(query, candidates, (c) => c)[0]?.item;
}

// Non-subsequences do not match at all.
assert.equal(fuzzyScore('xyz', 'Toggle Panel'), undefined);
assert.equal(fuzzyScore('ggo', 'Toggle'), undefined, 'order must be respected');

// An empty query keeps the full list in its original order.
assert.equal(fuzzyScore('', 'anything'), 0);
assert.deepEqual(
	fuzzyFilter('', ['b', 'a'], (c) => c).map((s) => s.item),
	['b', 'a']
);

// The palette's headline case: initials beat an incidental substring match.
assert.equal(best('tog', ['Restore Toggles Later', 'Toggle Panel']), 'Toggle Panel');
assert.equal(best('tp', ['Toggle Primary Sidebar', 'Temporary Path']), 'Toggle Primary Sidebar');

// Initials spanning words beat a closer match that ignores word boundaries.
// This is the case an uncapped gap penalty gets wrong.
assert.equal(best('ts', ['Toggle Secondary Sidebar', 'Tabs']), 'Toggle Secondary Sidebar');

// Consecutive characters beat scattered ones.
assert.equal(best('file', ['Fix Little Errors', 'Open File']), 'Open File');

// Among otherwise equal matches, the shorter candidate wins.
assert.equal(best('ab', ['ab', 'a-b-c-d-e-f']), 'ab');

// Paths: matching the basename should beat matching across separators.
assert.equal(best('main', ['src/m/a/i/n.ts', 'src/main.ts']), 'src/main.ts');

// camelCase humps count as word starts. Same text, same length, same match
// positions — the only difference is the capital, so it isolates the rule.
assert.ok(fuzzyScore('cc', 'commandCenter')! > fuzzyScore('cc', 'commandcenter')!);

console.log('fuzzy: all checks passed');
