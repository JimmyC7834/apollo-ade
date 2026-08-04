// Run with `npm run check`. Fixtures, not a live model — this guarantees the
// mapping does not silently drop what it claims to carry. Falsifying the
// contract itself took three real providers, and what that found is recorded in
// docs/wayfinder/pi-harness/tickets/12-walking-skeleton.md.

import assert from 'node:assert/strict';
import { mapEvent, resultText } from './events.ts';

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (extra: object = {}) => ({
	role: 'assistant',
	content: [],
	api: 'openai-completions',
	provider: 'test',
	model: 'test',
	usage,
	stopReason: 'stop',
	timestamp: 0,
	...extra,
});

const update = (inner: object) =>
	mapEvent({ type: 'message_update', message: assistant(), assistantMessageEvent: inner } as never);

// Text and thinking stay distinguishable. Folding them together is a one-way
// door: the UI can only hide reasoning if it arrives marked as reasoning.
assert.deepEqual(update({ type: 'text_delta', delta: 'hi' }), [{ kind: 'text', text: 'hi' }]);
assert.deepEqual(update({ type: 'thinking_delta', delta: 'hmm' }), [
	{ kind: 'thinking', text: 'hmm' },
]);

// Deltas that are neither produce nothing, rather than an empty text event that
// would show up as a stream of no-op renders.
assert.deepEqual(update({ type: 'toolcall_delta', delta: '{' }), []);

// A tool call and its result correlate by id. Without that the UI cannot update
// a card in place and appends a second one instead.
{
	const started = mapEvent({
		type: 'tool_execution_start',
		toolCallId: 'call-1',
		toolName: 'read',
		args: { path: 'src/main.ts' },
	} as never);
	const ended = mapEvent({
		type: 'tool_execution_end',
		toolCallId: 'call-1',
		toolName: 'read',
		result: { content: [{ type: 'text', text: 'file body' }] },
		isError: false,
	} as never);
	assert.equal(started[0]?.kind, 'tool_start');
	assert.equal(ended[0]?.kind, 'tool_end');
	assert.equal(
		started[0] && 'id' in started[0] ? started[0].id : undefined,
		ended[0] && 'id' in ended[0] ? ended[0].id : undefined
	);
	// The contract carries a string, so the reason survives to the transcript.
	assert.equal(ended[0] && 'result' in ended[0] ? ended[0].result : undefined, 'file body');
}

// `resultText` is the guard against the defect that shipped once: an
// AgentToolResult stringified to "[object Object]", and the first real tool
// failure was unreadable.
assert.equal(resultText({ content: [{ type: 'text', text: ' not found ' }] }), 'not found');
assert.equal(resultText({ content: [] }), '{"content":[]}');
assert.equal(resultText('plain'), 'plain');
assert.equal(resultText(null), 'null');
assert.ok(!resultText({ some: 'object' }).includes('[object Object]'));

// A failed turn carries its failure on the message, not as a separate event.
// Missing this renders a model error as silence.
assert.deepEqual(
	mapEvent({
		type: 'message_end',
		message: assistant({ stopReason: 'error', errorMessage: 'model exploded' }),
	} as never).map((event) => event.kind),
	['usage', 'error']
);
assert.deepEqual(
	mapEvent({ type: 'message_end', message: assistant() } as never).map((event) => event.kind),
	['usage']
);

// An overflow is relabelled; every other failure keeps the provider's own words.
// Getting this backwards would send a user to compact a conversation that was
// never the problem — an expired key reading as "too long" is a worse lie than
// the raw string it replaced.
{
	const overflowed = mapEvent(
		{
			type: 'message_end',
			message: assistant({
				stopReason: 'error',
				errorMessage: 'prompt is too long: 203914 tokens > 131072 maximum',
			}),
		} as never,
		128_000
	);
	assert.match((overflowed[1] as { message: string }).message, /\/compact/);

	const other = mapEvent(
		{
			type: 'message_end',
			message: assistant({ stopReason: 'error', errorMessage: '401 invalid api key' }),
		} as never,
		128_000
	);
	assert.equal((other[1] as { message: string }).message, '401 invalid api key');
}

// The window rides along on usage so the meter can show a share. Absent when it
// was never configured, rather than defaulted to something plausible.
{
	const [known] = mapEvent({ type: 'message_end', message: assistant() } as never, 128_000);
	assert.equal((known as { contextWindow?: number }).contextWindow, 128_000);
	const [unknown] = mapEvent({ type: 'message_end', message: assistant() } as never);
	assert.equal((unknown as { contextWindow?: number }).contextWindow, undefined);
}

// A user message ending is not the assistant's usage.
assert.deepEqual(mapEvent({ type: 'message_end', message: { role: 'user' } } as never), []);

// Terminal kinds. Without `abort` a stopped run sits in the transcript as
// permanently running.
assert.deepEqual(mapEvent({ type: 'agent_end', messages: [] } as never), [{ kind: 'complete' }]);
assert.deepEqual(mapEvent({ type: 'abort', clearedSteer: [], clearedFollowUp: [] } as never), [
	{ kind: 'cancelled' },
]);

// Compaction is surfaced; without it the transcript silently loses detail and
// the user is left wondering why the agent forgot something.
assert.deepEqual(
	mapEvent({
		type: 'session_compact',
		compactionEntry: { tokensBefore: 900, summary: 'earlier work' },
	} as never),
	[{ kind: 'compacted', tokensBefore: 900, summary: 'earlier work' }]
);

// Lifecycle noise maps to nothing. Listed explicitly so the silence reads as a
// decision rather than an oversight.
for (const type of ['agent_start', 'turn_start', 'settled', 'tools_update', 'model_update']) {
	assert.deepEqual(mapEvent({ type } as never), [], `${type} should map to nothing`);
}

console.log('agent/events.check.ts: ok');
