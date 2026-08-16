// Run with `npm run check`.
//
// Two things here are worth a check and the rest is data. `liveStatus` has an
// ordering that is easy to get backwards — a blocked run is still a run, so
// `running` would win if the branches were swapped, and the navigator would
// flash "running" at a user it is waiting on. `buildGroups` has one invariant
// the rest of the app rests on — exactly one session is `live` — and one join
// that is easy to get wrong now that the rows are real: the live session and
// its own file on disk are the same conversation, and must be one row.

import assert from 'node:assert/strict';
import type { StoredSession } from './agent/provider.ts';
import { LIVE_SESSION_ID, breadcrumb, buildGroups, liveStatus } from './sessions.ts';

/** A stored row as `listSessions` hands them over: newest first. */
const stored: readonly StoredSession[] = [
	{ id: '/s/3.jsonl', name: 'Fix the sash', startedAt: '2026-08-05T03:00:00Z', active: true, empty: false },
	{ id: '/s/2.jsonl', name: 'Chase a failing check', startedAt: '2026-08-04T03:00:00Z', active: false, empty: false },
	{ id: '/s/1.jsonl', name: 'Untitled session', startedAt: '2026-08-03T03:00:00Z', active: false, empty: true },
];

// Blocked outranks running, which is the point of having both.
assert.equal(liveStatus({ running: true, blocked: true, turns: 3 }), 'waiting');
assert.equal(liveStatus({ running: true, blocked: false, turns: 3 }), 'running');
// A run can be blocked before it has produced anything, and it is still waiting.
assert.equal(liveStatus({ running: true, blocked: true, turns: 0 }), 'waiting');
// Idle and done differ only by whether anything has happened yet.
assert.equal(liveStatus({ running: false, blocked: false, turns: 0 }), 'idle');
assert.equal(liveStatus({ running: false, blocked: false, turns: 1 }), 'done');

const workspace = { label: 'ade', path: '/tmp/ade' };
// Rust's list always has the current root at the top, since switching to one
// pushes it there. The current root must not also appear as somewhere to go.
const recents = [workspace, { label: 'other', path: '/tmp/other' }];
const groups = buildGroups({
	workspace,
	branch: 'master',
	recents,
	liveName: 'Fix the sash',
	liveStatus: 'running',
	stored,
});

// Exactly one live session across every group. If this ever fails, the
// navigator is claiming a harness it does not have.
const live = groups.flatMap((group) => group.sessions).filter((session) => session.live);
assert.equal(live.length, 1);
assert.equal(live[0].id, LIVE_SESSION_ID);
assert.equal(live[0].name, 'Fix the sash');
assert.equal(live[0].status, 'running');

// The live session leads the current workspace, which is never switchable —
// there is nothing to switch to.
assert.equal(groups[0].switchIndex, undefined);
assert.equal(groups[0].sessions[0].id, LIVE_SESSION_ID);
// Every session outside the current group belongs to no harness.
assert.ok(groups.slice(1).every((group) => group.sessions.every((s) => !s.live)));

/*
 * The stored rows follow the live one, in the order they arrived, and **the
 * active one is not among them**. It is already the row above: drawn from live
 * state, where its status is `running`. Reading it back off disk as well would
 * put the same conversation on screen twice, the second time saying `done`.
 */
assert.deepEqual(
	groups[0].sessions.map((session) => session.id),
	[LIVE_SESSION_ID, '/s/2.jsonl', '/s/1.jsonl']
);
assert.equal(live.length, 1, 'and a stored row is never live');

// Had, versus opened and abandoned. That is the whole of what the marker says
// about a session nothing is attached to.
assert.equal(groups[0].sessions[1].status, 'done');
assert.equal(groups[0].sessions[2].status, 'idle');
assert.equal(groups[0].sessions[1].name, 'Chase a failing check');

// A workspace whose sessions could not be read, or has none, shows the live row
// alone — not an empty group, and not a fixture standing in for one.
assert.deepEqual(
	buildGroups({
		workspace,
		branch: 'master',
		recents: [workspace],
		liveName: 'Only me',
		liveStatus: 'idle',
		stored: [],
	})[0].sessions.map((session) => session.id),
	[LIVE_SESSION_ID]
);

