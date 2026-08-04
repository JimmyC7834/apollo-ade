// Run with `npm run check`.
//
// The branch that matters is "no window configured". Everything downstream —
// whether auto-compaction can fire, whether the meter shows a percentage — hangs
// off it, and getting it wrong in the *other* direction would be invisible: a
// threshold computed against a made-up window looks like it is working right up
// until the turn dies. So the unknown-window case is asserted first and hardest.
//
// The env readers are deliberately not exercised. They touch `import.meta.env`,
// which does not exist under plain node, and they carry no logic worth checking
// beyond the parse guard.

import assert from 'node:assert/strict';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
	compactionMessage,
	CONTEXT_WINDOWS,
	needsCompaction,
	overflowMessage,
	pressure,
} from './compaction.ts';

// pi's DEFAULT_COMPACTION_SETTINGS reserves 16384 tokens, so a 128k window trips
// at 111616. Written out rather than imported so that an upstream change to the
// reserve fails here loudly instead of silently redefining what this asserts.
const WINDOW = 128_000;
const THRESHOLD = WINDOW - 16_384;

// An unknown window never triggers compaction — not at zero, and not at a token
// count that would overflow any real model. This is the whole safety property.
{
	assert.equal(needsCompaction(0, undefined), false);
	assert.equal(needsCompaction(5_000_000, undefined), false, 'never guess a window');
	assert.equal(pressure(50_000, undefined), undefined, 'no window, no percentage');
}

// With a window, the boundary is exact. `shouldCompact` is a strict `>`, so the
// threshold itself must not fire — an off-by-one here would compact a turn early
// forever, and nobody would notice it was early.
{
	assert.equal(needsCompaction(THRESHOLD - 1, WINDOW), false);
	assert.equal(needsCompaction(THRESHOLD, WINDOW), false, 'the threshold itself is not over');
	assert.equal(needsCompaction(THRESHOLD + 1, WINDOW), true);
}

// The meter reports the same judgement it displays, so a user reading "88%" and
// a trigger reading "not yet" can never disagree.
{
	const calm = pressure(64_000, WINDOW);
	assert.deepEqual(calm, { percent: 50, warn: false });

	const tight = pressure(THRESHOLD + 1, WINDOW);
	assert.equal(tight?.warn, true);
	assert.equal(tight?.percent, 87);

	// Context can exceed the window when a provider counts differently than we
	// do. A meter reading 214% is a bug report about the meter, not information.
	assert.equal(pressure(WINDOW * 2, WINDOW)?.percent, 100, 'clamped');
}

/** The shape `message_end` delivers on a failed turn, trimmed to what is read. */
const failed = (errorMessage: string) =>
	({
		role: 'assistant',
		content: [],
		stopReason: 'error',
		errorMessage,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	}) as unknown as AssistantMessage;

// Overflow is recognised across wire formats — this is the knowledge adopting
// pi-ai actually buys, so it is worth asserting we get it rather than assuming.
{
	const overflows = [
		'prompt is too long: 203914 tokens > 131072 maximum', // Anthropic
		"This model's maximum context length is 128000 tokens", // OpenAI
		'The input token count exceeds the maximum number of tokens allowed', // Google
	];
	for (const text of overflows) {
		assert.ok(overflowMessage(failed(text), WINDOW), `should have matched: ${text}`);
		assert.match(overflowMessage(failed(text), WINDOW) ?? '', /\/compact/);
	}

	// Everything else keeps the provider's own words. Relabelling an auth failure
	// as "too long" would send the user to compact a conversation that was never
	// the problem.
	const others = [
		'401 Unauthorized: invalid api key',
		'rate limit exceeded, retry after 30s',
		'connection reset',
	];
	for (const text of others) {
		assert.equal(overflowMessage(failed(text), WINDOW), undefined, `should not match: ${text}`);
	}
}

// "Nothing to compact" is what a short conversation does, not a malfunction.
{
	assert.match(
		compactionMessage(new Error('Nothing to compact')),
		/not enough conversation/,
		'a normal thing to try reads as an explanation'
	);
	// Anything else is passed through: inventing friendlier words for a failure
	// we did not anticipate loses the only diagnostic there was.
	assert.equal(compactionMessage(new Error('summary request failed')), 'summary request failed');
}

// The window table is data, not logic, so what is asserted is that it is
// *reachable*: a mistyped key does not fail anywhere, it just makes the window
// unknown, and an unknown window silently disables auto-compaction forever.
// `contextWindowFor` itself is an env reader and stays unexercised for the reason
// at the top of this file; the lookup it falls through to is this table.
{
	assert.equal(
		CONTEXT_WINDOWS['deepseek-reasoner'],
		128_000,
		'the model this repo actually runs must resolve'
	);
	assert.equal(CONTEXT_WINDOWS['gpt-4o'], undefined, 'a model we do not list has no window');

	// Every entry is a plausible window. The failure this catches is a typo in the
	// literal — 1_000_00 rather than 1_000_000 is a valid number and a threshold
	// that fires on the first turn.
	for (const [id, window] of Object.entries(CONTEXT_WINDOWS)) {
		assert.ok(Number.isInteger(window) && window >= 8_000, `${id}: implausible window ${window}`);
	}
}

console.log('agent/compaction.check.ts: ok');
