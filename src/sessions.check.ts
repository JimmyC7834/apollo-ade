// Run with `npm run check`.
//
// Two things here are worth a check and the rest is data. `liveStatus` has an
// ordering that is easy to get backwards — a blocked run is still a run, so
// `running` would win if the branches were swapped, and the navigator would
// flash "running" at a user it is waiting on. `buildGroups` has one invariant
// the whole prototype marking rests on: exactly one session is `live`.

import assert from 'node:assert/strict';
import { LIVE_SESSION_ID, breadcrumb, buildGroups, liveStatus } from './sessions.ts';

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
assert.equal(groups[0].fixture, false);
assert.equal(groups[0].switchIndex, undefined);
assert.equal(groups[0].sessions[0].id, LIVE_SESSION_ID);
// Every session outside the current group belongs to no harness.
assert.ok(groups.slice(1).every((group) => group.sessions.every((s) => !s.live)));

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
	}),
	[]
);

assert.equal(breadcrumb(workspace, 'master'), 'ade/master');
// No branch is not "ade/undefined" and not "ade/HEAD".
assert.equal(breadcrumb(workspace, undefined), 'ade');
assert.equal(breadcrumb(undefined, 'master'), 'No folder open');

console.log('sessions.check.ts: ok');
