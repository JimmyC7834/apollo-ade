// Run with `npm run check`. The three failures this guards against were all
// measured in the native window, and none of them are reachable from a unit
// test — so what is checked here is the retry policy itself: how long it waits,
// what it re-tries, and above all when it gives up.

import assert from 'node:assert/strict';

// Minimal stand-in: focusEditor only ever reads `activeElement` and `body`.
const body = { tag: 'body' };
const active: { current: unknown } = { current: body };
(globalThis as { document?: unknown }).document = {
	get activeElement() {
		return active.current;
	},
	body,
};

const { focusEditor } = await import('./focusEditor.ts');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An editor that only comes into existence after `appearsAfterMs`. */
function fakeEditor(appearsAfterMs: number) {
	const bornAt = Date.now() + appearsAfterMs;
	const node = { tag: 'editor', contains: (n: unknown) => n === input, querySelector: () => null };
	const input = { tag: 'input', focus: () => {} };
	let focused = false;
	let focusCalls = 0;
	const editor = {
		focus() {
			focusCalls += 1;
			focused = true;
			active.current = input;
		},
		hasTextFocus: () => focused,
		getDomNode: () => node,
		/** Simulate Monaco replacing its input, which drops focus to `body`. */
		rebuild() {
			focused = false;
			active.current = body;
		},
		get focusCalls() {
			return focusCalls;
		},
	};
	return { get: () => (Date.now() >= bornAt ? editor : null), editor, input };
}

// An editor that does not exist yet is waited for, not given up on. This is the
// case that matters most: focus is requested when React attaches the ref, and
// Monaco is not built until a passive effect later.
{
	const { get, editor } = fakeEditor(150);
	active.current = body;
	const cancel = focusEditor(get);
	await wait(60);
	assert.equal(editor.focusCalls, 0, 'nothing to focus yet');
	await wait(200);
	assert.equal(editor.hasTextFocus(), true, 'focused once the editor appeared');
	cancel();
}

// Focus destroyed by Monaco rebuilding its input is taken back.
{
	const { get, editor } = fakeEditor(0);
	active.current = body;
	const cancel = focusEditor(get);
	await wait(50);
	assert.equal(editor.hasTextFocus(), true);
	editor.rebuild();
	await wait(100);
	assert.equal(editor.hasTextFocus(), true, 're-focused after the rebuild');
	cancel();
}

// But never taken back from the user. Somebody else holding focus ends it.
{
	const { get, editor } = fakeEditor(0);
	active.current = body;
	const cancel = focusEditor(get);
	await wait(50);
	const elsewhere = { tag: 'close-button' };
	editor.rebuild();
	active.current = elsewhere;
	await wait(150);
	assert.equal(active.current, elsewhere, 'focus left where the user put it');
	cancel();
}

// Cancelling stops the watch, so a request never outlives its editor.
{
	const { get, editor } = fakeEditor(150);
	active.current = body;
	focusEditor(get)();
	await wait(250);
	assert.equal(editor.focusCalls, 0, 'cancelled before the editor existed');
}

// And the watch is bounded: it does not tick forever behind a dialog nobody
// reopened. WINDOW_MS is 800ms.
{
	const { get, editor } = fakeEditor(0);
	active.current = body;
	const cancel = focusEditor(get);
	await wait(900);
	const settledCalls = editor.focusCalls;
	editor.rebuild();
	await wait(150);
	assert.equal(editor.focusCalls, settledCalls, 'stopped retrying after the window');
	cancel();
}

console.log('focusEditor.check.ts: ok');
