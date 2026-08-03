// pi's event stream, mapped down to the eleven kinds the UI understands.
//
// Kept as a pure function so it can be checked without a model — `events.check.ts`
// does exactly that. It is also the only place that knows pi's event vocabulary,
// which is the vocabulary that breaks in minor releases every couple of days.

import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core';
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
 */
export function mapEvent(event: AgentHarnessEvent): AgentEvent[] {
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
					// The provider's own total rather than pi's
					// `calculateContextTokens`, which needs the whole session.
					// Enough for a meter; revisit if it has to drive compaction.
					contextTokens: usage.totalTokens,
				},
			];
			// A failed turn still ends with a message — the failure is a field on
			// it, not a separate event. Missing this renders a model error as
			// silence, which is how it was found.
			if (message.stopReason === 'error') {
				events.push({
					kind: 'error',
					message: message.errorMessage ?? 'The model returned an error.',
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
