// Run with `npm run check`.
//
// The rule that matters most here is not about policy, it is about failure
// mode: a `tool_call` handler that *throws* is wrapped into an
// `AgentHarnessError` and aborts the whole turn, whereas one that returns
// `{ block: true }` produces an ordinary error tool result the model can adapt
// to. So a declined approval must return, never reject. That is asserted below
// rather than only written in a comment, because a comment cannot fail.

import assert from 'node:assert/strict';
import { createGate } from './gate.ts';
import type { AgentEvent } from './index.ts';

const call = (toolName: string, id = 'c1') => ({
	toolCallId: id,
	toolName,
	input: { path: 'src/main.ts' },
});

/** Collects what the gate emitted, standing in for the transcript. */
function recorder() {
	const events: AgentEvent[] = [];
	return { events, emit: (event: AgentEvent) => void events.push(event) };
}

// Auto never asks. This is the default, so "never asks" is the behaviour almost
// every session gets.
{
	const log = recorder();
	const gate = createGate('auto', log.emit);
	assert.equal(await gate.onToolCall(call('write')), undefined);
	assert.equal(await gate.onToolCall(call('edit')), undefined);
	assert.equal(log.events.length, 0, 'auto mode emits no approval');
}

// Careful asks only about tools that change something. Prompting on a read
// would train the user to dismiss prompts, which is how a gate stops working.
{
	const log = recorder();
	const gate = createGate('careful', log.emit);
	assert.equal(await gate.onToolCall(call('read')), undefined);
	assert.equal(log.events.length, 0, 'reading is not a question');
}

// Approving lets the call through, and the question reached the UI first.
{
	const log = recorder();
	const gate = createGate('careful', log.emit);
	const decision = gate.onToolCall(call('write'));
	assert.equal(log.events.length, 1);
	assert.deepEqual(log.events[0], {
		kind: 'approval',
		id: 'c1',
		name: 'write',
		input: { path: 'src/main.ts' },
	});
	gate.resolve(true);
	assert.equal(await decision, undefined, 'approved calls proceed');
}

// Declining *returns* a block. If this ever rejects instead, the turn dies
// rather than the tool being refused — the single easiest mistake to make here.
{
	const log = recorder();
	const gate = createGate('careful', log.emit);
	const decision = gate.onToolCall(call('write'));
	gate.resolve(false);
	const result = await decision;
	assert.deepEqual(result, { block: true, reason: 'The user declined this change.' });
}

// Cancelling a run must not strand the hook. Without `abandon` the promise is
// never settled and the turn hangs forever, which is the worst failure here —
// worse than wrongly allowing or wrongly blocking, because nothing recovers.
{
	const log = recorder();
	const gate = createGate('careful', log.emit);
	const decision = gate.onToolCall(call('write'));
	gate.abandon();
	assert.equal((await decision)?.block, true, 'abandoning declines rather than hanging');
}

// A second question while one is outstanding would strand the first promise.
// Refused loudly rather than silently queued.
{
	const log = recorder();
	const gate = createGate('careful', log.emit);
	const first = gate.onToolCall(call('write', 'c1'));
	const second = await gate.onToolCall(call('edit', 'c2'));
	assert.equal(second?.block, true);
	assert.match(second?.reason ?? '', /already pending/);
	gate.resolve(true);
	assert.equal(await first, undefined, 'the first question still answers');
}

// Answering when nothing was asked is harmless — the UI can fire this from a
// stale click after a run has ended.
{
	const gate = createGate('careful', recorder().emit);
	gate.resolve(true);
	gate.abandon();
}

console.log('agent/gate.check.ts: ok');