/*
 * The recent that is not the current root is offered, and the current one is
 * not offered twice. `switchIndex` is the index into the list Rust holds — 1
 * here, not 0 — which is the bug this asserts against: filtering the list and
 * then indexing the filtered copy would send Rust the wrong root.
 */
const switchable = groups.filter((group) => group.switchIndex !== undefined);
assert.equal(switchable.length, 1);
assert.equal(switchable[0].label, 'other');
assert.equal(switchable[0].switchIndex, 1);
assert.deepEqual(switchable[0].sessions, []);

/*
 * A recent root's own conversations, which is what makes "switching a session
 * switches the workspace" a thing you can *do* rather than describe. Each row
 * carries the index of the root it lives in, and the path to open once there.
 */
const across = buildGroups({
	workspace,
	branch: 'master',
	recents,
	liveName: 'Fix the sash',
	liveStatus: 'idle',
	stored,
	elsewhere: new Map([['/tmp/other', stored.slice(1)]]),
});
const other = across[1];
assert.equal(other.switchIndex, 1);
assert.deepEqual(
	other.sessions.map((session) => session.switchIndex),
	[1, 1]
);
assert.deepEqual(
	other.sessions.map((session) => session.storedPath),
	['/s/2.jsonl', '/s/1.jsonl']
);
// Nothing over there is live, whatever it says on disk.
assert.ok(other.sessions.every((session) => !session.live));

/*
 * **Row ids are unique across workspaces, and session paths are not.** Two
 * checkouts of one project hold the same session filenames, so keying rows on
 * the path alone would collide — React would draw one row for two conversations
 * and the wrong one would be opened. The path itself survives in `storedPath`.
 */
const collide = buildGroups({
	workspace,
	branch: undefined,
	recents,
	liveName: undefined,
	liveStatus: 'idle',
	stored,
	elsewhere: new Map([['/tmp/other', stored]]),
});
const ids = collide.flatMap((group) => group.sessions).map((session) => session.id);
assert.equal(new Set(ids).size, ids.length, ids.join(' '));

// The live row opens nothing: it is already open, and `selectSession` reads
// that absence rather than a flag of its own.
assert.equal(collide[0].sessions[0].storedPath, undefined);
assert.equal(collide[0].sessions[1].storedPath, '/s/2.jsonl');
// A session in the current root has nowhere to switch to.
assert.equal(collide[0].sessions[1].switchIndex, undefined);

// A root with nothing listed for it is still offered, because switching to a
// workspace you have never had a conversation in is a normal thing to want.
assert.deepEqual(
	buildGroups({
		workspace,
		branch: undefined,
		recents,
		liveName: undefined,
		liveStatus: 'idle',
		stored,
		elsewhere: new Map(),
	})[1].sessions,
	[]
);

// Two checkouts of the same project share a label, so the current root is
// matched by path. Both of these are offered; neither is the current one.
const twins = buildGroups({
	workspace,
	branch: undefined,
	recents: [
		{ label: 'ade', path: '/tmp/ade-2' },
		workspace,
		{ label: 'ade', path: '/tmp/ade-3' },
	],
	liveName: undefined,
	liveStatus: 'idle',
	stored,
}).filter((group) => group.switchIndex !== undefined);
assert.deepEqual(
	twins.map((group) => group.switchIndex),
	[0, 2]
);

// An unnamed session still has a name; a nameless row is not renderable.
assert.equal(
	buildGroups({
		workspace,
		branch: undefined,
		recents: [],
		liveName: undefined,
		liveStatus: 'idle',
		stored: [],
	})[0].sessions[0].name,
	'New session'
);

// No root, no groups — not one empty group with a fixture hanging off it.
assert.deepEqual(
	buildGroups({
		workspace: undefined,
		branch: 'x',
		recents,
		liveName: 'y',
		liveStatus: 'idle',
		stored,
	}),
	[]
);

assert.equal(breadcrumb(workspace, 'master'), 'ade/master');
// No branch is not "ade/undefined" and not "ade/HEAD".
assert.equal(breadcrumb(workspace, undefined), 'ade');
assert.equal(breadcrumb(undefined, 'master'), 'No folder open');

console.log('sessions.check.ts: ok');
