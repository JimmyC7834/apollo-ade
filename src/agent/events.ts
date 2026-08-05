// pi's event stream, mapped down to the twelve kinds the UI understands.
//
// Kept as a pure function so it can be checked without a model — `events.check.ts`
// does exactly that. It is also the only place that knows pi's event vocabulary,
// which is the vocabulary that breaks in minor releases every couple of days.

import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core';
// Explicit extension: `events.check.ts` runs this file under plain node, which
// does not resolve extensionless paths. Type-only imports are erased and so do
// not need it; this one is a value.
import { overflowMessage } from './compaction.ts';
import type { AgentEvent } from './index';

/**
 * The text pi put in a tool result, which is what the model was told.
 *
 * `AgentToolResult` is an object, so `String(result)` yields "[object Object]"
 * and throws the diagnostic away. That shipped once and made the first real
 * tool failure unreadable, which is why the contract carries a string and this
 * function is the only thing that produces it.
 */
export function resultText(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] } | null)?.content;
	const text = content
		?.filter((part) => part.type === 'text')
		.map((part) => part.text ?? '')
		.join('\n')
		.trim();
	if (text) {
		return text;
	}
	return typeof result === 'string' ? result : JSON.stringify(result ?? null);
}

/**
 * Map one pi event down to the contract, or to nothing.
 *
 * Returns an array rather than a single event because that is what the data
 * needs, not for generality: most `message_update`s are neither text nor
 * thinking and produce none, while a failed `message_end` produces both `usage`
 * and `error`.
 *
 * `approval` is not produced here. It comes from the `tool_call` *hook*, which
 * is a different channel with a return value — mapping it as an event would
 * lose the ability to answer it.
 *
 * `contextWindow` is passed rather than read so this stays a pure function; it
 * is optional because *not knowing the window is a supported state*, and both
 * things it feeds — the meter's percentage and overflow detection — degrade to
 * what they were before rather than to something invented.
 */
export function mapEvent(event: AgentHarnessEvent, contextWindow?: number): AgentEvent[] {
	switch (event.type) {
		case 'message_update': {
			const inner = event.assistantMessageEvent;
			if (inner.type === 'text_delta') {
				return [{ kind: 'text', text: inner.delta }];
			}
			if (inner.type === 'thinking_delta') {
				return [{ kind: 'thinking', text: inner.delta }];
			}
			return [];
		}
		case 'tool_execution_start':
			return [
				{ kind: 'tool_start', id: event.toolCallId, name: event.toolName, input: event.args },
			];
		case 'tool_execution_update':
			return [
				{ kind: 'tool_update', id: event.toolCallId, partial: resultText(event.partialResult) },
			];
		case 'tool_execution_end':
			return [
				{
					kind: 'tool_end',
					id: event.toolCallId,
					result: resultText(event.result),
					isError: event.isError,
				},
			];
		case 'message_end': {
			const message = event.message;
			if (message.role !== 'assistant') {
				return [];
			}
			const usage = message.usage;
			const events: AgentEvent[] = [
				{
					kind: 'usage',
					inputTokens: usage.input,
					outputTokens: usage.output,
					// The provider's own total. Revisited when this had to drive
					// compaction, and it turned out to need no change:
					// `calculateContextTokens` is `usage.totalTokens` with a
					// fallback for providers that omit it, not a richer number.
					contextTokens: usage.totalTokens,
					// Carried alongside so the meter can render a share rather
					// than a bare count. Absent when nobody has configured one.
					contextWindow,
				},
			];
			// A failed turn still ends with a message — the failure is a field on
			// it, not a separate event. Missing this renders a model error as
			// silence, which is how it was found.
			if (message.stopReason === 'error') {
				events.push({
					kind: 'error',
					// An overflow is named as one. It is the single failure the
					// user can actually fix from here, and left raw it reads like
					// any other provider string — including a bad key.
					message:
						overflowMessage(message, contextWindow) ??
						message.errorMessage ??
						'The model returned an error.',
				});
			}
			return events;
		}
		case 'session_compact':
			return [
				{
					kind: 'compacted',
					tokensBefore: event.compactionEntry.tokensBefore,
					summary: event.compactionEntry.summary,
				},
			];
		case 'abort':
			return [{ kind: 'cancelled' }];
		case 'agent_end':
			return [{ kind: 'complete' }];
		default:
			return [];
	}
}
