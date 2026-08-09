// What the app knows about a model.
//
// docs/wayfinder/pi-harness/tickets/19-model-entries.md. The entry side of
// "machinery in, entries ours" ([ticket 15](docs/wayfinder/pi-harness/tickets/15-core-already-does-this.md)):
// pi's `clampThinkingLevel`, `shouldCompact` and `calculateCost` are all taken,
// and what they read is this table.
//
// **Copied at author time, not remembered and not fetched.** Every field below
// except DeepSeek's comes from pi's own bundled catalog data
// (`@earendil-works/pi-ai/dist/providers/data/<provider>.json`), read out rather
// than recalled. It is deliberately not the catalog imported at runtime:
// [ticket 08](docs/wayfinder/pi-harness/tickets/08-bundle-cost.md) says import by
// subpath and never the barrel, and pi's catalog is a megabyte of JSON for every
// provider we do not offer.
//
// **Which file matters, and this is the trap.** The same model id appears in
// several catalogs with different numbers, because a proxy's limits are not the
// provider's. `gemini-2.5-pro` is 1,048,576 in `google.json` and **128,000** in
// `github-copilot.json`; a scan that took the first match copied the Copilot
// number. Read the file for the provider this app actually talks to — the three
// in `SHAPES` — and nothing else.

import type { ModelCostRates, ThinkingLevelMap } from '@earendil-works/pi-ai';

/**
 * The window handed to pi when none is configured.
 *
 * pi requires `Model.contextWindow` to be a number — it feeds
 * `clampMaxTokensToContext` — so a value has to exist whatever we know. This one
 * is a guess with no source, kept only because the type demands it, and
 * **`contextWindowFor` rather than this is what any compaction decision
 * consults.** A fabricated window that silently moved the compaction threshold
 * would be the failure this whole design is arranged to avoid.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

export interface ModelEntry {
	readonly contextWindow: number;
	/**
	 * Whether the model can think at all.
	 *
	 * Not cosmetic and not advisory: `getSupportedThinkingLevels` returns
	 * `["off"]` outright when this is false, so `clampThinkingLevel` collapses
	 * every requested level to `off` and the user sees a model that simply does
	 * not reason, with no error because nothing failed.
	 */
	readonly reasoning: boolean;
	/**
	 * Which levels this model actually accepts, where pi publishes one.
	 *
	 * `null` for a level means *not supported* — `gemini-3-pro-preview` maps
	 * `off: null`, which is the model saying it cannot stop thinking. Absent
	 * means pi ships no map for this model, and absent is **not** the same as an
	 * empty one: with no map, `getSupportedThinkingLevels` allows everything from
	 * `off` to `high` and passes the level through as the provider's own
	 * `reasoning_effort` string. Where pi has no map, neither do we — inventing
	 * one would be exactly the remembered-rather-than-copied entry this table
	 * exists to avoid.
	 */
	readonly thinkingLevelMap?: ThinkingLevelMap;
	/**
	 * Dollars per million tokens, or **absent when nobody has said**.
	 *
	 * Absent is a supported state and the reason `costFor` answers `undefined`
	 * rather than a zeroed table: pi's `calculateCost` multiplies whatever rates
	 * it is handed, so zeroed rates produce `$0.00` — a confident wrong number
	 * where nothing was known. `reasoningFor` and `contextWindowFor` already
	 * answer this way, for the same reason.
	 *
	 * `tiers` is deliberately not carried. None of the models below has one in
	 * pi's catalog, and an empty field that has never been exercised is a field
	 * that will be wrong the first time it is filled.
	 */
	readonly cost?: ModelCostRates;
}

/**
 * The models this repo knows how to run.
 *
 * A model absent from here is a supported state, not a gap to fill with a
 * plausible entry. Adding a wrong one is worse than adding none: a context
 * window too large and auto-compaction never fires, too small and it fires
 * forever; a wrong `reasoning` and thinking silently stops working.
 */
