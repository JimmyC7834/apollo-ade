// The agent seam. The chat UI talks to `AgentProvider` and never to a model,
// a network client, or a native command. Slice 11 ships only the deterministic
// provider on purpose: cancellation and approval are the hard parts, and they
// are far easier to get right against a run that behaves the same every time.

export type AgentEvent =
	/** One chunk of streamed prose. Chunks concatenate; they are not lines. */
	| { readonly kind: 'text'; readonly text: string }
	/** Something the agent did. Secondary to the prose, never a substitute for it. */
	| { readonly kind: 'activity'; readonly label: string; readonly detail?: string }
	/** The run is paused until `resolveApproval` is called. */
	| { readonly kind: 'approval'; readonly label: string; readonly detail: string }
	| { readonly kind: 'complete' }
	| { readonly kind: 'cancelled' };

export interface AgentRun {
	cancel(): void;
	resolveApproval(approved: boolean): void;
}

export interface AgentProvider {
	start(prompt: string, onEvent: (event: AgentEvent) => void): AgentRun;
}

/** A scripted step. `complete`/`cancelled` are outcomes, so they are not steps. */
type Step = Extract<AgentEvent, { kind: 'text' | 'activity' | 'approval' }>;

const TARGET = 'src/main.ts';

function script(prompt: string): Step[] {
	return [
		{ kind: 'text', text: `Working on: ${prompt.trim()}\n\n` },
		{ kind: 'activity', label: 'Read file', detail: TARGET },
		{ kind: 'activity', label: 'Search workspace', detail: 'console.log' },
		{
			kind: 'text',
			text: 'I found one place to change, and applying it needs your approval first.\n',
		},
		{ kind: 'approval', label: 'Apply edit', detail: `${TARGET} — replace the log call` },
	];
}

const AFTER_APPROVE: Step[] = [
	{ kind: 'activity', label: 'Apply edit', detail: TARGET },
	{
		kind: 'text',
		text: '\nApplied. Nothing reached disk: this provider does not call workspace tools yet.',
	},
];

const AFTER_SKIP: Step[] = [{ kind: 'text', text: '\nSkipped. Nothing was changed.' }];

/*
 * Pacing. Animation frames render the stream at the display's rate, but they
 * stop entirely in a hidden window — a run would then stall mid-stream, or
 * worse, mid-approval, until someone looked at it again. The provider's
 * lifecycle has to be independent of rendering, so a hidden document (and Node,
 * which has no frames at all) falls back to a timer.
 *
 * Returns its own canceller: frame handles and timer handles are different id
 * spaces, and a stored raw number cannot say which one it is.
 */
function schedule(run: () => void): () => void {
	if (typeof requestAnimationFrame === 'function' && !globalThis.document?.hidden) {
		const handle = requestAnimationFrame(run);
		return () => cancelAnimationFrame(handle);
	}
	const handle = setTimeout(run, 16);
	return () => clearTimeout(handle);
}

/**
 * Deterministic agent runs: the same prompt always produces the same events in
 * the same order, so cancellation and approval can be reasoned about and
 * checked. Both modes use it — there is no native agent to fall back from.
 */
export function createAgentProvider(): AgentProvider {
	return {
		start(prompt, onEvent) {
			const steps = script(prompt);
			// Words carry their trailing whitespace, so the chunks reassemble
			// into exactly the source text.
			let words: string[] = [];
			let index = 0;
			let cancelTick = (): void => {};
			let done = false;
			let waiting = false;

			function finish(kind: 'complete' | 'cancelled'): void {
				if (done) {
					return;
				}
				done = true;
				cancelTick();
				onEvent({ kind });
			}

			function tick(): void {
				if (done || waiting) {
					return;
				}
				const word = words.shift();
				if (word !== undefined) {
					onEvent({ kind: 'text', text: word });
					cancelTick = schedule(tick);
					return;
				}
				const step = steps[index++];
				if (!step) {
					finish('complete');
					return;
				}
				if (step.kind === 'text') {
					words = step.text.match(/\S+\s*|\s+/g) ?? [];
				} else if (step.kind === 'approval') {
					// Stop scheduling entirely. A run that keeps ticking behind a
					// pending approval is a run that can act before the answer.
					waiting = true;
					onEvent(step);
					return;
				} else {
					onEvent(step);
				}
				cancelTick = schedule(tick);
			}

			cancelTick = schedule(tick);

			return {
				cancel: () => finish('cancelled'),
				resolveApproval(approved) {
					if (done || !waiting) {
						return;
					}
					waiting = false;
					steps.splice(index, 0, ...(approved ? AFTER_APPROVE : AFTER_SKIP));
					cancelTick = schedule(tick);
				},
			};
		},
	};
}
