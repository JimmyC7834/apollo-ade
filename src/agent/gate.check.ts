// Run with `npm run check`.
//
// The rule that matters most here is not about policy, it is about failure
// mode: a `tool_call` handler that *throws* is wrapped into an
// `AgentHarnessError` and aborts the whole turn, whereas one that returns
// `{ block: true }` produces an ordinary error tool result the model can adapt
// to. So a declined approval must return, never reject. That is asserted below
// rather than only written in a comment, because a comment cannot fail.

import assert from 'node:assert/strict';
import { createGate, destructive, type GatePolicy } from './gate.ts';
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

/**
 * A gate pointed at one turn.
 *
 * The gate is built per *runner* now — a user tool's `execute` is a second
 * caller and tools are built once — so opening it is two calls rather than one.
 * Every case below is about a single turn, so they share this.
 */
function openGate(policy: GatePolicy, emit: (event: AgentEvent) => void) {
	const gate = createGate();
	gate.begin(policy, emit);
	return gate;
}

// Auto never asks. This is the default, so "never asks" is the behaviour almost
// every session gets.
{
	const log = recorder();
	const gate = openGate('auto', log.emit);
	assert.equal(await gate.onToolCall(call('write')), undefined);
	assert.equal(await gate.onToolCall(call('edit')), undefined);
	assert.equal(log.events.length, 0, 'auto mode emits no approval');
}

// Careful asks only about tools that change something. Prompting on a read
// would train the user to dismiss prompts, which is how a gate stops working.
{
	const log = recorder();
	const gate = openGate('careful', log.emit);
	assert.equal(await gate.onToolCall(call('read')), undefined);
	assert.equal(log.events.length, 0, 'reading is not a question');
}

// Approving lets the call through, and the question reached the UI first.
{
	const log = recorder();
	const gate = openGate('careful', log.emit);
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
	const gate = openGate('careful', log.emit);
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
	const gate = openGate('careful', log.emit);
	const decision = gate.onToolCall(call('write'));
	gate.abandon();
	assert.equal((await decision)?.block, true, 'abandoning declines rather than hanging');
}

// Two questions at once queue, and only the front one is shown. Ticket 24 makes
// this real: four subagents run in parallel against one user, so two tools can
// genuinely need an answer at the same moment. Refusing the second — which is
// what this did — turns a parallel delegation into a blocked call nobody asked
// for.
{
	const log = recorder();
	const gate = openGate('careful', log.emit);
	const first = gate.onToolCall(call('write', 'c1'));
	const second = gate.onToolCall(call('edit', 'c2'));

	assert.equal(log.events.length, 1, 'one card at a time, so `resolve` is unambiguous');
	assert.equal((log.events[0] as { id: string }).id, 'c1');

	gate.resolve(true);
	assert.equal(await first, undefined, 'the first answer went to the first question');
	assert.equal(log.events.length, 2, 'and the next one is shown on its own');
	assert.equal((log.events[1] as { id: string }).id, 'c2');

	gate.resolve(false);
	assert.equal((await second)?.block, true, 'the second answer went to the second question');
}

// Abandoning declines the whole queue. One left behind is a subagent that never
// finishes and a turn that never settles.
{
	const log = recorder();
	const gate = openGate('careful', log.emit);
	const first = gate.onToolCall(call('write', 'c1'));
	const second = gate.onToolCall(call('edit', 'c2'));
	gate.abandon();
	assert.equal((await first)?.block, true);
	assert.equal((await second)?.block, true);
}

// A subagent runs under **its own profile's** policy, and its question still
// reaches this turn's user. Without the override the profile field would be
// silently meaningless for children — ticket 24's gate decision.
{
	const log = recorder();
	const gate = openGate('careful', log.emit);
	assert.equal(await gate.onToolCall(call('write', 'c1'), 'auto'), undefined, 'the child is auto');
	assert.equal(log.events.length, 0);

	void gate.onToolCall(call('write', 'c2'), 'careful');
	assert.equal(log.events.length, 1, 'a careful child asks, on the parent turn’s sink');
	gate.abandon();
}

