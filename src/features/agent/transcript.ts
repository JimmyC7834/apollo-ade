// Pure transcript reduction for `AgentChat`. It lives in its own module, free
// of JSX, so `npm run check` can run it under Node's type stripping — the same
// arrangement as `treeRows.ts`. What is here is every rule about who owns a
// question and when it stops being askable, which is exactly the part that was
// wrong when it lived inside the component.

import type { AgentEvent } from '../../agent';
// Explicit extension: `transcript.check.ts` runs this under plain node.
import { ASK_TOOL } from '../../agent/ask.ts';

export type ApprovalState = 'pending' | 'approved' | 'skipped';

/**
 * A tool call, from request to outcome.
 *
 * One part rather than a start part and an end part, because a call *is* one
 * thing that changes state — rendering two would make the transcript grow a
 * line every time a tool reported progress, and would leave no way to show a
 * call that never finished.
 */
export interface ToolPart {
	readonly kind: 'tool';
	readonly id: string;
	readonly name: string;
	readonly input: unknown;
	readonly state: 'running' | 'done' | 'failed';
	/** Live output while running, then the final result. */
	readonly output?: string;
}

export type Part =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'thinking'; readonly text: string }
	| ToolPart
	| { readonly kind: 'error'; readonly message: string; readonly code?: string }
	| { readonly kind: 'compacted'; readonly tokensBefore: number; readonly summary: string }
	/**
	 * The turn was undone, and this is what that did to the tree.
	 *
	 * A part rather than a flag on the `Turn`, so it appears *after* whatever the
	 * turn produced — reading in the order it happened, which is the only order
	 * that makes "these edits are gone" attach to the edits above it. The same
	 * sentence is in the model's context; see `undo.ts`.
	 */
	| { readonly kind: 'undone'; readonly note: string }
	| {
			readonly kind: 'approval';
			readonly id: string;
			readonly label: string;
			readonly detail: string;
			readonly state: ApprovalState;
	  }
	| QuestionPart;

/**
 * A question the agent asked, from asking to answered.
 *
 * `answer` is stored rather than derived because it is the only record of what
 * the user said: the tool result carries it to the *model*, but the transcript
 * is what the user reads back, and "Answered" without the answer is a worse
 * record than none.
 */
export interface QuestionPart {
	readonly kind: 'question';
	readonly id: string;
	readonly question: string;
	readonly options: readonly string[];
	readonly multiSelect: boolean;
	/** Two states, not `ApprovalState`'s three: a question has no decline. The
	 * nearest thing is a run that ended without one, and that is `Turn.status`. */
	readonly state: 'pending' | 'answered';
	readonly answer?: readonly string[];
}

export interface Usage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly contextTokens: number;
	/** What `contextTokens` is a share of, when anyone has said. */
	readonly contextWindow?: number;
	/**
	 * The four parts of what the turn cost, in dollars, or absent when the
	 * model's rates are unknown. Kept whole rather than summed here so the
	 * breakdown survives to wherever it is eventually shown — the sum is one
	 * line and the parts cannot be recovered from it.
	 */
	readonly cost?: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
}

/**
 * What a turn cost, as one number, or undefined when nothing is known.
 *
 * Undefined rather than 0 the whole way down. `sessionCost` sums these, and a
 * missing turn has to be able to contribute nothing without turning the total
 * into a claim about a price nobody has.
 */
