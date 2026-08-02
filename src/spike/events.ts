// SPIKE — delete with `rm -r src/spike`.
//
// The eleven-kind contract from
// docs/wayfinder/pi-harness/tickets/05-event-contract.md, written out as a type
// and a mapping function. This file *is* the falsification target: if a real
// streamed turn produces something that does not fit below, the contract was
// wrong and that ticket reopens.
//
// It is a pure function over pi's events so it can be exercised without a
// model, which is what `events.check.ts` does.

import type { AgentHarnessEvent } from '@earendil-works/pi-agent-core';

export type PiEvent =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'thinking'; readonly text: string }
	| { readonly kind: 'tool_start'; readonly id: string; readonly name: string; readonly input: unknown }
	| { readonly kind: 'tool_update'; readonly id: string; readonly partial: unknown }
	| {
			readonly kind: 'tool_end';
			readonly id: string;
			readonly result: unknown;
			readonly isError: boolean;
	  }
	| { readonly kind: 'approval'; readonly id: string; readonly name: string; readonly input: unknown }
	| {
			readonly kind: 'usage';
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly contextTokens: number;
	  }
	| { readonly kind: 'compacted'; readonly tokensBefore: number; readonly summary: string }
	| { readonly kind: 'error'; readonly message: string; readonly code?: string }
	| { readonly kind: 'complete' }
	| { readonly kind: 'cancelled' };

/**
 * Map one pi event down to the contract, or to nothing.
 *
 * Returning an array rather than a single event is not speculative generality:
 * `message_update` legitimately produces zero events (most deltas are neither
 * text nor thinking) and `agent_end` produces both `usage` and `complete`.
 *
 * `approval` is not produced here. It comes from the `tool_call` *hook*, which
 * is a different channel with a return value — mapping it as an event would
 * lose the ability to answer it. The spike registers no gate, so nothing emits
 * it, and that is a gap this file records rather than hides.
 */
export function mapEvent(event: AgentHarnessEvent): PiEvent[] {
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
			return [{ kind: 'tool_update', id: event.toolCallId, partial: event.partialResult }];
		case 'tool_execution_end':
			return [
				{
					kind: 'tool_end',
					id: event.toolCallId,
					result: event.result,
					isError: event.isError,
				},
			];
		case 'message_end': {
			const message = event.message;
			if (message.role !== 'assistant') {
				return [];
			}
			const usage = message.usage;
			const events: PiEvent[] = [
				{
					kind: 'usage',
					inputTokens: usage.input,
					outputTokens: usage.output,
					// The spike reports the provider's own total rather than
					// pi's `calculateContextTokens`, which needs the whole
					// session. Enough for a meter; revisit if the number has to
					// drive compaction.
					contextTokens: usage.totalTokens,
				},
			];
			// A failed turn still ends with a message — the failure is a field
			// on it, not a separate event. Missing this is how model errors end
			// up rendered as silence.
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