// The deny list fires in auto mode too, which is what makes it a floor rather
// than a policy. Nothing is spawned here — the gate is asked, and told no.
{
	const log = recorder();
	const gate = openGate('auto', log.emit);
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
	const gate = openGate('auto', log.emit);
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
	const gate = openGate('careful', log.emit);
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
	const gate = openGate('careful', recorder().emit);
	gate.resolve(true);
	gate.abandon();
}

// --- `confirm`, the door a tool comes in through ---------------------------

// The same card as the hook's, with the argv carried as the array it is. Joined
// for display, `["echo","a b"]` and `["echo","a","b"]` read identically — which
// is the whole reason the array exists.
{
	const log = recorder();
	const gate = openGate('auto', log.emit);
	const running = gate.confirm('c1', 'clean_build', ['rm', '-rf', 'dist'], 'deletes files recursively');
	assert.equal(log.events.length, 1);
	assert.deepEqual(log.events[0], {
		kind: 'approval',
		id: 'c1',
		name: 'clean_build',
		input: ['rm', '-rf', 'dist'],
		reason: 'deletes files recursively',
	});
	gate.resolve(true);
	assert.equal(await running, true, 'approving runs it');
}

// Declining answers false rather than throwing. The tool turns that into its own
// error; a rejection here would be a second failure mode for the same event.
{
	const log = recorder();
	const gate = openGate('auto', log.emit);
	const running = gate.confirm('c1', 'clean_build', ['rm', '-rf', 'dist'], 'deletes files recursively');
	gate.resolve(false);
	assert.equal(await running, false);
}

// Auto mode asks too. `confirm` is only ever reached because the deny list
// matched, and the deny list is the floor rather than the policy — so there is
// no policy branch here at all.
{
	const log = recorder();
	const gate = openGate('auto', log.emit);
	void gate.confirm('c1', 'clean_build', ['rm', '-rf', 'dist'], 'deletes files recursively');
	assert.equal(log.events.length, 1, 'the floor holds in auto');
	gate.abandon();
}

// Cancelling a run declines it, for the same reason the hook is abandoned: a
// tool awaiting an answer that can no longer arrive is a turn that never ends.
{
	const gate = openGate('auto', recorder().emit);
	const running = gate.confirm('c1', 'clean_build', ['rm', '-rf', 'x'], 'deletes files recursively');
	gate.abandon();
	assert.equal(await running, false);
}

// One queue, shared with the hook. A tool's question waits behind a hook's
// rather than being declined — the two callers differ in what they do with the
// answer, not in whether they are entitled to ask.
{
	const log = recorder();
	const gate = openGate('careful', log.emit);
	const first = gate.onToolCall(call('write'));
	const second = gate.confirm('c2', 'clean_build', ['rm', '-rf', 'x'], 'why');
	assert.equal(log.events.length, 1, 'the second question waits its turn');

	gate.resolve(true);
	assert.equal(await first, undefined, 'the first still answers');
	assert.equal(log.events.length, 2);
	gate.resolve(true);
	assert.equal(await second, true);
}

// A new turn declines what the last one left outstanding, rather than letting
// this turn's user answer a question they were never shown.
{
	const gate = createGate();
	gate.begin('auto', recorder().emit);
	const stale = gate.confirm('c1', 'clean_build', ['rm', '-rf', 'x'], 'why');

	const next = recorder();
	gate.begin('auto', next.emit);
	assert.equal(await stale, false);

	// And the gate is usable again rather than stuck believing one is pending.
	const fresh = gate.confirm('c2', 'clean_build', ['rm', '-rf', 'y'], 'why');
	assert.equal(next.events.length, 1);
	gate.resolve(true);
	assert.equal(await fresh, true);
}

// The policy is re-read per turn, which is what `begin` is for: switching to
// `careful` applies to the next turn rather than the next window.
{
	const log = recorder();
	const gate = createGate();
	gate.begin('auto', log.emit);
	assert.equal(await gate.onToolCall(call('write')), undefined, 'auto does not ask');

	gate.begin('careful', log.emit);
	void gate.onToolCall(call('write', 'c2'));
	assert.equal(log.events.length, 1, 'the switch reached the next turn');
	gate.abandon();
}

console.log('agent/gate.check.ts: ok');
