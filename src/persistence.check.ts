// Run with `npm run check`. Persistence reads whatever is in localStorage,
// which is user-writable and survives across versions of this app — so the
// cases that matter are the malformed ones, not the happy path.

import assert from 'node:assert/strict';

let store: Record<string, string> = {};
// Minimal stand-in: the adapter only ever calls these two.
(globalThis as { localStorage?: unknown }).localStorage = {
	getItem: (key: string) => store[key] ?? null,
	setItem: (key: string, value: string) => {
		store[key] = value;
	},
};

const { createPersistenceAdapter } = await import('./persistence.ts');
const adapter = createPersistenceAdapter();

const state = {
	visible: { primarySidebar: true, secondarySidebar: false, panel: true },
	primaryWidth: 300,
	secondaryWidth: 260,
	panelHeight: 200,
	primaryView: 'search' as const,
	workspace: { label: 'repo', path: '/tmp/repo' },
	editors: [{ id: 'a.ts', name: 'a.ts', content: 'unsaved' }],
	activeEditorId: 'a.ts',
};

// Nothing stored yet.
assert.equal(adapter.load(), undefined);

// Round trip.
adapter.save(state);
assert.deepEqual(adapter.load(), state);

const key = Object.keys(store)[0];

// A newer (or older) schema is ignored, not partially read.
store[key] = JSON.stringify({ version: 99, state });
assert.equal(adapter.load(), undefined);

// A payload with no version at all is ignored.
store[key] = JSON.stringify({ state });
assert.equal(adapter.load(), undefined);

// Corrupt JSON does not throw out of load().
store[key] = '{not json';
assert.equal(adapter.load(), undefined);

// Neither does a non-object payload.
store[key] = '42';
assert.equal(adapter.load(), undefined);

// A failing localStorage must not take the workbench down with it.
store = {};
(globalThis as { localStorage?: unknown }).localStorage = {
	getItem: () => {
		throw new Error('unavailable');
	},
	setItem: () => {
		throw new Error('quota exceeded');
	},
};
const hostile = createPersistenceAdapter();
assert.equal(hostile.load(), undefined);
hostile.save(state); // must not throw

console.log('persistence.check.ts: ok');
