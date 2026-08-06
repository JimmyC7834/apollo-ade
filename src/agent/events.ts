// pi's event stream, mapped down to the thirteen kinds the UI understands.
//
// Kept as a pure function so it can be checked without a model — `events.check.ts`
// does exactly that. It is also the only place that knows pi's event vocabulary,
// which is the vocabulary that breaks in minor releases every couple of days.

import {
	calculateContextTokens,
	type AgentHarnessEvent,
	type AgentMessage,
} from '@earendil-works/pi-agent-core';
import { contentText } from '@earendil-works/pi-ai';
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
 * A queued message as the user will read it back.
 *
 * `contentText` is pi-ai's own, which is what `AgentHarness` uses to read a
 * message: a queued message is `{ role: "user", content: [{ type: "text" }] }`
 * today and may carry images tomorrow, and this drops the parts that are not
 * text rather than rendering `[object Object]` beside them.
 */
function queuedText(messages: readonly AgentMessage[]): string[] {
	return messages
		// `AgentMessage` is a union, and one arm of it — a bash execution record —
		// has no `content` at all. Nothing this app queues is one of those (pi
		// builds a user message from the text), so the guard is a narrowing rather
		// than a case: an unrenderable message is dropped, not stringified.
		.map((message) => ('content' in message ? contentText(message.content).trim() : ''))
		.filter(Boolean);
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
					// pi's own reader, not `usage.totalTokens`. It *is* that field
					// first, but it falls back to `input + output + cacheRead +
					// cacheWrite` for a provider that omits the total — and reading
					// the field raw meant such a provider reported zero context
					// tokens, so auto-compaction would never fire and the meter
					// would sit at 0%. One call instead of a rule of ours.
					contextTokens: calculateContextTokens(usage),
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
		case 'queue_update':
			return [
				{
					kind: 'queued',
					steer: queuedText(event.steer),
					followUp: queuedText(event.followUp),
					// `event.nextTurn` is deliberately dropped. Nothing in this app
					// calls `nextTurn` — Enter on an idle harness is `prompt()` — so
					// carrying it would be carrying an array that is always empty.
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
