// Run with `npm run check`. Every assertion here is a defect that shipped in
// Slice 11 and was found by reading, not by using the app: an approval that
// stayed clickable after Stop, and an answer that reached back into an older
// turn and changed it. Both are about which turn owns a question.

import assert from 'node:assert/strict';

import { ASK_TOOL } from '../../agent/ask.ts';

import {
	answerQuestion,
	applyEvent,
	approvalLabel,
	asPlainText,
	canAnswer,
	questionLabel,
	queuedLabel,
	resolveApproval,
	toolLabel,
	type QuestionPart,
	type Turn,
} from './transcript.ts';

const APPROVAL = {
	kind: 'approval',
	id: 'call-1',
	name: 'Apply edit',
	input: { path: 'src/main.ts' },
} as const;

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

// --- The twelve-kind contract ---------------------------------------------

const started = (): Turn => ({ id: 1, prompt: 'go', parts: [], status: 'running' });

// Reasoning does not splice itself into prose. Interleaving text and thinking
// must produce separate blocks, or the UI cannot collapse one without the other.
{
	let turn = started();
	for (const event of [
		{ kind: 'text', text: 'a' },
		{ kind: 'thinking', text: 'hmm' },
		{ kind: 'thinking', text: '...' },
		{ kind: 'text', text: 'b' },
	] as const) {
		turn = applyEvent(turn, event);
	}
	assert.deepEqual(
		turn.parts.map((part) => part.kind),
		['text', 'thinking', 'text']
	);
	assert.deepEqual(turn.parts[1], { kind: 'thinking', text: 'hmm...' });
}

// A tool call is one part that changes state, not a part per event. This is the
// whole reason `activity` was retired: it could not update in place.
{
	let turn = applyEvent(started(), {
		kind: 'tool_start',
		id: 'c1',
		name: 'read',
		input: { path: 'a.ts' },
	});
	turn = applyEvent(turn, { kind: 'tool_update', id: 'c1', partial: 'half' });
	assert.equal(turn.parts.length, 1, 'an update does not append');
	assert.equal(turn.parts[0].kind === 'tool' && turn.parts[0].output, 'half');

	turn = applyEvent(turn, { kind: 'tool_end', id: 'c1', result: 'all', isError: false });
	assert.equal(turn.parts.length, 1, 'an end does not append either');
	const part = turn.parts[0];
	assert.ok(part.kind === 'tool');
	assert.equal(part.state, 'done');
	assert.equal(part.output, 'all');
}

// A failed tool keeps its message. Losing it is exactly the defect that shipped
// in the spike, where the reason rendered as "[object Object]".
{
	let turn = applyEvent(started(), {
		kind: 'tool_start',
		id: 'c1',
		name: 'read',
		input: {},
	});
	turn = applyEvent(turn, { kind: 'tool_end', id: 'c1', result: 'not found', isError: true });
	const part = turn.parts[0];
	assert.ok(part.kind === 'tool');
	assert.equal(part.state, 'failed');
	assert.equal(part.output, 'not found');
	assert.match(asPlainText([turn]), /not found/);
}

// An unmatched id leaves the parts alone rather than inventing one.
{
	const turn = applyEvent(started(), { kind: 'tool_end', id: 'ghost', result: 'x', isError: false });
	assert.equal(turn.parts.length, 0);
}

// A tool still running when the run ends did not finish. Reporting it as
// "Running" forever would claim work is happening that stopped.
{
	let turn = applyEvent(started(), { kind: 'tool_start', id: 'c1', name: 'read', input: {} });
	const part = turn.parts[0];
	assert.ok(part.kind === 'tool');
	assert.equal(toolLabel(part, 'running'), 'Running');
	turn = applyEvent(turn, { kind: 'cancelled' });
	assert.equal(toolLabel(part, turn.status), 'Did not finish');
}

// Usage replaces rather than accumulates: the provider reports turn totals, so
// summing them double-counts on a multi-message turn.
{
	let turn = applyEvent(started(), {
		kind: 'usage',
		inputTokens: 10,
		outputTokens: 5,
		contextTokens: 15,
	});
	turn = applyEvent(turn, {
		kind: 'usage',
		inputTokens: 30,
		outputTokens: 9,
		contextTokens: 39,
		contextWindow: 128_000,
	});
	assert.deepEqual(turn.usage, {
		inputTokens: 30,
		outputTokens: 9,
		contextTokens: 39,
		contextWindow: 128_000,
	});

	// An unknown window replaces a known one rather than lingering. The window is
	// carried on the usage event, so a stale one would keep a percentage on
	// screen that nothing is computing any more.
	turn = applyEvent(turn, { kind: 'usage', inputTokens: 31, outputTokens: 9, contextTokens: 40 });
	assert.equal(turn.usage?.contextWindow, undefined);
	assert.equal(turn.parts.length, 0, 'usage is turn state, not a transcript entry');
}

