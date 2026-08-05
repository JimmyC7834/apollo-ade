// How a tool asks a question.
//
// docs/wayfinder/pi-harness/tickets/18-tool-reaches-the-gate.md named the gap:
// `createGate` can ask because a *turn* owns it and its `tool_call` hook holds a
// promise open, where a tool's `execute()` receives
// `(toolCallId, params, signal, onUpdate, context)` and has no way to emit a
// question or await an answer. This is that handle, built as the smallest thing
// that closes it: a per-runner object the turn points at its own event sink.
//
// It is deliberately *not* the gate. The gate asks "may I", answers boolean, and
// exists to stop something; this asks "which", answers text, and exists because
// the model does not know something. Folding them together would mean either the
// gate grew options it has no use for, or a question inherited a deny list it has
// nothing to do with. They share only the shape of the problem — one outstanding
// promise, abandoned if the run stops.

import { Type, type TSchema } from 'typebox';
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';
// Explicit extension: reachable from `ask.check.ts`, which node runs without
// Vite's resolution. Same reason as `events.ts` and `userTools.ts`.
import type { AgentEvent } from './index.ts';

/** Model-visible name. Reserved in `userTools.ts` so a manifest cannot shadow it. */
export const ASK_TOOL = 'ask_user';

/**
 * How the free-text box is labelled, and what a typed answer is prefixed with
 * when it travels back beside chosen options.
 *
 * Named rather than inlined because the UI and the tool result have to agree:
 * the user sees this word above the box, and the model sees the same word in
 * front of what they typed.
 */
export const OTHER = 'Other';

export interface Asker {
	/**
	 * Point the asker at the running turn's sink.
	 *
	 * Called per turn, like `createGate` is built per turn. The asker itself is
	 * per runner because the *tool* is built once — `setTools` is what the harness
	 * holds, and rebuilding the tool set every turn to re-close over an `onEvent`
	 * would put a tool-set change inside every run, which is the one thing the
	 * profile-switch queue exists to prevent.
	 */
	begin(emit: (event: AgentEvent) => void): void;
	/** Answer the outstanding question. Extra calls are ignored. */
	answer(chosen: readonly string[]): void;
	/** Abandon it, so a stopped run does not leave the tool awaiting forever. */
	abandon(): void;
	/** Ask, and resolve when the user answers. `undefined` means abandoned. */
	ask(id: string, question: Question): Promise<readonly string[] | undefined>;
}

export interface Question {
	readonly question: string;
	readonly options: readonly string[];
	readonly multiSelect: boolean;
}

export function createAsker(): Asker {
	let emit: ((event: AgentEvent) => void) | undefined;
	let pending: ((chosen: readonly string[] | undefined) => void) | undefined;

	const settle = (chosen: readonly string[] | undefined) => {
		const resolve = pending;
		pending = undefined;
		resolve?.(chosen);
	};

	return {
		begin(sink) {
			// A turn starting while a question is outstanding can only mean the last
			// one was never settled. Abandoning it here is what keeps a leaked
			// promise from being answered by an unrelated turn's user.
			settle(undefined);
			emit = sink;
		},

		async ask(id, question) {
			if (!emit) {
				throw new Error('there is no run to ask in');
			}
			// Tools run sequentially in pi's loop, so a second outstanding question
			// is a bug rather than a race — and a hung turn is the worst failure
			// available here, so it is refused loudly rather than queued.
			if (pending) {
				throw new Error('another question is already waiting for the user');
			}

			emit({
				kind: 'question',
				id,
				question: question.question,
				options: question.options,
				multiSelect: question.multiSelect,
			});

			return await new Promise<readonly string[] | undefined>((resolve) => {
				pending = resolve;
			});
		},

		answer: (chosen) => settle(chosen),
		abandon: () => settle(undefined),
	};
}

/**
 * The one tool that asks the user something.
 *
 * Two variants, one tool. `multiSelect` is a parameter rather than a second
 * `ask_user_multi`, because everything either would hold — the prompt, the
 * options, the free-text box, the result shape — is the same, and a model that
 * has to choose between two near-identical tools chooses wrong more often than
 * one that sets a boolean.
 *
 * **The free-text box is not an option and is not optional.** It is not in
 * `options` because a model that could omit it would, and the case it covers is
 * exactly the one the model failed to anticipate — the whole reason it is asking.
 * Rendering it unconditionally is what makes a badly-guessed option list
 * recoverable instead of a dead end.
 */
export function createAskTool(asker: Asker): AgentHarnessTool<{ env: unknown }> {
	return {
		name: ASK_TOOL,
		label: 'Ask the user',
		description:
			'Ask the user a multiple-choice question and wait for their answer. Use this when a ' +
			'choice is theirs to make and guessing would waste work — not for questions you can ' +
			'answer by reading the code. Set multiSelect when more than one answer can apply. The ' +
			`user can always write a free-text answer instead of picking, which arrives as "${OTHER}: …".`,
		parameters: Type.Object({
			question: Type.String({ description: 'The question, as one plain sentence.' }),
			options: Type.Array(Type.String(), {
				description: 'The choices to offer. Two to four, each a short phrase.',
			}),
			multiSelect: Type.Optional(
				Type.Boolean({ description: 'Allow more than one choice. Defaults to false.' })
			),
		}) as TSchema,

		async execute(id, params, signal) {
			const input = params as { question?: unknown; options?: unknown; multiSelect?: unknown };

			// Validated rather than trusted. The schema is advisory — pi hands the
			// model's arguments through — and an empty option list would render a
			// question with nothing but the text box, which reads as a bug to the
			// user rather than as a question.
			const question = typeof input.question === 'string' ? input.question.trim() : '';
			if (!question) {
				throw new Error('question is required');
			}
			const options = Array.isArray(input.options)
				? input.options.filter((option): option is string => typeof option === 'string')
				: [];
			if (options.length === 0) {
				throw new Error('options must hold at least one choice');
			}

			const onAbort = () => asker.abandon();
			signal?.addEventListener('abort', onAbort, { once: true });
			try {
				const chosen = await asker.ask(id, {
					question,
					options,
					multiSelect: input.multiSelect === true,
				});
				// Abandoned: the run was stopped, or the view went away. Throwing is
				// how a tool reports failure to pi, and the model needs to know it
				// never got an answer rather than infer one from an empty string.
				if (!chosen || chosen.length === 0) {
					throw new Error('the user did not answer');
				}
				return { content: [{ type: 'text', text: chosen.join('\n') }], details: undefined };
			} finally {
				signal?.removeEventListener('abort', onAbort);
			}
		},
	};
}
