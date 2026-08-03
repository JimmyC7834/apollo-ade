// What stops a tool call.
//
// Settled in docs/wayfinder/pi-harness/tickets/03-permission-gate.md: TypeScript
// asks, Rust enforces. This file is only the asking half. The floor — refusing
// writes outside the workspace root — lives in `agent_write_file` and applies
// whatever this decides, because once user-authored tools share the renderer, a
// gate that lives only in the renderer is one that user code can reach around.

import type { AgentEvent } from './index';

/**
 * How much the gate asks.
 *
 * A per-profile field once profiles exist; an env var until then. `auto` is the
 * default and never prompts — **auto mode is the policy dial set to permissive,
 * not the absence of a gate**, which is why the mechanism below is identical in
 * both modes and supporting `auto` costs nothing structural.
 */
export type GatePolicy = 'auto' | 'careful';

export function readGatePolicy(): GatePolicy {
	return import.meta.env.VITE_AGENT_GATE === 'careful' ? 'careful' : 'auto';
}

/**
 * Which tools change something.
 *
 * The gate examines what a tool *does*, not what it is called — the amendment
 * on ticket 13. Naming the mutating built-ins is how that is expressed while
 * the built-ins are all there is; once `bash` lands, its *command* is what gets
 * examined, not the fact that it is `bash`.
 */
const MUTATING = new Set(['write', 'edit']);

export interface Gate {
	/**
	 * pi's `tool_call` hook. Returning `undefined` lets the call proceed;
	 * returning `{ block: true }` produces an ordinary error `tool_result` the
	 * model sees and can adapt to.
	 *
	 * **It must never throw.** A handler that throws is wrapped into an
	 * `AgentHarnessError` with code `hook` and *aborts the turn* — so a declined
	 * approval returns `{ block: true }` rather than rejecting. That is the
	 * single easiest way to get this wrong, which is why it is asserted in
	 * `gate.check.ts`.
	 */
	onToolCall(event: {
		toolCallId: string;
		toolName: string;
		input: Record<string, unknown>;
	}): Promise<{ block?: boolean; reason?: string } | undefined>;
	/** Answer the question the gate is currently waiting on. */
	resolve(approved: boolean): void;
	/** Abandon any pending question, so a cancelled run does not hang forever. */
	abandon(): void;
}

export function createGate(
	policy: GatePolicy,
	emit: (event: AgentEvent) => void
): Gate {
	let pending: ((approved: boolean) => void) | undefined;

	const settle = (approved: boolean) => {
		const resolve = pending;
		pending = undefined;
		resolve?.(approved);
	};

	return {
		async onToolCall(event) {
			if (policy === 'auto' || !MUTATING.has(event.toolName)) {
				return undefined;
			}

			// A second question while one is outstanding would strand the first
			// promise forever. Tools run sequentially in pi's loop, so this is a
			// guard against a bug rather than an expected race — but a hung turn
			// is the worst possible failure here, so it is refused loudly.
			if (pending) {
				return { block: true, reason: 'another approval is already pending' };
			}

			emit({
				kind: 'approval',
				id: event.toolCallId,
				name: event.toolName,
				input: event.input,
			});

			const approved = await new Promise<boolean>((resolve) => {
				pending = resolve;
			});

			return approved ? undefined : { block: true, reason: 'The user declined this change.' };
		},

		resolve: settle,
		// Treated as a decline: the call must not proceed on a run the user
		// stopped. The transcript still records the question as unanswered,
		// because cancelling is not an answer.
		abandon: () => settle(false),
	};
}