export function turnCost(usage: Usage | undefined): number | undefined {
	const cost = usage?.cost;
	return cost && cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

/**
 * What the conversation has cost so far, or undefined when no turn was priced.
 *
 * Unpriced turns are skipped rather than counted as zero, so a session that
 * switched models halfway reports the part it knows. That makes the total a
 * floor rather than a fact — which is why `AgentChat` labels it as a session
 * total beside per-turn figures the reader can add up themselves, rather than
 * as a bill.
 */
export function sessionCost(turns: readonly Turn[]): number | undefined {
	let total: number | undefined;
	for (const turn of turns) {
		const cost = turnCost(turn.usage);
		if (cost !== undefined) {
			total = (total ?? 0) + cost;
		}
	}
	return total;
}

/**
 * A dollar amount, at a precision that does not round it away.
 *
 * Two decimals is the obvious choice and it is wrong here: a cheap turn costs
 * a tenth of a cent, and `$0.00` on every turn is the same failure as showing
 * nothing — worse, because it looks like a measurement. Below a cent it goes to
 * four places, which is where a Haiku turn stops being invisible.
 */
export function formatCost(dollars: number): string {
	return dollars >= 0.01 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(4)}`;
}

export interface Turn {
	readonly id: number;
	readonly prompt: string;
	readonly parts: readonly Part[];
	readonly status: 'running' | 'complete' | 'cancelled';
	/** Last reported usage for the turn. Absent until the provider reports any. */
	readonly usage?: Usage;
	/**
	 * The tree as it was before this turn ran, if anything was saved.
	 *
	 * What makes the turn undoable. Absent means it is not — no repository, a
	 * clean tree, or browser mode — and the UI offers nothing rather than a
	 * button that fails.
	 */
	readonly checkpoint?: string;
	/**
	 * What you typed during the turn that has not been sent yet.
	 *
	 * Not `Part`s. A part is something that happened, and these have not happened
	 * — they are the turn's pending state, and pi replaces both lists whole on
	 * every change. Appending them as parts would leave the transcript claiming a
	 * message was sent when the queue had in fact drained it, or thrown it away.
	 */
	readonly queued?: {
		readonly steer: readonly string[];
		readonly followUp: readonly string[];
	};
}

/**
 * Is this approval still a question the user can answer?
 *
 * The run has to be alive for it to be one. This is the single rule the whole
 * defect turned on, so it is here and not in the JSX that renders the buttons:
 * a rule that lives in a `.tsx` cannot be checked, and this one silently stopped
 * being true once and shipped.
 *
 * Deliberately not a type predicate. Narrowing would run backwards — `false`
 * would tell TypeScript the part is not an approval, when the usual reason for
 * `false` is that it is one and its run has ended.
 */
export function canAnswer(part: Part, turn: Turn): boolean {
	return (
		(part.kind === 'approval' || part.kind === 'question') &&
		part.state === 'pending' &&
		turn.status === 'running'
	);
}

/**
 * Is there anything to undo here, and is now the time?
 *
 * Three conditions, and each one is a way the button could otherwise lie. No
 * checkpoint means nothing was saved. A running turn is not finished changing
 * the tree, so its checkpoint is not yet what "before this turn" will mean to
 * the person clicking. And an already-undone turn's checkpoint is still a valid
 * sha — restoring it a second time would silently discard everything done since
 * the first undo, which is the opposite of what a second click implies.
 *
 * The provider refuses a running turn as well, from the queue. Two guards for
 * one rule, deliberately: this one is what makes the button absent, and that one
 * is what makes the absence not a security property of the UI.
 */
export function canUndo(turn: Turn): boolean {
	return (
		turn.checkpoint !== undefined &&
		turn.status !== 'running' &&
		!turn.parts.some((part) => part.kind === 'undone')
	);
}

/** Record the undo on the turn it undid. */
export function markUndone(turn: Turn, note: string): Turn {
	return { ...turn, parts: [...turn.parts, { kind: 'undone', note }] };
}

/** Replace the tool part with this id, or leave the parts untouched. */
function patchTool(
	turn: Turn,
	id: string,
	patch: (part: ToolPart) => ToolPart
): readonly Part[] {
	let found = false;
	const parts = turn.parts.map((part) => {
		if (part.kind !== 'tool' || part.id !== id) {
			return part;
		}
		found = true;
		return patch(part);
	});
	// A result for a call we never saw start would otherwise vanish. That
	// should not happen, and silently dropping it is how you never find out.
	return found ? parts : turn.parts;
}

/** Fold one event into the running turn. Text chunks merge; the rest append. */
export function applyEvent(turn: Turn, event: AgentEvent): Turn {
	switch (event.kind) {
		case 'checkpoint':
			return { ...turn, checkpoint: event.sha };
		case 'complete':
			return { ...turn, status: 'complete' };
		case 'cancelled':
			// A pending approval is deliberately left pending. Cancelling is not
			// an answer, and writing one in would put words in the user's mouth
			// in a transcript they can read back. `approvalLabel` is what makes
			// it read correctly; the stored state stays truthful.
			return { ...turn, status: 'cancelled' };
		case 'text':
		case 'thinking': {
			// Prose and reasoning each merge into their own run of text, so
			// switching between them starts a new block rather than splicing
			// reasoning into a sentence.
			const last = turn.parts.at(-1);
			return {
				...turn,
				parts:
					last?.kind === event.kind
						? [...turn.parts.slice(0, -1), { kind: event.kind, text: last.text + event.text }]
						: [...turn.parts, { kind: event.kind, text: event.text }],
			};
		}
		case 'tool_start':
			/*
			 * The one tool that renders as something other than a tool call.
			 *
			 * Found by using it: the transcript showed the question three times —
			 * the call row with its arguments as JSON, the question card, and then
			 * the call row again with the answer as its output. The card is a
			 * strictly better rendering of all three, so the row is dropped rather
			 * than styled down.
			 *
			 * Dropping only `tool_start` is enough. `tool_update` and `tool_end` go
			 * through `patchTool`, which leaves the parts untouched when it finds no
			 * part with that id.
			 */
			if (event.name === ASK_TOOL) {
				return turn;
			}
			return {
				...turn,
				parts: [
					...turn.parts,
					{ kind: 'tool', id: event.id, name: event.name, input: event.input, state: 'running' },
				],
			};
		case 'tool_update':
			return {
				...turn,
				parts: patchTool(turn, event.id, (part) => ({ ...part, output: event.partial })),
			};
		case 'tool_end':
			return {
				...turn,
				parts: patchTool(turn, event.id, (part) => ({
					...part,
					state: event.isError ? 'failed' : 'done',
					output: event.result,
				})),
			};
		case 'approval':
			return {
				...turn,
				parts: [
					...turn.parts,
					{
						kind: 'approval',
						id: event.id,
						label: event.name,
						// The reason leads, because it is what decides the answer:
						// "deletes untracked files" is the fact, the command is the detail.
						detail: event.reason
							? `${event.reason} — ${JSON.stringify(event.input)}`
							: JSON.stringify(event.input),
						state: 'pending',
					},
				],
			};
		case 'question':
			return {
				...turn,
				parts: [
					...turn.parts,
					{
						kind: 'question',
						id: event.id,
						question: event.question,
						options: event.options,
						multiSelect: event.multiSelect,
						state: 'pending',
					},
				],
			};
		case 'usage':
			// Replaces rather than accumulates: the provider reports totals for
			// the turn, so adding them would double-count on a multi-message turn.
			return {
				...turn,
				usage: {
					inputTokens: event.inputTokens,
					outputTokens: event.outputTokens,
					contextTokens: event.contextTokens,
					contextWindow: event.contextWindow,
					// Spread rather than assigned, so an unpriced turn has no `cost`
					// key at all. `cost: undefined` reads the same to every consumer
					// and differently to `deepEqual`, and the second is what a check
					// is for.
					...(event.cost ? { cost: event.cost } : {}),
				},
			};
		case 'compacted':
			return {
				...turn,
				parts: [
					...turn.parts,
					{ kind: 'compacted', tokensBefore: event.tokensBefore, summary: event.summary },
				],
			};
		case 'queued':
			return { ...turn, queued: { steer: event.steer, followUp: event.followUp } };
		case 'error':
			return {
				...turn,
				parts: [...turn.parts, { kind: 'error', message: event.message, code: event.code }],
			};
	}
}

/**
 * What the turn still owes the user, in one sentence.
 *
 * The answer to "what does a cancel say about the messages it threw away", and
 * it is the same list either way: a stopped turn had its queues cleared by pi,
 * so the last thing the user was shown as pending is exactly what was lost.
 * Saying nothing was the cheap option and the one that loses typed text in
 * silence.
 *
 * The two queues are not told apart here. From the composer they are one thing —
 * text you typed that the agent has not read — and where it was bound for stops
 * mattering the moment it is gone.
 */
export function queuedLabel(turn: Turn): string | undefined {
	const pending = [...(turn.queued?.steer ?? []), ...(turn.queued?.followUp ?? [])];
	if (pending.length === 0) {
		return undefined;
	}
	const list = pending.map((text) => `"${text}"`).join(', ');
	if (turn.status === 'running') {
		return `Waiting to send: ${list}`;
	}
	// A turn that ended without draining its queue threw it away. `complete` is
	// as much a loser of messages as `cancelled` is — pi clears both queues on
	// abort, and a run that ends never drains what is left.
	return `Not sent: ${list}`;
}

/**
 * How an approval reads, given the turn it belongs to.
 *
 * Whether a question is still open is not a property of the question — it is
 * the run being alive. So this is derived rather than stored: a fourth state
 * would have to be kept in step with `Turn.status` forever, and the first time
 * it drifted the transcript would claim something that never happened.
 */
export function approvalLabel(state: ApprovalState, status: Turn['status']): string {
	if (state === 'approved') {
		return 'Approved';
	}
	if (state === 'skipped') {
		return 'Skipped';
	}
	return status === 'running' ? 'Waiting for you' : 'Not answered';
}

/** How a question reads. Derived for the same reason `approvalLabel` is. */
export function questionLabel(part: QuestionPart, status: Turn['status']): string {
	if (part.state === 'answered') {
		return part.answer?.join(', ') ?? 'Answered';
	}
	return status === 'running' ? 'Waiting for you' : 'Not answered';
}

/** How a tool call reads. Derived for the same reason `approvalLabel` is. */
export function toolLabel(part: ToolPart, status: Turn['status']): string {
	if (part.state === 'failed') {
		return 'Failed';
	}
	if (part.state === 'done') {
		return 'Done';
	}
	// A run that ended with a tool still "running" did not finish it.
	return status === 'running' ? 'Running' : 'Did not finish';
}

/**
 * Answer the approval the running turn is waiting on.
 *
 * Scoped by `canAnswer`, which is the same rule the buttons are drawn from, so
 * the two cannot disagree. Answering used to walk every turn and flip anything
 * still pending, so a question abandoned by an earlier Stop would silently
 * acquire an answer the user never gave, several turns later.
 *
 * Only one turn runs at a time — the composer refuses to send while one is in
 * flight — so this needs no run identity beyond `status`. Turns it does not
 * change are returned by identity, and so is the array when nothing changed.
 */
export function resolveApproval(turns: readonly Turn[], approved: boolean): readonly Turn[] {
	const state: ApprovalState = approved ? 'approved' : 'skipped';
	let changed = false;
	const next = turns.map((turn) => {
		if (!turn.parts.some((part) => canAnswer(part, turn))) {
			return turn;
		}
		changed = true;
		return {
			...turn,
			parts: turn.parts.map((part) =>
				// The `kind` test is only here to narrow the union; `canAnswer` is
				// the rule.
				part.kind === 'approval' && canAnswer(part, turn) ? { ...part, state } : part
			),
		};
	});
	return changed ? next : turns;
}

/**
 * Answer the question the running turn is waiting on.
 *
 * The same shape as `resolveApproval`, and scoped by the same `canAnswer`, so
 * the two cannot disagree about when a question stops being askable. Kept as a
 * separate function rather than a parameterised one because the two carry
 * different answers — a boolean and a list of strings — and the merge would be
 * a union that every caller then has to narrow.
 */
export function answerQuestion(
	turns: readonly Turn[],
	answer: readonly string[]
): readonly Turn[] {
	let changed = false;
	const next = turns.map((turn) => {
		if (!turn.parts.some((part) => part.kind === 'question' && canAnswer(part, turn))) {
			return turn;
		}
		changed = true;
		return {
			...turn,
			parts: turn.parts.map((part) =>
				part.kind === 'question' && canAnswer(part, turn)
					? { ...part, state: 'answered' as const, answer }
					: part
			),
		};
	});
	return changed ? next : turns;
}

/** The transcript as plain text, for the accessible-transcript dialog. */
export function asPlainText(turns: readonly Turn[]): string {
	return turns
		.map((turn) => {
			const body = turn.parts.map((part) => {
				switch (part.kind) {
					case 'text':
						return part.text;
					case 'thinking':
						return `\n[thinking] ${part.text.trim()}\n`;
					case 'tool':
						return `\n[tool] ${part.name} ${JSON.stringify(part.input)} — ${toolLabel(
							part,
							turn.status
						).toLowerCase()}${part.output ? `\n${part.output}` : ''}\n`;
					case 'error':
						return `\n[error] ${part.message}\n`;
					case 'compacted':
						return `\n[compacted ${part.tokensBefore} tokens] ${part.summary}\n`;
					// In the plain-text transcript too, because that is where someone
					// reads back what happened — and "these edits are gone" is the
					// most important sentence in the turn once it is true.
					case 'undone':
						return `\n[undone] ${part.note}\n`;
					case 'approval':
						return `\n[approval] ${part.label} — ${part.detail} (${approvalLabel(
							part.state,
							turn.status
						).toLowerCase()})\n`;
					case 'question':
						return `\n[question] ${part.question} (${part.options.join(' / ')}) — ${questionLabel(
							part,
							turn.status
						).toLowerCase()}\n`;
				}
			});
			const spent = turnCost(turn.usage);
			const usage = turn.usage
				? `\n[usage] ${turn.usage.inputTokens} in, ${turn.usage.outputTokens} out, ${turn.usage.contextTokens} context` +
					(spent === undefined ? '' : `, ${formatCost(spent)}`)
				: '';
			const queued = queuedLabel(turn);
			return (
				`You: ${turn.prompt}\n\nAgent: ${body.join('')}\n[${turn.status}]${usage}` +
				(queued ? `\n[queued] ${queued}` : '')
			);
		})
		.join('\n\n———\n\n');
}

/** One line of a transcript that matched a search — ticket 44. */
export interface TranscriptHit {
	readonly turnId: number;
	/** The matching line, trimmed and capped so a result row stays one row. */
	readonly label: string;
	/** Which turn it was in, named by its prompt — the only name a turn has. */
	readonly detail: string;
}

const HIT_CHARS = 90;

/**
 * Find a term in what was *said* — the prompts, the agent's prose, and the
 * summaries that stand in for prose that was compacted away.
 *
 * **Not tool output, and not reasoning.** A search over tool output is a search
 * over the contents of files, which is what the Search artifact already does
 * properly, with line numbers and a replace path; producing a second, worse
 * answer to the same question from the palette would send people to the wrong
 * one. Reasoning is excluded for the reason it is collapsed in the transcript:
 * it is long, and matching it would bury the answer it led to.
 *
 * Case-insensitive substring, not fuzzy. A fuzzy match over prose matches
 * everything — `fuzzyFilter` scores short labels like filenames and command
 * names, and a paragraph is neither.
 */
export function searchTranscript(
	turns: readonly Turn[],
	term: string,
	limit = 20
): readonly TranscriptHit[] {
	const needle = term.trim().toLowerCase();
	if (!needle) {
		return [];
	}
	const hits: TranscriptHit[] = [];
	for (const turn of turns) {
		const sources = [
			turn.prompt,
			...turn.parts.flatMap((part) =>
				part.kind === 'text' ? [part.text] : part.kind === 'compacted' ? [part.summary] : []
			),
		];
		for (const source of sources) {
			for (const line of source.split('\n')) {
				if (hits.length >= limit) {
					return hits;
				}
				const text = line.trim();
				if (text.toLowerCase().includes(needle)) {
					hits.push({
						turnId: turn.id,
						label: text.length > HIT_CHARS ? `${text.slice(0, HIT_CHARS)}…` : text,
						detail: turn.prompt.length > 40 ? `${turn.prompt.slice(0, 40)}…` : turn.prompt,
					});
				}
			}
		}
	}
	return hits;
}
