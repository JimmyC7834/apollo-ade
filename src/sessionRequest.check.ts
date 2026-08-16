// Run with `npm run check`.
//
// The storage half is three lines around `localStorage` and has nothing to get
// wrong. `sessionCandidates` has the whole switch in it: it decides, on every
// start-up, which conversation the window comes up in — so its ordering and its
// tail are what stand between a stale note in `localStorage` and a window that
// opens the wrong session, or silently starts a blank one.

import assert from 'node:assert/strict';
import { sessionCandidates } from './sessionRequest.ts';

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

console.log('sessionRequest.check.ts ok');
