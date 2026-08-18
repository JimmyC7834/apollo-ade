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
import {
	archiveMove,
	breadcrumb,
	buildGroups,
	liveStatus,
	manageable,
	type Session,
} from './sessions.ts';

/** A stored row as `listSessions` hands them over: newest first. */
const stored: readonly StoredSession[] = [
	{ id: '/s/3.jsonl', name: 'Fix the sash', startedAt: '2026-08-05T03:00:00Z' },
	{ id: '/s/2.jsonl', name: 'Chase a failing check', startedAt: '2026-08-04T03:00:00Z' },
	{ id: '/s/1.jsonl', name: 'Reword the note', startedAt: '2026-08-03T03:00:00Z' },
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
// The current root must not also appear as somewhere to go. It is *not* always
// at the top of Rust's list — only choosing a folder reorders that list, and
// ticket 58 stopped the navigator hoisting it. See `stable` below.
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

/*
 * Every stored row is `done`, and there is no second answer any more. It used
 * to be `done` or `idle` — had, versus opened and abandoned — and ticket 58
 * stopped listing the abandoned ones at all, so the distinction described rows
 * that no longer reach here.
 */
assert.equal(groups[0].sessions[1].status, 'done');
assert.equal(groups[0].sessions[2].status, 'done');
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
 * **A live session in another root is listed under that root** — ticket 49. It
 * is the reason a live row carries a root at all: before this, every open
 * conversation was in the folder the window was in, so "the top of the current
 * group" was the only place any of them could go.
 *
 * It also hides its own stored row *there*, and only there.
 */
const two = buildGroups({
	workspace,
	branch: 'master',
	recents,
	live: [
		open({ root: '/tmp/ade' }),
		open({ id: 'session-b', name: 'Over there', focused: false, root: '/tmp/other', storedPath: '/s/2.jsonl' }),
	],
	stored,
	elsewhere: new Map([['/tmp/other', stored]]),
});
assert.deepEqual(
	two[0].sessions.map((session) => session.id),
	['session-a', '/s/2.jsonl', '/s/1.jsonl'],
	'the session in another folder is not in this group'
);
assert.deepEqual(
	two[1].sessions.map((session) => session.id),
	['session-b', '1:/s/3.jsonl', '1:/s/1.jsonl'],
	'it leads its own group, and its own file is not offered a second time'
);
assert.ok(two[1].sessions[0].live, 'a live row stays live in another root');

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

/*
 * Ticket 56. Both of these are ways the two buttons go wrong quietly rather
 * than loudly, which is why they are checked and the rest of the row is not.
 */

/** A stored row, as `buildGroups` makes them. */
const row = (extra: Partial<Session> = {}): Session => ({
	id: 'r',
	name: 'A conversation',
	status: 'idle',
	live: false,
	storedPath: '/.ade/sessions/x.jsonl',
	...extra,
});

// The ordinary case: a stored row in the folder the window is showing.
assert.equal(manageable(row()), true);
// A live session is never archived or deleted from under itself — and because
// only a live session runs, this is also what keeps the buttons off a running
// turn. Both spellings of "in flight" are covered by the one test.
assert.equal(manageable(row({ live: true })), false);
assert.equal(manageable(row({ live: true, status: 'running' })), false);
// Another workspace: `rename_entry` and `delete_entry` resolve against the
// window's root, so acting here would act on the wrong folder's file. The
// buttons are withheld rather than the call being made and failing.
assert.equal(manageable(row({ switchIndex: 0 })), false);
// Nothing on disk to move. Browser mode, and a live row before its path lands.
assert.equal(manageable(row({ storedPath: undefined })), false);

/*
 * The leading slash is the whole point. `contained` in `workspace.rs` refuses
 * an absolute id outright, and the session store spells its paths with one —
 * so passing `storedPath` straight to `rename` fails every time.
 */
assert.deepEqual(archiveMove('/.ade/sessions/x.jsonl'), {
	folder: '.ade/archive',
	from: '.ade/sessions/x.jsonl',
	to: '.ade/archive/x.jsonl',
});
// Same answer without the slash, so neither spelling of a path can break it.
assert.deepEqual(archiveMove('.ade/sessions/x.jsonl').to, '.ade/archive/x.jsonl');
/*
 * The destination is outside the sessions root, which is what stops an archived
 * conversation being listed again — `JsonlSessionRepo.list` with no `cwd` walks
 * every directory under it.
 */
assert.ok(!archiveMove('/.ade/sessions/x.jsonl').to.startsWith('.ade/sessions/'));
// Real paths carry a per-cwd bucket. Only the file name survives, so nothing
// lands outside the archive folder.
assert.equal(archiveMove('/.ade/sessions/----/b.jsonl').to, '.ade/archive/b.jsonl');

/*
 * Ticket 58 — the list does not reshuffle under the pointer.
 *
 * The current workspace keeps Rust's position for it instead of being hoisted
 * to the top, because a list you navigate by position must not reorder itself
 * every time you arrive somewhere. `recents` above has the current root first,
 * so it cannot show the difference; this one has it second.
 */
const elsewhereFirst = [{ label: 'other', path: '/tmp/other' }, workspace];
const stable = buildGroups({
	workspace,
	branch: 'master',
	recents: elsewhereFirst,
	live: [open()],
	stored,
});
assert.deepEqual(
	stable.map((group) => group.label),
	['other', 'ade']
);
// Still the one with nowhere to go, wherever in the order it sits — and the
// other one's `switchIndex` is still its index into Rust's list.
assert.equal(stable[1].switchIndex, undefined);
assert.equal(stable[0].switchIndex, 0);

/*
 * A root the window is in that the recent list does not name — a restore whose
 * recents file was lost. It has no position to keep, so it goes first rather
 * than nowhere at all.
 */
const orphan = buildGroups({
	workspace: { label: 'unlisted', path: '/tmp/unlisted' },
	branch: 'master',
	recents: elsewhereFirst,
	live: [open()],
	stored,
});
assert.deepEqual(
	orphan.map((group) => group.label),
	['unlisted', 'other', 'ade']
);
assert.equal(orphan[0].switchIndex, undefined);

/*
 * Ticket 59 — a conversation being opened is one row, with its own name.
 *
 * A live session has no name of its own until its history has replayed, and
 * that is a file read. Both of these held the same defect from the other side:
 * for the length of that read the row read `New session`, which is the label
 * for a conversation nobody has said anything in — while the row it was opened
 * from sat above it saying what it actually was.
 */
const opening = buildGroups({
	workspace,
	branch: 'master',
	recents,
	// No name yet, and the file it is opening is one of the stored rows.
	live: [open({ name: '', storedPath: '/s/2.jsonl' })],
	stored,
})[0].sessions;
// It borrows the name of the row it hides rather than showing a placeholder.
assert.equal(opening[0].name, 'Chase a failing check');
// And it is still one row: the stored one it came from is not listed beside it.
assert.equal(opening.filter((row) => row.storedPath === '/s/2.jsonl').length, 1);

/*
 * A genuinely new conversation has no stored row to borrow from, and `New
 * session` is the right label there — which is the whole reason it exists.
 */
const born = buildGroups({
	workspace,
	branch: 'master',
	recents,
	live: [open({ name: '', storedPath: undefined })],
	stored,
})[0].sessions;
assert.equal(born[0].name, 'New session');

console.log('sessions.check.ts: ok');
