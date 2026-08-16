// Run with `npm run check`.
//
// The storage half is a few lines around `localStorage`. The one part of it with
// a decision in it is what `takeOpenSessions` does with a record it cannot trust:
// a half-parsed list would reopen a subset chosen by whichever field happened to
// survive, which is worse than opening one session the way a first launch does.
//
// `sessionCandidates` has the whole switch in it: it decides, on every start-up,
// which conversation the window comes up in — so its ordering and its tail are
// what stand between a stale record and a window that opens the wrong session,
// or silently starts a blank one.

import assert from 'node:assert/strict';
import { recordOpenSessions, sessionCandidates, takeOpenSessions } from './sessionRequest.ts';

const newest = { path: '/s/3.jsonl' };
const older = { path: '/s/2.jsonl' };
const child = { path: '/s/child.jsonl', metadata: { delegatedFrom: '/s/3.jsonl' } };
// Newest first, as `repo.list` sorts them, with a subagent's file newer than
// both — which is the case the fallback exists for.
const existing = [child, newest, older];

// No request: the newest conversation of the user's own, never the subagent's,
// and the rest behind it to fall back through.
assert.deepEqual(sessionCandidates(existing, undefined), [newest, older]);

// A request names a session, and it wins over recency.
assert.equal(sessionCandidates(existing, '/s/2.jsonl')[0], older);

/*
 * **The requested one is first, not only.** Opening walks the parent chain and
 * throws on a file with a hole in it — this repo has such files — so a request
 * for a damaged session has to leave somewhere to land. The first version of
 * this returned one candidate, and asking for a damaged conversation started a
 * blank session instead of keeping the healthy one. That is what the tail is.
 */
assert.deepEqual(sessionCandidates(existing, '/s/2.jsonl'), [older, newest]);
// Named once, tried once: the request must not also appear in the tail.
assert.equal(
	sessionCandidates(existing, '/s/2.jsonl').filter((e) => e === older).length,
	1
);

/*
 * A request for a file this root does not have contributes nothing. This is the
 * switch-that-did-not-happen case: the note was written for another workspace,
 * the switch was refused, and the note is read here anyway. Opening the session
 * you already had is the only harmless answer.
 */
assert.deepEqual(sessionCandidates(existing, '/s/from-another-root.jsonl'), [newest, older]);

// A subagent's session is not a conversation to fall back to — but it is one
// that can be asked for by name, which is the day forking gets a UI.
assert.deepEqual(sessionCandidates([child], undefined), []);
assert.deepEqual(sessionCandidates([child], '/s/child.jsonl'), [child]);

// A workspace with nothing in it yet has nothing to try, and says so rather
// than inventing a path — the caller creates a session instead.
assert.deepEqual(sessionCandidates([], '/s/2.jsonl'), []);

/*
 * The set of open conversations, across a launch — ticket 53. Node has no
 * `localStorage`, so the smallest possible one stands in: this is asserting what
 * the module does with what it reads back, not that a browser can store a string.
 */
{
	const store = new Map<string, string>();
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	};

	// Nothing recorded is a first launch, which opens one session as it always did.
	assert.deepEqual(takeOpenSessions(), []);

	const open = [
		{ root: 'C:/a', path: '/s/1.jsonl' },
		{ root: 'C:/b', path: '/s/2.jsonl', focused: true },
	];
	recordOpenSessions(open);
	assert.deepEqual(takeOpenSessions(), open);
	// **Not consumed**: this is state, not an instruction. Clearing it would mean a
	// launch that crashed on the way up came back to nothing.
	assert.deepEqual(takeOpenSessions(), open);

	// Anything malformed contributes nothing, and one bad entry does not cost the
	// others — the same rule the session store follows for a damaged file.
	store.set('ade.open-sessions', JSON.stringify([{ root: 'C:/a' }, 7, null, open[1]]));
	assert.deepEqual(takeOpenSessions(), [open[1]]);

	// A record that is not a list at all, and one that is not JSON at all.
	store.set('ade.open-sessions', JSON.stringify({ root: 'C:/a', path: '/s/1.jsonl' }));
	assert.deepEqual(takeOpenSessions(), []);
	store.set('ade.open-sessions', 'not json');
	assert.deepEqual(takeOpenSessions(), []);
}

console.log('sessionRequest.check.ts ok');
