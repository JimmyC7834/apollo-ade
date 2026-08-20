// Run with `npm run check`.
//
// The two rungs of ticket 76, and the four rules that make them safe: only
// public ids, never the way back, values and never rules, last enabled wins.

import assert from 'node:assert/strict';

// Through `publicNames.ts`, for the reason `chrome.ts` gives for doing the same.
import { COMMAND_IDS, TOOL_ARTIFACTS, showArtifactCommandId } from '../publicNames.ts';
import {
	applyLayout,
	declareLayout,
	declareTheme,
	mergeTokens,
	PROTECTED_IDS,
	PUBLIC_IDS,
	type LayoutClaim,
} from './chrome.ts';

const hello = { id: 'global:hello', manifest: { name: 'Hello' } };
const other = { id: 'global:other', manifest: { name: 'Other' } };

// Every token this ADE has, as the browser would answer it.
const DEFINED = new Set(['--background', '--foreground', '--row-height']);
const isDefined = (name: string) => DEFINED.has(name);

// --- a theme is values -------------------------------------------------------

const claim = declareTheme(hello, { '--background': ' #101010 ' }, isDefined);
assert.deepEqual(claim.tokens, { '--background': '#101010' });

// A token we do not define is refused, so a plugin written against a token that
// has since gone is told rather than silently having no effect.
assert.throws(() => declareTheme(hello, { '--nope': '#fff' }, isDefined), /not a token this ADE/);
assert.throws(() => declareTheme(hello, { background: '#fff' }, isDefined), /starts with --/);
assert.throws(() => declareTheme(hello, { '--background': '' }, isDefined), /needs a value/);
assert.throws(() => declareTheme(hello, 'dark', isDefined), /takes an object/);

/*
 * **A stylesheet is refused.** This is the rule that keeps component replacement
 * out: one rule reaching our document is one `display: none` away from deleting
 * the Guide's keyboard model with no claim ever having been made.
 */
for (const rule of [
	'#101010; } .ide-strip { display: none',
	'red } body {}',
	'<style>x</style>',
]) {
	assert.throws(
		() => declareTheme(hello, { '--background': rule }, isDefined),
		/a rule rather than a value/
	);
}

// **Last enabled wins, and the conflict is visible.** No precedence weights.
const merged = mergeTokens([
	declareTheme(hello, { '--background': '#111', '--foreground': '#eee' }, isDefined),
	declareTheme(other, { '--background': '#222' }, isDefined),
]);
assert.deepEqual(merged.tokens, { '--background': '#222', '--foreground': '#eee' });
assert.equal(merged.conflicts.length, 1);
assert.match(merged.conflicts[0], /Other and Hello both set --background; Other wins/);
// One plugin setting its own token twice across a reload is not a conflict.
assert.deepEqual(mergeTokens([claim, claim]).conflicts, []);

// --- a layout claim names a public id ----------------------------------------

const layout = declareLayout(hello, {
	hide: [TOOL_ARTIFACTS.replace.id],
	rename: { [TOOL_ARTIFACTS.terminal.id]: 'Shell' },
	order: [COMMAND_IDS.save],
});
assert.deepEqual(layout.hide, [TOOL_ARTIFACTS.replace.id]);

// An id that does not exist, and one that exists but is not public.
assert.throws(() => declareLayout(hello, { hide: ['artifact:terminal2'] }), /not an id a plugin may/);
assert.throws(() => declareLayout(hello, { hide: ['browser:1'] }), /not an id a plugin may/);
assert.throws(() => declareLayout(hello, { rename: { 'view.nope': 'X' } }), /not an id a plugin may/);
assert.throws(() => declareLayout(hello, { hide: 'everything' }), /is a list of ids/);

/*
 * **The way back.** A plugin that hides everything it is allowed to must not be
 * able to hide the list it is turned off from.
 */
assert.deepEqual(PROTECTED_IDS, [
	TOOL_ARTIFACTS.plugins.id,
	showArtifactCommandId(TOOL_ARTIFACTS.plugins.id),
]);
for (const id of PROTECTED_IDS) {
	assert.ok(PUBLIC_IDS.includes(id), 'it is a public id — it is just not a claimable one');
	assert.throws(() => declareLayout(hello, { hide: [id] }), /way back to the plugin list/);
	assert.throws(() => declareLayout(hello, { rename: { [id]: 'Gone' } }), /way back/);
	assert.throws(() => declareLayout(hello, { order: [id] }), /way back/);
}

// --- applying it -------------------------------------------------------------

const items = [
	{ id: 'a', title: 'Alpha' },
	{ id: 'b', title: 'Beta' },
	{ id: 'c', title: 'Gamma' },
];
const claims = (spec: Partial<LayoutClaim>): LayoutClaim[] => [
	{ pluginId: 'p', pluginName: 'P', hide: [], rename: {}, order: [], ...spec },
];

assert.deepEqual(applyLayout(items, []), items);
assert.deepEqual(
	applyLayout(items, claims({ hide: ['b'] })).map((item) => item.id),
	['a', 'c']
);
assert.equal(applyLayout(items, claims({ rename: { a: 'First' } }))[0].title, 'First');

// Order pulls to the front; everything unnamed keeps its relative place behind.
assert.deepEqual(
	applyLayout(items, claims({ order: ['c'] })).map((item) => item.id),
	['c', 'a', 'b']
);
assert.deepEqual(
	applyLayout(items, claims({ order: ['c', 'b'] })).map((item) => item.id),
	['c', 'b', 'a']
);
// An id in `order` that is not in this list is not an error here — a command id
// naturally does not appear among the dock tabs.
assert.deepEqual(
	applyLayout(items, claims({ order: ['zzz'] })).map((item) => item.id),
	['a', 'b', 'c']
);

// Two plugins, both claiming. Hides union; the later rename and the earlier
// order both apply, which is the same last-enabled-wins rule stated per field.
const two: LayoutClaim[] = [
	{ pluginId: '1', pluginName: 'One', hide: ['a'], rename: { b: 'From one' }, order: ['c'] },
	{ pluginId: '2', pluginName: 'Two', hide: [], rename: { b: 'From two' }, order: [] },
];
const applied = applyLayout(items, two);
assert.deepEqual(
	applied.map((item) => item.id),
	['c', 'b']
);
assert.equal(applied.find((item) => item.id === 'b')?.title, 'From two');

console.log('plugins/chrome.check.ts: ok');
