// Run with `npm run check`.
//
// The rule that matters most here is not about policy, it is about failure
// mode: a `tool_call` handler that *throws* is wrapped into an
// `AgentHarnessError` and aborts the whole turn, whereas one that returns
// `{ block: true }` produces an ordinary error tool result the model can adapt
// to. So a declined approval must return, never reject. That is asserted below
// rather than only written in a comment, because a comment cannot fail.

import assert from 'node:assert/strict';
import { createGate, destructive } from './gate.ts';
import type { AgentEvent } from './index.ts';

/*
 * The deny list is checked here and *only* here — as a pure string predicate,
 * with nothing spawned. Verifying it by running the commands would be an
 * absurd way to test a guard against running commands, and one bad regex would
 * do the damage the guard exists to prevent.
 */
{
	const caught = [
		'rm -rf build',
		'rm -fr ./dist',
		'git reset --hard HEAD~3',
		'git clean -fd',
		'git push --force origin main',
		'git push -f',
		'git checkout -- src/main.ts',
		'sudo shutdown -h now',
		'dd if=/dev/zero of=/dev/sda',
		'format C: /q',
		':(){ :|:& };:',
	];
	for (const command of caught) {
		assert.ok(destructive(command), `should have flagged: ${command}`);
	}

	// Ordinary work must not trip it. A guard that fires on `npm test` is one
	// people learn to click through, which is worse than no guard.
	const allowed = [
		'npm test',
		'npm run build',
		'git status',
		'git push origin main',
		'git checkout main',
		'cargo test',
		'ls -la src',
		'grep -rn TODO src',
		'rm package-lock.json',
		'echo "format the disk"',
	];
	for (const command of allowed) {
		assert.equal(destructive(command), undefined, `should not have flagged: ${command}`);
	}
}

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
		// Absent rather than wrong: `write` is asked about because the policy
		// says so, not because the deny list matched something.
		reason: undefined,
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

// The deny list fires in auto mode too, which is what makes it a floor rather
// than a policy. Nothing is spawned here — the gate is asked, and told no.
{
	const log = recorder();
	const gate = createGate('auto', log.emit);
	const decision = gate.onToolCall({
		toolCallId: 'c9',
		toolName: 'bash',
		input: { command: 'git reset --hard HEAD~1' },
	});
	assert.equal(log.events.length, 1, 'auto still asks about the irreversible');
	assert.equal((log.events[0] as { reason?: string }).reason, 'discards uncommitted work');
	gate.resolve(false);
	assert.equal((await decision)?.block, true);
}

// An ordinary command in auto mode is not a question.
{
	const log = recorder();
	const gate = createGate('auto', log.emit);
	const decision = await gate.onToolCall({
		toolCallId: 'c10',
		toolName: 'bash',
		input: { command: 'npm test' },
	});
	assert.equal(decision, undefined);
	assert.equal(log.events.length, 0);
}

// Careful asks about every command, not only the listed ones: a shell can
// always change something.
{
	const log = recorder();
	const gate = createGate('careful', log.emit);
	void gate.onToolCall({
		toolCallId: 'c11',
		toolName: 'bash',
		input: { command: 'npm test' },
	});
	assert.equal(log.events.length, 1, 'careful asks before any command');
	gate.abandon();
}

// Answering when nothing was asked is harmless — the UI can fire this from a
// stale click after a run has ended.
{
	const gate = createGate('careful', recorder().emit);
	gate.resolve(true);
	gate.abandon();
}

console.log('agent/gate.check.ts: ok');
