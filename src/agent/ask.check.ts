// Run with `npm run check`.
//
// What is asserted here is the failure mode, not the happy path: every way this
// can go wrong leaves a promise nobody will ever resolve, which is a turn that
// hangs with the composer disabled and no Stop that helps. So the interesting
// cases are cancel, a second question, and asking outside a run — the ones that
// are hard to reach by hand and impossible to notice until they happen.

import assert from 'node:assert/strict';
import { createAskTool, createAsker, ASK_TOOL, OTHER } from './ask.ts';
import type { AgentEvent } from './index.ts';

/** Drain what the asker emitted, so each block starts clean. */
function sink() {
	const events: AgentEvent[] = [];
	return { events, emit: (event: AgentEvent) => void events.push(event) };
}

const tool = (asker: ReturnType<typeof createAsker>) => createAskTool(asker);

// Asking emits the question, and the answer is what resolves the promise.
{
	const asker = createAsker();
	const { events, emit } = sink();
	asker.begin(emit);

	const answered = asker.ask('call-1', {
		question: 'Which database?',
		options: ['Postgres', 'SQLite'],
		multiSelect: false,
	});

	assert.equal(events.length, 1);
	const question = events[0];
	assert.equal(question?.kind, 'question');
	assert.deepEqual(question.options, ['Postgres', 'SQLite']);
	assert.equal(question.id, 'call-1');

	asker.answer(['SQLite']);
	assert.deepEqual(await answered, ['SQLite']);
}

// Abandon resolves rather than rejects, and resolves to nothing. A stopped run
// must not leave `execute` awaiting; it also must not report an answer.
{
	const asker = createAsker();
	asker.begin(sink().emit);
	const answered = asker.ask('call-1', { question: 'q', options: ['a'], multiSelect: false });
	asker.abandon();
	assert.equal(await answered, undefined);
}

// A second answer is ignored. The button is removed once clicked, but a double
// click lands two events before React re-renders, and the second must not fall
// through to whatever question comes next.
{
	const asker = createAsker();
	asker.begin(sink().emit);
	const first = asker.ask('call-1', { question: 'q', options: ['a'], multiSelect: false });
	asker.answer(['a']);
	asker.answer(['b']);
	assert.deepEqual(await first, ['a']);

	const second = asker.ask('call-2', { question: 'q', options: ['a'], multiSelect: false });
	asker.answer(['c']);
	assert.deepEqual(await second, ['c']);
}

// A new turn abandons whatever the last one left outstanding, rather than
// letting this turn's user answer it. Same reason `resolveApproval` is scoped to
// the running turn: an answer given now is an answer to the question in front of
// you, not to one from three turns ago.
{
	const asker = createAsker();
	asker.begin(sink().emit);
	const stale = asker.ask('call-1', { question: 'q', options: ['a'], multiSelect: false });

	const next = sink();
	asker.begin(next.emit);
	assert.equal(await stale, undefined);

	// And the asker is usable again, rather than stuck believing one is pending.
	const fresh = asker.ask('call-2', { question: 'q2', options: ['b'], multiSelect: false });
	assert.equal(next.events.length, 1);
	asker.answer(['b']);
	assert.deepEqual(await fresh, ['b']);
}

// Two at once is refused loudly. Tools run sequentially in pi's loop, so this is
// a guard against a bug — but the bug's symptom would be a stranded promise, and
// a thrown tool error is recoverable where a hung turn is not.
{
	const asker = createAsker();
	asker.begin(sink().emit);
	const first = asker.ask('call-1', { question: 'q', options: ['a'], multiSelect: false });
	await assert.rejects(
		asker.ask('call-2', { question: 'q', options: ['a'], multiSelect: false }),
		/already waiting/
	);
	asker.answer(['a']);
	await first;
}

// Asking outside a run throws rather than silently waiting for a sink that will
// never exist.
{
	const asker = createAsker();
	await assert.rejects(
		asker.ask('call-1', { question: 'q', options: ['a'], multiSelect: false }),
		/no run/
	);
}

// The tool validates rather than trusts. The schema is advisory — pi hands the
// model's arguments through — and a question with no options renders as a bare
// text box, which reads as a broken UI rather than as a question.
{
	const asker = createAsker();
	asker.begin(sink().emit);
	const ask = tool(asker);

	assert.equal(ask.name, ASK_TOOL);
	await assert.rejects(ask.execute('c', { options: ['a'] }, undefined, undefined, {} as never), /question is required/);
	await assert.rejects(
		ask.execute('c', { question: '   ', options: ['a'] }, undefined, undefined, {} as never),
		/question is required/
	);
	await assert.rejects(
		ask.execute('c', { question: 'q', options: [] }, undefined, undefined, {} as never),
		/at least one choice/
	);
	await assert.rejects(
		ask.execute('c', { question: 'q' }, undefined, undefined, {} as never),
		/at least one choice/
	);
}

// The answer reaches the model as text, one line per choice — including the
// free-text one, which the UI labels so it is not mistaken for a chosen option.
{
	const asker = createAsker();
	const { events, emit } = sink();
	asker.begin(emit);
	const running = tool(asker).execute(
		'call-1',
		{ question: 'Which?', options: ['A', 'B'], multiSelect: true },
		undefined,
		undefined,
		{} as never
	);

	assert.equal(events[0]?.kind === 'question' && events[0].multiSelect, true);
	asker.answer(['A', `${OTHER}: neither, use C`]);

	const result = await running;
	assert.deepEqual(result.content, [{ type: 'text', text: `A\n${OTHER}: neither, use C` }]);
}

// An abandoned question fails the tool call. The model has to be told it never
// got an answer — an empty result would read as one.
{
	const asker = createAsker();
	asker.begin(sink().emit);
	const running = tool(asker).execute(
		'call-1',
		{ question: 'q', options: ['a'], multiSelect: false },
		undefined,
		undefined,
		{} as never
	);
	asker.abandon();
	await assert.rejects(running, /did not answer/);
}

// Aborting the turn abandons it too, by the same route the bash tool cancels.
{
	const asker = createAsker();
	asker.begin(sink().emit);
	const controller = new AbortController();
	const running = tool(asker).execute(
		'call-1',
		{ question: 'q', options: ['a'], multiSelect: false },
		controller.signal,
		undefined,
		{} as never
	);
	controller.abort();
	await assert.rejects(running, /did not answer/);
}

console.log('agent/ask.check.ts: ok');
