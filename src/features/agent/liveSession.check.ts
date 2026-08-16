// Run with `npm run check`.
//
// What a session object has to get right that a component never had to: events
// arriving for a conversation nobody is looking at. Every assertion below is
// about that — the turn still lands, the flags still move, and the session says
// afterwards that something happened while you were away.

import assert from 'node:assert/strict';
import { createLiveSession, type LiveSession } from './liveSession.ts';
import type { AgentProvider } from '../../agent/index.ts';

/**
 * Enough of a provider to hold. Only `label` is ever called: a session tells
 * Rust its name on the first prompt, so a second agent's collision warning has
 * something to name — ticket 51.
 */
function make() {
	const named: string[] = [];
	const provider = { label: (name: string) => named.push(name) } as AgentProvider;
	const said: string[] = [];
	let changes = 0;
	const session = createLiveSession({
		key: 'k',
		provider,
		announce: (_session, message) => said.push(message),
		changed: () => {
			changes += 1;
		},
	});
	return { session, said, named, changes: () => changes };
}

// A new session is empty and idle, which is what the navigator draws it as.
{
	const { session } = make();
	assert.deepEqual(session.snapshot().turns, []);
	assert.equal(session.status(), 'idle');
	assert.equal(session.name(), undefined);
}

/*
 * **A turn in an unfocused session still lands, and is unread afterwards.** This
 * is the whole of ticket 48 in four lines: the sink belongs to the session, not
 * to a view that may never have been mounted.
 */
{
	const { session, said } = make();
	session.focused = false;
	const sink = session.begin('Fix the sash');
	assert.equal(session.status(), 'running');
	assert.equal(session.name(), 'Fix the sash', 'the first prompt is the name');

	sink({ kind: 'text', text: 'working' });
	sink({ kind: 'complete' });

	assert.equal(session.status(), 'done');
	assert.equal(session.snapshot().unread, true);
	assert.deepEqual(said, ['Agent finished']);
	assert.equal(session.snapshot().turns.length, 1);
	assert.equal(session.snapshot().turns[0].status, 'complete');
}

/*
 * **Rust is told the name on every turn, and it is always the same name** —
 * ticket 51, where the label is the only thing that makes a collision warning
 * name a conversation rather than a counter.
 *
 * On every turn rather than only the first because a *restored* session's turns
 * are replayed, not begun: a first-turn-only label was never sent for any
 * conversation that came back from a launch, and the other agent's warning read
 * "another session". The name itself never moves — it is the first prompt.
 */
{
	const { session, named } = make();
	session.begin('Fix the sash');
	session.begin('And again');
	assert.deepEqual(named, ['Fix the sash', 'Fix the sash']);
}

// A prompt long enough to be a paragraph is a name nobody can read, in a
// sentence somebody else's model pays for.
{
	const { session, named } = make();
	session.begin('x'.repeat(200));
	assert.equal(named[0].length, 58);
	assert.ok(named[0].endsWith('…'));
}

// Watching it is not being told about it afterwards.
{
	const { session } = make();
	session.focused = true;
	let refocused = 0;
	session.onIdle = () => {
		refocused += 1;
	};
	const sink = session.begin('hello');
	sink({ kind: 'complete' });
	assert.equal(session.snapshot().unread, false);
	assert.equal(refocused, 1, 'the composer is where the next action starts');
}

/*
 * A question in a background session marks it waiting *and* unread, and does not
 * answer itself. `waiting` outranks `running` because the useful answer is the
 * one that says whose turn it is.
 */
{
	const { session, said } = make();
	session.focused = false;
	const sink = session.begin('ask me');
	sink({ kind: 'question', id: 'q1', question: 'Which one?', options: ['a'], multiSelect: false });
	assert.equal(session.status(), 'waiting');
	assert.equal(session.snapshot().unread, true);
	assert.deepEqual(said, ['The agent asked: Which one?']);
}

/*
 * **Two turns in one millisecond must not share an id.** The id is both the
 * React key and the identity the reducer matches on, so a collision sends one
 * turn's events into another's transcript — and `Date.now()` alone collides
 * whenever a steer and the next prompt land in the same tick.
 */
{
	const { session } = make();
	session.begin('one')({ kind: 'complete' });
	session.begin('two')({ kind: 'complete' });
	session.begin('three')({ kind: 'complete' });
	const ids = session.snapshot().turns.map((turn) => turn.id);
	assert.equal(new Set(ids).size, 3, ids.join(' '));
	assert.deepEqual([...ids].sort((a, b) => a - b), ids, 'and they stay in order');
}

// Every change reaches both the subscriber and the collection, or the navigator
// never redraws a status it is the only thing showing.
{
	const { session, changes } = make();
	let notified = 0;
	const stop = session.subscribe(() => {
		notified += 1;
	});
	session.patch({ draft: 'half a sentence' });
	assert.equal(session.snapshot().draft, 'half a sentence');
	assert.equal(notified, 1);
	assert.equal(changes(), 1);
	stop();
	session.patch({ draft: '' });
	assert.equal(notified, 1, 'and unsubscribing stops it');
}

// The draft survives, because switching away from a half-typed message and
// losing it would make focus expensive — which is the opposite of the point.
{
	const { session } = make();
	session.patch({ draft: 'unsent', attachments: ['src/main.ts'] });
	const away: LiveSession = session;
	away.focused = false;
	assert.equal(away.snapshot().draft, 'unsent');
	assert.deepEqual(away.snapshot().attachments, ['src/main.ts']);
}

console.log('liveSession.check.ts: ok');
