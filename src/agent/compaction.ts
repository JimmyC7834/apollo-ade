// When history has to be summarised, and what it is measured against.
//
// Settled in docs/wayfinder/pi-harness/tickets/16-compaction.md. pi ships every
// primitive used here and calls none of them: `shouldCompact` and
// `isContextOverflow` are both exported for applications and referenced by
// neither package. That is deliberate on pi's part — it supplies context-pressure
// primitives and owns none of the policy — so the policy is this file, and most
// of it is a refusal to guess.

import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from '@earendil-works/pi-agent-core';
import { isContextOverflow, type AssistantMessage } from '@earendil-works/pi-ai';

/**
 * The window handed to pi when none is configured.
 *
 * pi requires `Model.contextWindow` to be a number — it feeds
 * `clampMaxTokensToContext` — so a value has to exist whatever we know. This one
 * is a guess with no source, kept only because the type demands it, and
 * **`readContextWindow` rather than this is what any compaction decision
 * consults.** A fabricated window that silently moved the compaction threshold
 * would be the failure this whole design is arranged to avoid.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * The model's real context window, if anyone has said what it is.
 *
 * A per-profile field once profiles exist; an env var until then, following
 * `readGatePolicy`. **Undefined is a supported answer** and means auto-compaction
 * cannot fire and the meter shows no percentage.
 *
 * Refusing to default is the point. The two numbers available to guess from were
 * our own hard-coded 128k and pi's 1,000,000 for `deepseek-reasoner`'s nearest
 * catalogued neighbours; both err upward, and upward is the direction in which
 * `shouldCompact` silently never fires. This is the rule the zeroed `cost` block
 * in `provider.ts` already follows, applied to the one field where being wrong
 * changes behaviour instead of only the display.
 */
export function readContextWindow(): number | undefined {
	const raw = import.meta.env.VITE_AGENT_CONTEXT_WINDOW;
	const parsed = Number(raw);
	return raw && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Whether the agent may compact without being asked. Off unless enabled. */
export function readAutoCompact(): boolean {
	return import.meta.env.VITE_AGENT_AUTOCOMPACT === 'on';
}

/**
 * Is the conversation close enough to the window to summarise it?
 *
 * pi's own predicate, over pi's own settings, with one addition: an unknown
 * window is never close enough. `DEFAULT_COMPACTION_SETTINGS` is passed rather
 * than tuned because `AgentHarness.compact()` hard-codes it internally when it
 * calls `prepareCompaction` — **the trigger is ours to move, the retention is
 * not.** Reserving different tokens here than the summariser reserves would only
 * describe a compaction that does not happen.
 */
export function needsCompaction(
	contextTokens: number,
	contextWindow: number | undefined
): boolean {
	return contextWindow === undefined
		? false
		: shouldCompact(contextTokens, contextWindow, DEFAULT_COMPACTION_SETTINGS);
}

export interface Pressure {
	/** Share of the window in use, clamped to 100. */
	readonly percent: number;
	/** True once compaction would fire — the number worth styling. */
	readonly warn: boolean;
}

/** How full the context is, or nothing when the window is unknown. */
export function pressure(
	contextTokens: number,
	contextWindow: number | undefined
): Pressure | undefined {
	if (contextWindow === undefined) {
		return undefined;
	}
	return {
		percent: Math.min(100, Math.round((contextTokens / contextWindow) * 100)),
		warn: needsCompaction(contextTokens, contextWindow),
	};
}

/**
 * A failed turn that failed *for this reason*, said plainly.
 *
 * Without it an overflow reads as a raw provider string — "prompt is too long:
 * 203914 tokens > 131072 maximum" at best, and at worst something the user
 * cannot tell apart from a bad API key. `isContextOverflow` carries a pattern
 * table for roughly fifteen providers, so this is one of the few places where
 * adopting pi buys knowledge rather than code.
 *
 * Returns undefined when the failure is anything else, so the caller keeps the
 * provider's own message.
 */
export function overflowMessage(
	message: AssistantMessage,
	contextWindow: number | undefined
): string | undefined {
	return isContextOverflow(message, contextWindow)
		? 'This conversation is too long for the model’s context. Run /compact and try again.'
		: undefined;
}

/**
 * What to say when compacting did not happen.
 *
 * `AgentHarness.compact()` throws rather than returning a `Result`, and
 * "Nothing to compact" is not a malfunction — it is what a short conversation
 * does, and typing `/compact` on one is a reasonable thing to try. It reads as
 * an explanation here rather than as a failure.
 */
export function compactionMessage(cause: unknown): string {
	const text = cause instanceof Error ? cause.message : String(cause);
	return /nothing to compact/i.test(text)
		? 'There is not enough conversation to summarise yet.'
		: text;
}
