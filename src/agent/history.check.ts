// Run with `npm run check`.
//
// This is the only thing standing between a switched-to session and a blank
// window, and every rule in it is one that reads back wrong rather than
// crashing: a turn attached to the wrong prompt, a spinner on a run that ended
// last week, a reply with nothing said before it. None of those throw.
//
// The reduction itself is not retested here — `transcript.check.ts` owns
// `applyEvent`, and reusing it is the point of producing events at all.

import assert from 'node:assert/strict';
import { replayEntries } from './history.ts';
import { applyEvent, type Turn } from '../features/agent/transcript.ts';

const at = (seconds: number) => new Date(Date.UTC(2026, 7, 15, 0, 0, seconds)).toISOString();
let next = 0;
/** An entry, at the width this cares about. `as never` because pi's message
 *  union is far wider than anything a transcript reads. */
const entry = (type: string, body: Record<string, unknown>) =>
	({ type, id: `e${next++}`, parentId: null, timestamp: at(next), ...body }) as never;
const said = (text: string) => entry('message', { message: { role: 'user', content: text } });
const replied = (content: unknown[], errorMessage?: string) =>
	entry('message', { message: { role: 'assistant', content, errorMessage } });
const text = (value: string) => ({ type: 'text', text: value });
const call = (id: string, name: string, args: unknown) => ({
	type: 'toolCall',
	id,
	name,
	arguments: args,
});
const result = (id: string, output: string, isError = false) =>
	entry('message', {
		message: { role: 'toolResult', toolCallId: id, toolName: 't', content: output, isError },
	});

/** What `AgentChat` does with a restored turn, so the assertions are about what
 *  the user ends up reading rather than about the events on the way there. */
const rebuild = (entries: readonly unknown[]) =>
	replayEntries(entries as never).map((turn) =>
		turn.events.reduce<Turn>(applyEvent, {
			id: turn.id,
			prompt: turn.prompt,
			parts: [],
			status: 'running',
		})
	);

/*
 * The whole shape: a session opens with entries nobody said, then alternates
 * prompt and reply. Two prompts is two turns, and the reply belongs to the one
 * above it.
 */
const ordinary = rebuild([
	entry('model_change', { model: 'x' }),
	entry('thinking_level_change', { level: 'off' }),
	said('first'),
	replied([text('one')]),
	said('second'),
	replied([text('two')]),
]);
assert.deepEqual(
	ordinary.map((turn) => turn.prompt),
	['first', 'second']
);
assert.deepEqual(ordinary[0].parts, [{ kind: 'text', text: 'one' }]);
// Nothing is left running: every restored turn is a finished record.
assert.ok(ordinary.every((turn) => turn.status === 'complete'));
// The entries before the first prompt made no turn of their own.
assert.equal(ordinary.length, 2);

// A tool call and its result are one part, in the state the result gave it.
const tools = rebuild([
	said('read it'),
	replied([call('c1', 'read', { path: '/a' })]),
	result('c1', 'contents'),
]);
assert.deepEqual(tools[0].parts, [
	{ kind: 'tool', id: 'c1', name: 'read', input: { path: '/a' }, state: 'done', output: 'contents' },
]);

/*
 * **A call whose result was never written comes back failed, not running.**
 * `complete` settles a turn's status and leaves its parts alone, so without the
 * synthetic close this is a spinner on a run that ended when the window did —
 * which is the one restored state that would look like the app was still busy.
 */
const killed = rebuild([said('go'), replied([call('c9', 'bash', { command: 'sleep' })])]);
const stopped = killed[0].parts[0];
assert.equal(stopped.kind === 'tool' && stopped.state, 'failed');
assert.equal(killed[0].status, 'complete');

// A turn the model failed shows what it said *and* that it failed.
const failed = rebuild([said('go'), replied([text('trying')], 'the provider hung up')]);
assert.deepEqual(failed[0].parts, [
	{ kind: 'text', text: 'trying' },
	{ kind: 'error', message: 'the provider hung up', code: undefined },
]);

/*
 * A reply with nothing said before it is dropped rather than given an invented
 * prompt. Not reachable in a session pi wrote — which is exactly why it must not
 * be the thing that empties a window when it happens anyway.
 */
assert.deepEqual(rebuild([replied([text('orphan')])]), []);
assert.deepEqual(rebuild([]), []);

/*
 * **A compaction at the head of the branch, which is the shape that actually
 * arrives.** `getBranch` walks back to the root *or to a compaction*, so a
 * summarised session hands back the compaction entry first and everything that
 * followed after it. The first build pushed it onto the current turn — there
 * being none — and dropped it, so a compacted conversation reopened as a
 * transcript starting abruptly mid-thread with nothing saying so.
 */
const headed = rebuild([
	entry('compaction', { summary: 'what came before', tokensBefore: 12000 }),
	said('and then'),
	replied([text('quite')]),
]);
assert.equal(headed.length, 2);
assert.deepEqual(headed[0].parts, [
	{ kind: 'compacted', tokensBefore: 12000, summary: 'what came before' },
]);
assert.equal(headed[1].prompt, 'and then');

/*
 * Two prompts in the same millisecond still get different ids. The id is the
 * React key *and* the identity `applyEvent` matches a turn on, so a collision
 * merges two conversations' turns into one row — and a steered message landing
 * beside the next prompt is how it happens.
 */
const same = replayEntries([
	{ type: 'message', id: 'a', parentId: null, timestamp: at(1), message: { role: 'user', content: 'one' } },
	{ type: 'message', id: 'b', parentId: 'a', timestamp: at(1), message: { role: 'user', content: 'two' } },
] as never);
assert.equal(new Set(same.map((turn) => turn.id)).size, 2);

// Compaction is part of the record: it is where the detail above it went.
const compacted = rebuild([
	said('go'),
	replied([text('sure')]),
	entry('compaction', { summary: 'we talked', tokensBefore: 900 }),
]);
assert.deepEqual(compacted[0].parts.at(-1), {
	kind: 'compacted',
	tokensBefore: 900,
	summary: 'we talked',
});

/*
 * Ids are ordered and are all below `Date.now()`, because a live turn's id is
 * `Date.now()` and `applyEvent` finds a turn by id. A restored turn that
 * outranked a new one would take the new one's events.
 */
const ids = ordinary.map((turn) => turn.id);
assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
assert.ok(ids.every((id) => id < Date.now()));
assert.equal(new Set(ids).size, ids.length);

console.log('history.check.ts ok');
