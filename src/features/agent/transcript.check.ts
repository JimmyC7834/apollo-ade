// Run with `npm run check`. Every assertion here is a defect that shipped in
// Slice 11 and was found by reading, not by using the app: an approval that
// stayed clickable after Stop, and an answer that reached back into an older
// turn and changed it. Both are about which turn owns a question.

import assert from 'node:assert/strict';

import {
	applyEvent,
	approvalLabel,
	asPlainText,
	canAnswer,
	resolveApproval,
	type Turn,
} from './transcript.ts';

const APPROVAL = { kind: 'approval', label: 'Apply edit', detail: 'src/main.ts' } as const;

/** A turn mid-run, paused on an approval — the state Stop has to deal with. */
function awaiting(id: number): Turn {
	const started: Turn = { id, prompt: 'go', parts: [], status: 'running' };
	return applyEvent(applyEvent(started, { kind: 'text', text: 'Working. ' }), APPROVAL);
}

// A pending approval reads as unanswered once its run is over. Not "skipped":
// nobody skipped it. Not "pending": nothing is pending on a dead run.
{
	assert.equal(approvalLabel('pending', 'running'), 'Waiting for you');
	assert.equal(approvalLabel('pending', 'cancelled'), 'Not answered');
	assert.equal(approvalLabel('pending', 'complete'), 'Not answered');
	assert.equal(approvalLabel('approved', 'cancelled'), 'Approved', 'an answer survives the stop');
	assert.equal(approvalLabel('skipped', 'complete'), 'Skipped');
}

// Whether the buttons are drawn at all. This is asserted here rather than left
// to the JSX because that is precisely how the defect shipped: the rule was
// only ever expressed in a `.tsx`, where no check could reach it.
{
	const live = awaiting(1);
	const question = live.parts.at(-1);
	assert.ok(question);
	assert.equal(canAnswer(question, live), true, 'answerable while the run is alive');

	for (const ending of ['cancelled', 'complete'] as const) {
		const over = applyEvent(live, { kind: ending });
		const part = over.parts.at(-1);
		assert.ok(part);
		assert.equal(canAnswer(part, over), false, `not answerable once ${ending}`);
	}

	const answered = resolveApproval([live], true)[0];
	const done = answered.parts.at(-1);
	assert.ok(done);
	assert.equal(canAnswer(done, answered), false, 'not answerable twice');
}

// Cancelling does not answer the question on the way out.
{
	const stopped = applyEvent(awaiting(1), { kind: 'cancelled' });
	const part = stopped.parts.at(-1);
	assert.equal(part?.kind, 'approval');
	assert.equal(part.kind === 'approval' && part.state, 'pending', 'state is left honest');
	assert.equal(stopped.status, 'cancelled');
}

// The defect: answering a new approval also flipped a stale one left pending by
// an earlier cancelled turn, rewriting history the user had already seen.
{
	const stale = applyEvent(awaiting(1), { kind: 'cancelled' });
	const live = awaiting(2);

	const after = resolveApproval([stale, live], true);

	const stalePart = after[0].parts.at(-1);
	assert.equal(
		stalePart?.kind === 'approval' && stalePart.state,
		'pending',
		'the cancelled turn was not touched'
	);
	const livePart = after[1].parts.at(-1);
	assert.equal(livePart?.kind === 'approval' && livePart.state, 'approved', 'the live turn was');
}

// Skipping works the same way, and a completed turn is as untouchable as a
// cancelled one — a real provider can finish with a question still on screen.
{
	const finished = applyEvent(awaiting(1), { kind: 'complete' });
	const after = resolveApproval([finished, awaiting(2)], false);
	const finishedPart = after[0].parts.at(-1);
	assert.equal(finishedPart?.kind === 'approval' && finishedPart.state, 'pending');
	const livePart = after[1].parts.at(-1);
	assert.equal(livePart?.kind === 'approval' && livePart.state, 'skipped');
}

// Resolving with nothing to resolve returns the same array, so React does not
// re-render a transcript that did not change.
{
	const settled = [applyEvent(awaiting(1), { kind: 'cancelled' })];
	assert.equal(resolveApproval(settled, true), settled, 'unchanged turns keep their identity');
}

// The plain-text transcript is a record someone reads with a screen reader, so
// it has to tell the same story the buttons do.
{
	const stopped = applyEvent(awaiting(1), { kind: 'cancelled' });
	assert.match(asPlainText([stopped]), /\(not answered\)/);
	assert.match(asPlainText([awaiting(2)]), /\(waiting for you\)/);
}

// Text chunks still merge into one part rather than accumulating one per chunk.
{
	const turn: Turn = { id: 1, prompt: 'go', parts: [], status: 'running' };
	const streamed = applyEvent(applyEvent(turn, { kind: 'text', text: 'a' }), {
		kind: 'text',
		text: 'b',
	});
	assert.equal(streamed.parts.length, 1);
	assert.deepEqual(streamed.parts[0], { kind: 'text', text: 'ab' });
}

console.log('transcript.check.ts: ok');
