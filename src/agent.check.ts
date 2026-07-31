// Run with `npm run check`. The run is a small state machine with two ways to
// stop and one way to pause, and every one of them has a failure mode that is
// invisible in the UI: a run that keeps streaming behind a pending approval, a
// cancel that still completes, or events arriving after a terminal event.

import assert from 'node:assert/strict';

import { createAgentProvider, type AgentEvent } from './agent.ts';

const provider = createAgentProvider();

/** Collect events until the run stops, then hand back the whole trace. */
function record(
	prompt: string,
	onApproval: (run: ReturnType<typeof provider.start>) => void
): Promise<AgentEvent[]> {
	return new Promise((resolve) => {
		const events: AgentEvent[] = [];
		const run = provider.start(prompt, (event) => {
			events.push(event);
			if (event.kind === 'approval') {
				onApproval(run);
			} else if (event.kind === 'complete' || event.kind === 'cancelled') {
				// Settle a turn late, so any stray event still lands in `events`.
				setTimeout(() => resolve(events), 5);
			}
		});
	});
}

const text = (events: AgentEvent[]): string =>
	events.map((event) => (event.kind === 'text' ? event.text : '')).join('');

// Approved: the run pauses, resumes on the answer, and applies the edit.
const approved = await record('add a greeting', (run) => run.resolveApproval(true));
assert.equal(approved.at(-1)?.kind, 'complete');
assert.ok(text(approved).startsWith('Working on: add a greeting'));
assert.ok(text(approved).includes('Applied.'));
assert.ok(approved.some((event) => event.kind === 'approval'));
// The apply activity exists only after approval, and only once.
assert.equal(
	approved.filter((event) => event.kind === 'activity' && event.label === 'Apply edit').length,
	1
);

// Skipped: same pause, opposite answer, and no edit is applied.
const skipped = await record('add a greeting', (run) => run.resolveApproval(false));
assert.equal(skipped.at(-1)?.kind, 'complete');
assert.ok(text(skipped).includes('Skipped.'));
assert.ok(!skipped.some((event) => event.kind === 'activity' && event.label === 'Apply edit'));

// Determinism: the same prompt and answer produce the same trace.
assert.deepEqual(await record('add a greeting', (run) => run.resolveApproval(true)), approved);

// Cancelling at the approval ends the run as cancelled, not complete, and a
// late answer cannot restart it.
const cancelled = await record('add a greeting', (run) => {
	run.cancel();
	run.resolveApproval(true);
});
assert.equal(cancelled.at(-1)?.kind, 'cancelled');
assert.equal(cancelled.filter((event) => event.kind === 'complete').length, 0);
assert.ok(!text(cancelled).includes('Applied.'));

// Cancelling mid-stream stops it: one terminal event, and nothing after it.
const midStream = await new Promise<AgentEvent[]>((resolve) => {
	const events: AgentEvent[] = [];
	const run = provider.start('add a greeting', (event) => {
		events.push(event);
		if (events.length === 2) {
			run.cancel();
			run.cancel(); // Idempotent: a second cancel must not emit again.
		}
		if (event.kind === 'cancelled') {
			setTimeout(() => resolve(events), 5);
		}
	});
});
assert.equal(midStream.at(-1)?.kind, 'cancelled');
assert.equal(
	midStream.filter((event) => event.kind === 'cancelled' || event.kind === 'complete').length,
	1
);

console.log('agent.check.ts: ok');