export const MODELS: Readonly<Record<string, ModelEntry>> = {
	/*
	 * The two this repo actually runs, and the only entries with no in-repo
	 * source: 0.83.0's `deepseek.json` ships `deepseek-v4-flash` and
	 * `deepseek-v4-pro` and neither of these. The windows are DeepSeek's
	 * published 128K for the current API models.
	 *
	 * No `thinkingLevelMap` for the reasoner, deliberately. pi maps the v4
	 * entries as `{minimal: null, low: null, medium: null, high: "high", max:
	 * "max"}`, and copying that across to a different model would be a guess
	 * wearing a citation.
	 *
	 * **And no `cost`, for exactly that reason** — these two are absent from
	 * `deepseek.json`, so there is no rate here to copy. The windows above came
	 * from DeepSeek's published figures; prices recalled from memory would be the
	 * guess wearing a citation this file exists to refuse. `VITE_AGENT_COST` is
	 * the escape hatch, and it is the one the models this repo actually runs will
	 * be reached by.
	 */
	'deepseek-chat': { contextWindow: 128_000, reasoning: false },
	'deepseek-reasoner': { contextWindow: 128_000, reasoning: true },

	// anthropic.json. The 4-5 line splits: Sonnet carries 1M, Haiku and Opus 200K.
	'claude-haiku-4-5': {
		contextWindow: 200_000,
		reasoning: true,
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	},
	'claude-opus-4-5': {
		contextWindow: 200_000,
		reasoning: true,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	'claude-sonnet-4-5': {
		contextWindow: 1_000_000,
		reasoning: true,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	'claude-opus-5': {
		contextWindow: 1_000_000,
		reasoning: true,
		// The 5 line is the only one that reaches above `high`.
		thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	'claude-sonnet-5': {
		contextWindow: 1_000_000,
		reasoning: true,
		thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
		// Cheaper than 4-5, which is the sort of thing a remembered table gets
		// backwards: 2/10 against Sonnet 4-5's 3/15.
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	},

	// google.json — 1,048,576, not 1,000,000. The difference is only 5% but it is
	// the difference between a copied number and a rounded one.
	//
	// `cacheWrite: 0` throughout is Google's own entry, not a stand-in for
	// unknown: Gemini charges cache storage by time rather than per written
	// token, so there is no per-token write rate to carry. This is the one place
	// a zero means zero.
	'gemini-2.5-flash': {
		contextWindow: 1_048_576,
		reasoning: true,
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
	},
	'gemini-2.5-pro': {
		contextWindow: 1_048_576,
		reasoning: true,
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	},
	'gemini-3-pro-preview': {
		contextWindow: 1_048_576,
		reasoning: true,
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
		// `off: null` is the model refusing to stop thinking, and the two live
		// levels are upper-case because Google's API takes them that way. Without
		// this map we would offer `medium` and send a string Google never defined.
		thinkingLevelMap: { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' },
	},
};

/**
 * The user's window override.
 *
 * It wins, because it is both the escape hatch for an unlisted model and the
 * only way to exercise compaction without a genuinely enormous conversation —
 * the auto-compact path was validated at a window of 18,000.
 *
 * `import.meta.env?`, here and in `readReasoning`, because Vite always defines
 * that object and node running a check script does not. Without the `?.` both
 * readers throw instead of answering "no override", which would leave the two
 * functions holding this file's actual rule untestable — exactly as
 * `compaction.check.ts` had to leave `contextWindowFor`.
 */
export function readContextWindow(): number | undefined {
	const raw = import.meta.env?.VITE_AGENT_CONTEXT_WINDOW;
	const parsed = Number(raw);
	return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The user's reasoning override, for a model this table has never heard of.
 *
 * The same escape hatch `VITE_AGENT_CONTEXT_WINDOW` is, and needed for the same
 * reason: without it, running a reasoning model that landed after this table was
 * written means editing our source. `off` is accepted as well as `on` so the
 * override can also correct a wrong entry downward.
 */
export function readReasoning(): boolean | undefined {
	const raw = import.meta.env?.VITE_AGENT_REASONING;
	return raw === 'on' ? true : raw === 'off' ? false : undefined;
}

/**
 * The user's rate override — `VITE_AGENT_COST="input,output,cacheRead,cacheWrite"`,
 * dollars per million tokens.
 *
 * The same escape hatch the other two are, and the one that matters most: the
 * two models this repo actually runs are absent from pi's catalog, so without
 * this the cost line would be permanently absent for its only real user. Four
 * numbers rather than one, because a single price would have to pretend cache
 * reads cost what fresh input does — and cache reads are usually the majority
 * of a long conversation's tokens and a tenth of its price.
 *
 * Anything malformed answers `undefined`, which is the same "nobody has said"
 * every other unknown here produces. A partly-parsed override would be worse
 * than none: three good numbers and one `NaN` renders as a total of `NaN`.
 */
export function readCost(): ModelCostRates | undefined {
	const raw = import.meta.env?.VITE_AGENT_COST;
	if (!raw) {
		return undefined;
	}
	const parts = String(raw).split(',').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
		return undefined;
	}
	const [input, output, cacheRead, cacheWrite] = parts as [number, number, number, number];
	return { input, output, cacheRead, cacheWrite };
}

/**
 * What a million tokens cost on this model, or **undefined when nobody knows**.
 *
 * Undefined is the whole point. Everything downstream — the event, the turn
 * footer, the session total — treats it as "no cost shown" rather than as zero,
 * because a model missing from the table would otherwise report every turn as
 * free, and free is a number a person would act on.
 */
export function costFor(modelId: string): ModelCostRates | undefined {
	return readCost() ?? MODELS[modelId]?.cost;
}

/** What this model's window is, as far as anyone here knows. */
export function contextWindowFor(modelId: string): number | undefined {
	return readContextWindow() ?? MODELS[modelId]?.contextWindow;
}

/**
 * Whether this model reasons, or **undefined when nobody has said**.
 *
 * Undefined rather than `false` on purpose. `Model.reasoning` is a boolean and
 * has nowhere to put "unknown", which is the gap that let a guessed flag look
 * like a known one — so the unknown is represented here, and the caller decides
 * what to do with it. `contextWindowFor` already answers this way.
 */
export function reasoningFor(modelId: string): boolean | undefined {
	return readReasoning() ?? MODELS[modelId]?.reasoning;
}

/** The level map pi publishes for this model, if it publishes one. */
export function thinkingLevelMapFor(modelId: string): ThinkingLevelMap | undefined {
	return MODELS[modelId]?.thinkingLevelMap;
}

/**
 * Is this a model the table knows anything about?
 *
 * Exists so the UI can *say* the answer is a default rather than a fact. An
 * unknown model runs — nothing here refuses one, and `allModels()` advertises no
 * catalog so a genuinely dead id fails as the provider's own error — but it runs
 * with thinking off, and being told that is the difference between a decision
 * and a mystery.
 */
export function isKnownModel(modelId: string): boolean {
	return MODELS[modelId] !== undefined;
}

/**
 * Why a profile's thinking level will not happen, or an empty string.
 *
 * Lives here rather than in the JSX that renders it, for the reason
 * `transcript.ts` exists: a rule inside a `.tsx` cannot be checked, and this one
 * is a rule about when the app is quietly not doing what a profile asked.
 *
 * Two different cases, deliberately worded differently. An **unknown** model is
 * a gap in the table above, and the user has an escape hatch. A **known
 * non-reasoning** model is not a gap in anything — the profile is asking for
 * something that model cannot do, and `VITE_AGENT_REASONING=on` would only make
 * it fail further down. The first version of this warned on unknown alone and
 * missed the second entirely.
 */
export function thinkingUnavailable(modelId: string, level: string): string {
	if (!modelId || level === 'off' || reasoningFor(modelId)) {
		return '';
	}
	// An explicit override is the user having already said; do not tell them to
	// set the variable they just set.
	return isKnownModel(modelId) || readReasoning() !== undefined
		? ' ⚠ this model does not reason, so thinking is off'
		: ' ⚠ unknown model, so thinking is off — set VITE_AGENT_REASONING=on';
}
