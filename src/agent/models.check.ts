// Run with `npm run check`.
//
// The table is data, not logic, so most of what is asserted here is that it is
// *reachable and plausible* — a mistyped key fails nowhere, it just makes the
// answer unknown, and unknown is a supported state that silently changes
// behaviour. The one real rule is the shape of "unknown": every reader answers
// `undefined` rather than a default, because a boolean with no unknown is what
// let a guessed `reasoning` flag look like a known one.
//
// The env readers are not exercised: they read `import.meta.env`, which node's
// type stripping does not populate. Their fallthrough — the table lookup — is
// what is checked.

import assert from 'node:assert/strict';
import {
	contextWindowFor,
	costFor,
	isKnownModel,
	MODELS,
	reasoningFor,
	thinkingLevelMapFor,
	thinkingUnavailable,
	type ModelEntry,
} from './models.ts';

// The model this repo actually runs must resolve, both ways. `deepseek-chat` is
// the case the old `/reason|think/i` heuristic got right by accident and
// `deepseek-reasoner` is the one it got right by coincidence of naming; both are
// now facts rather than luck.
{
	assert.equal(contextWindowFor('deepseek-chat'), 128_000);
	assert.equal(reasoningFor('deepseek-chat'), false, 'the chat model does not reason');
	assert.equal(reasoningFor('deepseek-reasoner'), true);
}

// Unknown is `undefined` from every reader, never a plausible default. This is
// the whole point of the ticket: `Model.reasoning` is a boolean and has nowhere
// to put "nobody said", so the unknown lives here and the caller decides.
{
	for (const id of ['gpt-4o', 'llama-3', '']) {
		assert.equal(contextWindowFor(id), undefined, `${id} should have no window`);
		assert.equal(reasoningFor(id), undefined, `${id} should have no reasoning answer`);
		assert.equal(thinkingLevelMapFor(id), undefined);
		assert.equal(isKnownModel(id), false);
	}
	assert.equal(isKnownModel('deepseek-chat'), true);
}

// A model that reasons but whose levels pi does not map is *not* the same as one
// with an empty map. Absent means `getSupportedThinkingLevels` allows off
// through high; an empty object would mean the same thing by accident, so the
// distinction is only worth keeping if it is never accidentally filled in.
{
	assert.equal(thinkingLevelMapFor('deepseek-reasoner'), undefined, 'not invented');
	assert.equal(thinkingLevelMapFor('claude-haiku-4-5'), undefined);
	assert.deepEqual(thinkingLevelMapFor('claude-opus-5'), { xhigh: 'xhigh', max: 'max' });
}

// `off: null` is a model that cannot stop thinking, and it is the reason the map
// is carried at all — without it we would offer `medium` on a model that has no
// `medium` and send Google a string it never defined.
{
	const map = thinkingLevelMapFor('gemini-3-pro-preview');
	assert.ok(map);
	assert.equal(map.off, null, 'the model refuses to turn thinking off');
	assert.equal(map.medium, null);
	assert.equal(map.low, 'LOW', 'upper case, because that is what the API takes');
}

// Every entry is plausible. The failure this catches is a typo in a literal:
// `1_000_00` rather than `1_000_000` is a valid number and a compaction
// threshold that fires on the first turn.
{
	const entries = Object.entries(MODELS) as [string, ModelEntry][];
	assert.ok(entries.length > 0);
	for (const [id, entry] of entries) {
		assert.ok(
			Number.isInteger(entry.contextWindow) && entry.contextWindow >= 8_000,
			`${id}: implausible window ${entry.contextWindow}`
		);
		assert.equal(typeof entry.reasoning, 'boolean', `${id}: reasoning must be stated`);

		// A map on a model that does not reason would never be read —
		// `getSupportedThinkingLevels` returns `["off"]` before it looks — so it
		// could only mislead whoever reads the table next.
		if (!entry.reasoning) {
			assert.equal(entry.thinkingLevelMap, undefined, `${id}: a map here means nothing`);
		}
	}
}

// The warning is a rule, so it lives in a checkable file rather than in the JSX
// that renders it. The bug it is written against shipped in the first draft: it
// warned on unknown models only, and said nothing about a *known* model that
// does not reason — a profile the user wrote, asking for thinking it will never
// get, silently.
{
	assert.equal(thinkingUnavailable('deepseek-reasoner', 'high'), '', 'a reasoner is fine');
	assert.equal(thinkingUnavailable('deepseek-chat', 'off'), '', 'off asks for nothing');
	assert.equal(thinkingUnavailable('', 'high'), '', 'no model named yet');

	// The case the first draft missed.
	assert.match(thinkingUnavailable('deepseek-chat', 'high'), /does not reason/);
	// And the case it caught, worded differently on purpose: this one has a fix.
	assert.match(thinkingUnavailable('deepseek-v9-imaginary', 'high'), /unknown model/);
	assert.match(thinkingUnavailable('deepseek-v9-imaginary', 'high'), /VITE_AGENT_REASONING/);
	// Telling someone to set the variable they just set would be worse than
	// silence, so the unknown wording is conditional on there being no override.
	assert.doesNotMatch(thinkingUnavailable('deepseek-chat', 'high'), /VITE_AGENT_REASONING/);
}

/*
 * Cost — ticket 26. Rates are entries like every other field here, so what is
 * asserted is the same thing: that they are reachable, and that missing means
 * missing. `deepseek-chat` is the case with teeth — it is what this repo
 * actually runs, it is absent from pi's catalog, and a table that answered
 * `{0,0,0,0}` for it would report every real turn as free.
 */
{
	assert.deepEqual(costFor('claude-opus-5'), {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	});
	assert.equal(costFor('deepseek-chat'), undefined, 'no rate in the catalog to copy');
	assert.equal(costFor('deepseek-v9-imaginary'), undefined);

	// Gemini's zero cache-write rate is a real zero — Google bills cache storage
	// by time, not per written token — so it must not read as unknown.
	assert.equal(costFor('gemini-2.5-pro')?.cacheWrite, 0);
	assert.ok(costFor('gemini-2.5-pro') !== undefined);

	// Every rate is positive except that one, and output always costs more than
	// input. Both hold across every provider's real pricing, and both would
	// catch a transposed pair — the failure mode of a table copied by hand.
	for (const [id, entry] of Object.entries(MODELS)) {
		if (!entry.cost) {
			continue;
		}
		assert.ok(entry.cost.input > 0, `${id} input`);
		assert.ok(entry.cost.output > entry.cost.input, `${id} output above input`);
		assert.ok(entry.cost.cacheRead > 0 && entry.cost.cacheRead < entry.cost.input, `${id} cache`);
	}
}

console.log('agent/models.check.ts: ok');
