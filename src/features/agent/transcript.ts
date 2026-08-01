// Pure transcript reduction for `AgentChat`. It lives in its own module, free
// of JSX, so `npm run check` can run it under Node's type stripping — the same
// arrangement as `treeRows.ts`. What is here is every rule about who owns a
// question and when it stops being askable, which is exactly the part that was
// wrong when it lived inside the component.

import type { AgentEvent } from '../../agent';

export type ApprovalState = 'pending' | 'approved' | 'skipped';

export type Part =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'activity'; readonly label: string; readonly detail?: string }
	| {
			readonly kind: 'approval';
			readonly label: string;
			readonly detail: string;
			readonly state: ApprovalState;
	  };

export interface Turn {
	readonly id: number;
	readonly prompt: string;
	readonly parts: readonly Part[];
	readonly status: 'running' | 'complete' | 'cancelled';
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
	return part.kind === 'approval' && part.state === 'pending' && turn.status === 'running';
}

/** Fold one event into the running turn. Text chunks merge; the rest append. */
export function applyEvent(turn: Turn, event: AgentEvent): Turn {
	if (event.kind === 'complete' || event.kind === 'cancelled') {
		// A pending approval is deliberately left pending. Cancelling is not an
		// answer, and writing one in would put words in the user's mouth in a
		// transcript they can read back. `approvalLabel` is what makes it read
		// correctly; the stored state stays truthful.
		return { ...turn, status: event.kind === 'complete' ? 'complete' : 'cancelled' };
	}
	if (event.kind === 'text') {
		const last = turn.parts.at(-1);
		return {
			...turn,
			parts:
				last?.kind === 'text'
					? [...turn.parts.slice(0, -1), { kind: 'text', text: last.text + event.text }]
					: [...turn.parts, { kind: 'text', text: event.text }],
		};
	}
	if (event.kind === 'activity') {
		return { ...turn, parts: [...turn.parts, event] };
	}
	return { ...turn, parts: [...turn.parts, { ...event, state: 'pending' }] };
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

/** The transcript as plain text, for the accessible-transcript dialog. */
export function asPlainText(turns: readonly Turn[]): string {
	return turns
		.map((turn) => {
			const body = turn.parts.map((part) =>
				part.kind === 'text'
					? part.text
					: part.kind === 'activity'
						? `\n[tool] ${part.label}${part.detail ? ` — ${part.detail}` : ''}\n`
						: `\n[approval] ${part.label} — ${part.detail} (${approvalLabel(
								part.state,
								turn.status
							).toLowerCase()})\n`
			);
			return `You: ${turn.prompt}\n\nAgent: ${body.join('')}\n[${turn.status}]`;
		})
		.join('\n\n———\n\n');
}
