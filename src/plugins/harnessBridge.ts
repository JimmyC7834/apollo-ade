// The only file that puts a plugin anywhere near pi — ticket 73.
//
// Every `harness.on` a plugin is behind is in here, and there is exactly one of
// them per event. That is the point: `hooks.ts` explains that handing plugin
// handlers straight to `harness.on` deletes the permission gate without any test
// failing, and the defence is that the handlers are unreachable — the registry
// has no getter — and that the wiring is one reviewed file rather than a pattern
// spread through `provider.ts`.
//
// It is also the mapping layer. pi's event shapes change in minor releases; ours
// change when `api` says so. Everything below is the boring translation between
// them, and it is boring on purpose.

import type { AgentHarness } from '@earendil-works/pi-agent-core';

import { resultText } from '../agent/events.ts';
import {
	notifyPlugins,
	runToolCall,
	type ToolCallDecision,
	type ToolCallPayload,
} from './hooks.ts';

/**
 * What the gate would say, asked only when no plugin has already said no.
 *
 * Passed in rather than imported so this file has no opinion about *which* gate
 * runs — the subagent runner uses the child profile's policy, and that decision
 * stays where it was made.
 */
export type GateDecision = (event: HarnessToolCall) => Promise<ToolCallDecision | undefined>;

/** pi's own shape, which the gate already takes. Not what plugins are handed. */
export interface HarnessToolCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Record<string, unknown>;
}

/**
 * Wire one harness up to the plugins, and hand back the disposer.
 *
 * The `tool_call` registration **replaces** the gate's own: the gate is now
 * reached through `runToolCall`, which runs the plugins first and combines with
 * deny precedence. Registering both separately is the trap — `emitHook` keeps
 * only the last non-undefined result, so whichever ran second would win.
 */
export function bridgePlugins<T extends object | undefined>(
	harness: AgentHarness<T>,
	gate: GateDecision
): () => void {
	const offs = [
		harness.on('tool_call', (event) => {
			const payload: ToolCallPayload = {
				callId: event.toolCallId,
				tool: event.toolName,
				// A copy. Rule 1 of ADR 0005 — nothing but data crosses — and this is
				// the object pi hands to `execute`, so a plugin holding it could
				// rewrite the command after the gate had read it.
				input: { ...event.input },
			};
			return runToolCall(payload, () => gate(event));
		}),
		/*
		 * Notifications from here down. Every one returns `undefined`, and that is
		 * load-bearing rather than tidy: a non-undefined result from any of these
		 * would displace whatever our own handler for the same event returned —
		 * the `emitHook` trap from the other direction. `notifyPlugins` is typed
		 * `Promise<undefined>` so this cannot be got wrong quietly.
		 */
		harness.on('before_agent_start', (event) =>
			notifyPlugins('turn_start', { prompt: event.prompt, systemPrompt: event.systemPrompt })
		),
		harness.on('settled', (event) => notifyPlugins('turn_end', { queued: event.nextTurnCount })),
		harness.on('tool_result', (event) =>
			notifyPlugins('tool_result', {
				callId: event.toolCallId,
				tool: event.toolName,
				isError: event.isError,
				// The same reader the transcript uses, so a plugin sees what the
				// model saw rather than `[object Object]`.
				text: resultText({ content: event.content }),
			})
		),
		harness.on('model_update', (event) => notifyPlugins('model_update', { model: event.model.id })),
		harness.on('tools_update', (event) =>
			notifyPlugins('tools_update', { tools: event.toolNames, active: event.activeToolNames })
		),
		harness.on('session_compact', (event) =>
			notifyPlugins('compacted', {
				tokensBefore: event.compactionEntry.tokensBefore,
				summary: event.compactionEntry.summary,
			})
		),
		harness.on('abort', (event) =>
			notifyPlugins('abort', {
				clearedSteer: event.clearedSteer.length,
				clearedFollowUp: event.clearedFollowUp.length,
			})
		),
	];
	return () => {
		for (const off of offs) {
			off();
		}
	};
}
