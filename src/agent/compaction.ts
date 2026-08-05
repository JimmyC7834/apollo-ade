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
// The entries moved to `models.ts` when `reasoning` joined them (ticket 19):
// this file is when to compact, not what a model is. Re-exported because the
// meter and the runner read the window through the same door they always did.
export { contextWindowFor, FALLBACK_CONTEXT_WINDOW } from './models.ts';

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
