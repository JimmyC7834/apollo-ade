// Run with `npm run check`.
//
// A shell's working directory is decided when it is spawned and never moves
// again — ticket 31 names this as one of the five things holding state that
// belongs to the old root. Editors were answered by keeping them per root
// rather than discarding them, and a shell is answered the same way: it stays
// alive in the folder it was opened in, and it is not on screen anywhere else.
//
// The two rules below are the whole of that. Both are easy to get wrong in the
// direction that shows a stale shell: a filter that forgets the root, and an
// active id that survives a switch it should not have.

import assert from 'node:assert/strict';
import { activeIn, terminalsIn, type TerminalSession } from './terminal.ts';

const shell = (id: string, root: string | undefined): TerminalSession => ({
	id,
	name: id,
	exited: false,
	root,
});

const sessions = [shell('a', '/tmp/ade'), shell('b', '/tmp/other'), shell('c', '/tmp/ade')];

// Only this root's shells, in the order they were opened.
assert.deepEqual(
	terminalsIn(sessions, '/tmp/ade').map((session) => session.id),
	['a', 'c']
);
assert.deepEqual(
	terminalsIn(sessions, '/tmp/other').map((session) => session.id),
	['b']
);
// A folder with no shells shows none — not the other folder's.
assert.deepEqual(terminalsIn(sessions, '/tmp/third'), []);

/*
 * Before a root is chosen there is still a terminal panel, and a shell opened
 * then belongs to no root. It must not then appear in the first folder opened:
 * its cwd is the app's directory, which is nobody's workspace.
 */
assert.deepEqual(
	terminalsIn([...sessions, shell('d', undefined)], undefined).map((session) => session.id),
	['d']
);

// The remembered tab is kept when coming back to a root...
assert.equal(activeIn(sessions, '/tmp/ade', 'c'), 'c');
// ...and ignored when it belongs to the folder just left. This is the one that
// matters: keeping it would leave the other root's shell on screen.
assert.equal(activeIn(sessions, '/tmp/other', 'c'), 'b');
// Nothing remembered falls to the most recent shell here, which is the one the
// user was most likely last in.
assert.equal(activeIn(sessions, '/tmp/ade', undefined), 'c');
// A closed id is not remembered into a root that no longer holds it.
assert.equal(activeIn(sessions, '/tmp/ade', 'gone'), 'c');
// No shells here, no tab — not a dead id from somewhere else.
assert.equal(activeIn(sessions, '/tmp/third', 'a'), undefined);
assert.equal(activeIn([], '/tmp/ade', undefined), undefined);

console.log('terminal.check.ts: ok');
