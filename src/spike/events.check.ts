// SPIKE — delete with `rm -r src/spike`.
//
// The event mapping is the one piece of the spike with real branching, so it
// gets the one runnable check. Fixtures are hand-written pi events; a live run
// is what actually falsifies the contract, and this only guarantees the mapping
// does not silently drop what it claims to carry.

import assert from 'node:assert/strict';
import { mapEvent } from './events.ts';

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
	provider: 'spike',
	model: 'test',
	usage,
	stopReason: 'stop',
	timestamp: 0,
	...extra,
});

// Text and thinking stay distinguishable — the whole reason `thinking` is its
// own kind rather than folded into `text`.
assert.deepEqual(
	mapEvent({
		type: 'message_update',
		message: assistant(),
		assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi', partial: assistant() },
	} as never),
	[{ kind: 'text', text: 'hi' }]
);
assert.deepEqual(
	mapEvent({
		type: 'message_update',
		message: assistant(),
		assistantMessageEvent: {
			type: 'thinking_delta',
			contentIndex: 0,
			delta: 'hmm',
			partial: assistant(),
		},
	} as never),
	[{ kind: 'thinking', text: 'hmm' }]
);

// Deltas that are neither produce nothing rather than an empty text event,
// which would otherwise show up as a stream of no-op renders.
assert.deepEqual(
	mapEvent({
		type: 'message_update',
		message: assistant(),
		assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{', partial: assistant() },
	} as never),
	[]
);

// A tool call and its result correlate by id, which is what lets the UI update
// a card in place instead of appending a second one.
const started = mapEvent({
	type: 'tool_execution_start',
	toolCallId: 'call-1',
	toolName: 'read',
	args: { path: 'src/main.tsx' },
} as never);
const ended = mapEvent({
	type: 'tool_execution_end',
	toolCallId: 'call-1',
	toolName: 'read',
	result: { content: [] },
	isError: false,
} as never);
assert.equal(started[0]?.kind, 'tool_start');
assert.equal(ended[0]?.kind, 'tool_end');
assert.equal(
	started[0] && 'id' in started[0] ? started[0].id : undefined,
	ended[0] && 'id' in ended[0] ? ended[0].id : undefined
);

// A failed turn carries its failure on the message. This is the case that
// renders as silence if it is missed.
const failed = mapEvent({
	type: 'message_end',
	message: assistant({ stopReason: 'error', errorMessage: 'model exploded' }),
} as never);
assert.deepEqual(
	failed.map((event) => event.kind),
	['usage', 'error']
);

// A successful one emits usage and nothing else.
assert.deepEqual(
	mapEvent({ type: 'message_end', message: assistant() } as never).map((event) => event.kind),
	['usage']
);

// Terminal kinds. `abort` is how cancellation reaches the UI; without it a
// stopped run would sit in the transcript as permanently running.
assert.deepEqual(mapEvent({ type: 'agent_end', messages: [] } as never), [{ kind: 'complete' }]);
assert.deepEqual(
	mapEvent({ type: 'abort', clearedSteer: [], clearedFollowUp: [] } as never),
	[{ kind: 'cancelled' }]
);

// Lifecycle noise maps to nothing. Named explicitly so a future contributor
// sees that the silence is a decision.
for (const type of ['agent_start', 'turn_start', 'settled', 'tools_update']) {
	assert.deepEqual(mapEvent({ type } as never), [], `${type} should map to nothing`);
}

console.log('spike/events: ok');
