// A stored conversation, replayed as the events that produced it.
//
// **The transcript is rebuilt through the same reducer that built it live.**
// `applyEvent` is where every rule about tool state, approvals and errors lives,
// and it is the part with a check suite behind it. A second mapping from session
// entries straight to `Turn`s would be a second implementation of those rules,
// drifting from the first the moment either changed — so this maps entries to
// `AgentEvent`s instead and lets the existing reducer do the work.
//
// That is also why a turn read back is indistinguishable from one just had: it
// is the same data structure, built the same way, from a recording of the
// events rather than from the events themselves.

import { contentText } from '@earendil-works/pi-ai';
import type { SessionTreeEntry } from '@earendil-works/pi-agent-core';
import type { AgentEvent } from './index';

/**
 * One turn of a conversation, as it was recorded.
 *
 * The prompt is separate because it is the one thing a turn has that no event
 * carries: `AgentChat` opens a turn *with* a prompt and only then feeds it
 * events, and history has to arrive the same shape.
 */
export interface HistoryTurn {
	readonly prompt: string;
	/** The turn's own id, from when it happened. Unique, and in order. */
	readonly id: number;
	readonly events: readonly AgentEvent[];
}

/**
 * A session's entries, as turns.
 *
 * **A user message opens a turn and everything up to the next one belongs to
 * it.** That is the only structure a JSONL session has — pi records messages,
 * not turns — and it is enough, because a turn is exactly "what happened after
 * you said something".
 *
 * Entries before the first prompt are dropped rather than collected into an
 * opening turn: a session begins with model, tool and thinking-level entries,
 * and none of them is anything the user said or read.
 *
 * **What is deliberately not restored**, all for one reason — a turn read back
 * off disk is a record, not a live thing:
 *
 * - *approvals and questions*, which are replaced by the tool call they gated.
 *   A pending approval restored from history would be a button that answers a
 *   run which ended days ago.
 * - *checkpoints*, so nothing offers to undo a turn into a working tree that has
 *   moved on since — and `git_checkpoint` shas from another root would not even
 *   resolve.
 * - *usage*, which would make the session cost line count history twice on any
 *   window that also takes a turn.
 *
 * **A turn in which the agent asked a *question* comes back as a gap**, and this
 * is a known loss rather than a decision. `applyEvent` drops the ask tool's call
 * row on purpose — the question card is a better rendering of it — so replaying
 * the call alone renders nothing, and the answer the user gave is in the tool
 * *result*, which has nowhere to go: the reducer has an event for asking and
 * none for having answered. Restoring it as a pending question would be worse
 * than the gap, because `questionLabel` would then read "Not answered" over a
 * question that was. Recorded in `docs/OPEN-ISSUES.md`.
 */
export function replayEntries(entries: readonly SessionTreeEntry[]): readonly HistoryTurn[] {
	const turns: { prompt: string; id: number; events: AgentEvent[] }[] = [];
	/** Tool calls in this session with no result recorded after them. */
	const unfinished = new Set<string>();
	const current = () => turns[turns.length - 1];
	/*
	 * A timestamp is not unique: a steered message and the prompt after it can
	 * land in the same millisecond, and this id is both the React key and the
	 * identity `applyEvent` matches a turn on. Colliding ids would merge two
	 * conversations' turns into one row.
	 */
	const nextId = (wanted: number) => {
		const last = turns[turns.length - 1]?.id;
		return last !== undefined && wanted <= last ? last + 1 : wanted;
	};

	for (const entry of entries) {
		if (entry.type === 'compaction') {
			/*
			 * **A compaction is usually the *first* entry, not one in the middle.**
			 * `getBranch` walks back to the root *or to a compaction*, so a session
			 * that has been summarised hands back `[compaction, ...what followed]`.
			 * The first build pushed onto `current()`, which is undefined there, and
			 * threw the marker away — so a compacted conversation reopened as a
			 * transcript starting abruptly mid-thread with nothing to say that
			 * anything came before it. It opens a turn of its own instead.
			 */
			if (!current()) {
				turns.push({
					prompt: 'Earlier in this conversation',
					id: Date.parse(entry.timestamp) || 0,
					events: [],
				});
			}
			current()?.events.push({
				kind: 'compacted',
				tokensBefore: entry.tokensBefore,
				summary: entry.summary,
			});
			continue;
		}
		if (entry.type !== 'message') {
			continue;
		}
		const message = entry.message;
		if (!('role' in message)) {
			continue;
		}

		if (message.role === 'user') {
			/*
			 * Ordering, not identity: two messages can share a millisecond, and
			 * `applyEvent` finds a turn by this id. The timestamp keeps restored
			 * ids below `Date.now()`, which is what a live turn uses — so a turn
			 * taken after a restore still sorts last.
			 */
			turns.push({
				prompt: contentText(message.content),
				id: nextId(Date.parse(entry.timestamp) || turns.length),
				events: [],
			});
			continue;
		}

		const turn = current();
		if (!turn) {
			// An assistant message with nothing said before it. Not reachable in a
			// session pi wrote, and dropping it beats inventing a prompt for it.
			continue;
		}

		if (message.role === 'assistant') {
			for (const part of message.content) {
				if (part.type === 'text') {
					turn.events.push({ kind: 'text', text: part.text });
				} else if (part.type === 'thinking') {
					turn.events.push({ kind: 'thinking', text: part.thinking });
				} else if (part.type === 'toolCall') {
					turn.events.push({
						kind: 'tool_start',
						id: part.id,
						name: part.name,
						input: part.arguments,
					});
					unfinished.add(part.id);
				}
			}
			/*
			 * An error is a part of the turn rather than a status on it, exactly as
			 * it is live — the transcript shows what the model said *and* then that
			 * it failed, which is the pair a reader needs.
			 */
			if (message.errorMessage) {
				turn.events.push({ kind: 'error', message: message.errorMessage });
			}
			continue;
		}

		if (message.role === 'toolResult') {
			unfinished.delete(message.toolCallId);
			turn.events.push({
				kind: 'tool_end',
				id: message.toolCallId,
				result: contentText(message.content),
				isError: message.isError,
			});
		}
	}

	/*
	 * Every restored turn is finished, whatever it was doing when it was written.
	 *
	 * **`complete` alone is not enough, which is worth stating because it looks
	 * like it should be.** It settles the turn's status and leaves its parts
	 * exactly as they are, so a session killed while a tool was running comes back
	 * with that call still `running` — a spinner, for a run that ended days ago.
	 * The unanswered calls are therefore closed here, and closed as errors with
	 * the only true thing anyone can say about them: the record stops.
	 */
	const stopped = {
		kind: 'tool_end',
		result: 'No result was recorded — the session ended before this finished.',
		isError: true,
	} as const;
	return turns.map((turn) => ({
		...turn,
		events: [
			...turn.events,
			...[...unfinished]
				.filter((id) => turn.events.some((e) => e.kind === 'tool_start' && e.id === id))
				.map((id) => ({ ...stopped, id })),
			{ kind: 'complete' } as const,
		],
	}));
}