// Errors and compaction are visible in the plain-text record, which is what a
// screen-reader user reads back.
{
	let turn = applyEvent(started(), { kind: 'error', message: 'connection lost' });
	turn = applyEvent(turn, { kind: 'compacted', tokensBefore: 900, summary: 'earlier work' });
	const text = asPlainText([turn]);
	assert.match(text, /\[error\] connection lost/);
	assert.match(text, /compacted 900 tokens/);
}

// A question is answerable on the same terms an approval is, and answering one
// is scoped the same way. The bug this repeats for the new kind is the one the
// file opens with: an answer reaching back into an older turn.
{
	const asked = (id: number): Turn =>
		applyEvent(
			{ id, prompt: 'go', parts: [], status: 'running' },
			{
				kind: 'question',
				id: `call-${id}`,
				question: 'Which database?',
				options: ['Postgres', 'SQLite'],
				multiSelect: false,
			}
		);

	const open = asked(1);
	const part = open.parts[0];
	assert.equal(part?.kind, 'question');
	assert.ok(canAnswer(part, open));

	// Stopped: still recorded, no longer answerable, and not silently answered.
	const stopped = applyEvent(asked(2), { kind: 'cancelled' });
	assert.equal(canAnswer(stopped.parts[0]!, stopped), false);
	assert.equal(questionLabel(stopped.parts[0] as QuestionPart, stopped.status), 'Not answered');

	// Only the running turn takes the answer. `stopped` comes first in the list,
	// which is exactly the arrangement that let an old question acquire an answer.
	const [old, current] = answerQuestion([stopped, open], ['SQLite']);
	assert.equal(old, stopped, 'a stopped turn is returned by identity');
	assert.equal((current?.parts[0] as QuestionPart).state, 'answered');
	assert.deepEqual((current?.parts[0] as QuestionPart).answer, ['SQLite']);

	// The answer is in the plain-text record, because "answered" without it is a
	// worse account of the conversation than no line at all.
	assert.match(asPlainText([current!]), /\[question\] Which database\? \(Postgres \/ SQLite\) — sqlite/);

	// Answering twice does not re-answer: the second call finds nothing pending.
	assert.equal(answerQuestion([current!], ['Postgres'])[0], current);

	// The ask tool's own call renders as the question card and nothing else. The
	// duplicate row this prevents was found by using the app, so it is asserted
	// here rather than left to be re-found.
	let quiet = applyEvent(asked(3), {
		kind: 'tool_start',
		id: 'call-3',
		name: ASK_TOOL,
		input: { question: 'Which database?' },
	});
	quiet = applyEvent(quiet, { kind: 'tool_end', id: 'call-3', result: 'SQLite', isError: false });
	assert.equal(quiet.parts.length, 1, 'only the question card');
	assert.equal(quiet.parts[0]?.kind, 'question');

	// Every other tool still renders as one.
	const loud = applyEvent(asked(4), {
		kind: 'tool_start',
		id: 'call-4',
		name: 'bash',
		input: { command: 'ls' },
	});
	assert.equal(loud.parts.length, 2);
}

// The thirteenth kind: what you typed while the turn was running.
{
	const empty: Turn = { id: 9, prompt: 'go', parts: [], status: 'running' };
	assert.equal(queuedLabel(empty), undefined, 'nothing queued says nothing');

	// The state replaces, it does not accumulate — pi sends both queues whole on
	// every change, so folding them in would double every message.
	let live = applyEvent(empty, { kind: 'queued', steer: ['use utf-8'], followUp: [] });
	live = applyEvent(live, { kind: 'queued', steer: ['use utf-8'], followUp: ['then commit'] });
	assert.deepEqual(live.queued, { steer: ['use utf-8'], followUp: ['then commit'] });
	assert.equal(live.parts.length, 0, 'a queued message is not a part: it has not happened');
	assert.match(queuedLabel(live)!, /^Waiting to send: "use utf-8", "then commit"$/);

	// Draining empties it. Without this the transcript keeps offering messages the
	// agent has already read.
	assert.equal(queuedLabel(applyEvent(live, { kind: 'queued', steer: [], followUp: [] })), undefined);

	// What a cancel says about the text it threw away — the whole reason the state
	// is kept after the turn ends rather than cleared with it.
	const stopped = applyEvent(live, { kind: 'cancelled' });
	assert.match(queuedLabel(stopped)!, /^Not sent: "use utf-8", "then commit"$/);
	assert.match(asPlainText([stopped]), /\[queued\] Not sent: "use utf-8"/);
}

console.log('transcript.check.ts: thirteen kinds ok');
