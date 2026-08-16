// Run with `npm run check`.
//
// Two things here are worth a check and the rest is data. `liveStatus` has an
// ordering that is easy to get backwards — a blocked run is still a run, so
// `running` would win if the branches were swapped, and the navigator would
// flash "running" at a user it is waiting on. `buildGroups` has one join that is
// easy to get wrong now that the rows are real and there are several of them:
// an open session and its own file on disk are the same conversation, and must
// be one row.

import assert from 'node:assert/strict';
import type { StoredSession } from './agent/provider.ts';
import { breadcrumb, buildGroups, liveStatus, type Session } from './sessions.ts';

/** A stored row as `listSessions` hands them over: newest first. */
const stored: readonly StoredSession[] = [
	{ id: '/s/3.jsonl', name: 'Fix the sash', startedAt: '2026-08-05T03:00:00Z', empty: false },
	{ id: '/s/2.jsonl', name: 'Chase a failing check', startedAt: '2026-08-04T03:00:00Z', empty: false },
	{ id: '/s/1.jsonl', name: 'Untitled session', startedAt: '2026-08-03T03:00:00Z', empty: true },
];

/** The window's open conversations, as the controller builds them. */
const open = (over: Partial<Session> = {}): Session => ({
	id: 'session-a',
	name: 'Fix the sash',
	status: 'running',
	live: true,
	focused: true,
	storedPath: '/s/3.jsonl',
	...over,
});

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
	live: [open()],
	stored,
});

const live = groups.flatMap((group) => group.sessions).filter((session) => session.live);
assert.equal(live.length, 1);
assert.equal(live[0].id, 'session-a');
assert.equal(live[0].status, 'running');

// The open sessions lead the current workspace, which is never switchable —
// there is nothing to switch to.
assert.equal(groups[0].switchIndex, undefined);
assert.equal(groups[0].sessions[0].id, 'session-a');
// Every session outside the current group belongs to no harness.
assert.ok(groups.slice(1).every((group) => group.sessions.every((s) => !s.live)));

/*
 * The stored rows follow the open ones, in the order they arrived, and **the
 * conversation already open is not among them**. It is the row above: drawn from
 * live state, where its status is `running`. Offering the stored row as well
 * would put the same file on screen twice — and opening it would put two
 * harnesses on one JSONL, both appending.
 */
assert.deepEqual(
	groups[0].sessions.map((session) => session.id),
	['session-a', '/s/2.jsonl', '/s/1.jsonl']
);

/*
 * **Several live sessions, which is the whole of tickets 45 to 48.** Each keeps
 * its own status, exactly one is focused, and each one open hides its own stored
 * row rather than the first one's.
 */
const many = buildGroups({
	workspace,
	branch: 'master',
	recents,
	live: [
		open(),
		open({ id: 'session-b', name: 'Chase a failing check', status: 'waiting', focused: false, storedPath: '/s/2.jsonl' }),
	],
	stored,
});
assert.deepEqual(
	many[0].sessions.map((session) => session.id),
	['session-a', 'session-b', '/s/1.jsonl']
);
assert.deepEqual(
	many[0].sessions.filter((session) => session.focused).map((session) => session.id),
	['session-a'],
	'exactly one row is the one on screen'
);
assert.deepEqual(
	many[0].sessions.filter((session) => session.live).map((session) => session.status),
	['running', 'waiting'],
	'a background session keeps its own status'
);

/*
 * A brand-new session has no file yet, so it hides nothing. The stored list must
 * come back whole rather than losing a row to an undefined path matching an
 * undefined id.
 */
assert.deepEqual(
	buildGroups({
		workspace,
		branch: undefined,
		recents,
		live: [open({ storedPath: undefined })],
		stored,
	})[0].sessions.map((session) => session.id),
	['session-a', '/s/3.jsonl', '/s/2.jsonl', '/s/1.jsonl']
);

// Had, versus opened and abandoned. That is the whole of what the marker says
// about a session nothing is attached to.
assert.equal(groups[0].sessions[1].status, 'done');
assert.equal(groups[0].sessions[2].status, 'idle');
assert.equal(groups[0].sessions[1].name, 'Chase a failing check');

// A workspace whose sessions could not be read, or has none, shows the open rows
// alone — not an empty group, and not a fixture standing in for one.
assert.deepEqual(
	buildGroups({
		workspace,
		branch: 'master',
		recents: [workspace],
		live: [open({ name: 'Only me', storedPath: undefined })],
		stored: [],
	})[0].sessions.map((session) => session.id),
	['session-a']
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
 * A recent root's own conversations. Each row carries the index of the root it
 * lives in, and the path to open once there.
 */
const across = buildGroups({
	workspace,
	branch: 'master',
	recents,
	live: [open({ status: 'idle' })],
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
 * **A session open here does not hide a same-named file over there.** The two
 * are different conversations in different folders, and dropping the second one
 * would make a workspace look emptier than it is.
 */
assert.ok(
	across[1].sessions.some((session) => session.storedPath === '/s/2.jsonl'),
	'the filter is against this root only'
);

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
	live: [open({ status: 'idle' }), open({ id: 'session-b', focused: false, storedPath: '/s/2.jsonl' })],
	stored,
	elsewhere: new Map([['/tmp/other', stored]]),
});
const ids = collide.flatMap((group) => group.sessions).map((session) => session.id);
assert.equal(new Set(ids).size, ids.length, ids.join(' '));

// A session in the current root has nowhere to switch to.
assert.equal(collide[0].sessions[2].switchIndex, undefined);

// A root with nothing listed for it is still offered, because switching to a
// workspace you have never had a conversation in is a normal thing to want.
assert.deepEqual(
	buildGroups({
		workspace,
		branch: undefined,
		recents,
		live: [open()],
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
	live: [open()],
	stored,
}).filter((group) => group.switchIndex !== undefined);
assert.deepEqual(
	twins.map((group) => group.switchIndex),
	[0, 2]
);

// No root, no groups — not one empty group with a fixture hanging off it.
assert.deepEqual(
	buildGroups({ workspace: undefined, branch: 'x', recents, live: [open()], stored }),
	[]
);

assert.equal(breadcrumb(workspace, 'master'), 'ade/master');
// No branch is not "ade/undefined" and not "ade/HEAD".
assert.equal(breadcrumb(workspace, undefined), 'ade');
assert.equal(breadcrumb(undefined, 'master'), 'No folder open');

console.log('sessions.check.ts: ok');
