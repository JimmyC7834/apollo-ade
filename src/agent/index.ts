// The agent seam. The chat UI talks to `AgentProvider` and never to a model, a
// network client, or a native command.
//
// The thirteen kinds below are the contract settled in
// docs/wayfinder/pi-harness/tickets/05-event-contract.md and falsified against
// three live providers by the spike that preceded this slice. Providers adapt
// *down* to them; the contract does not widen to match whatever pi emits. That
// is what keeps a vocabulary which breaks in minor releases every couple of
// days from reaching the UI.

import type { HistoryTurn } from './history';
import type { StoredSession } from './sessionStore';
import type { UndoOutcome } from './undo';

export type AgentEvent =
	/** One chunk of streamed prose. Chunks concatenate; they are not lines. */
	| { readonly kind: 'text'; readonly text: string }
	/**
	 * Reasoning, kept separate from prose. Folding it into `text` is a one-way
	 * door — the UI can collapse or hide it only if it arrives distinguishable.
	 */
	| { readonly kind: 'thinking'; readonly text: string }
	| {
			readonly kind: 'tool_start';
			readonly id: string;
			readonly name: string;
			readonly input: unknown;
	  }
	/**
	 * The arguments changed after `tool_start` reported them.
	 *
	 * pi emits `tool_execution_start` with the *model's* arguments and only then
	 * validates them and runs the `tool_call` hook, so a rewrite there — rtk's, in
	 * practice — can never reach the row that already went out. This corrects it.
	 * Correlated by `id`, and silently dropped when no such row exists.
	 */
	| { readonly kind: 'tool_input'; readonly id: string; readonly input: unknown }
	/** Progress for an in-flight tool. Correlated to `tool_start` by `id`. */
	| { readonly kind: 'tool_update'; readonly id: string; readonly partial: string }
	| {
			readonly kind: 'tool_end';
			readonly id: string;
			readonly result: string;
			readonly isError: boolean;
	  }
	/**
	 * The run is paused until `resolveApproval` is called. `id` is the tool call
	 * it belongs to, so an approval and its later `tool_end` are correlatable.
	 */
	| {
			readonly kind: 'approval';
			readonly id: string;
			readonly name: string;
			readonly input: unknown;
			/** Why this is being asked, when the reason is not simply the policy. */
			readonly reason?: string;
	  }
	/**
	 * The run is paused until `answerQuestion` is called. A sibling of `approval`
	 * rather than a widening of it: an approval is a yes/no about something the
	 * agent is *about to do*, and this is a choice the agent cannot make at all.
	 * Merging them would give every approval an option list it has no use for.
	 *
	 * The free-text box the UI always renders is not in `options`, because it is
	 * not the model's to withhold — see `ask.ts`.
	 */
	| {
			readonly kind: 'question';
			readonly id: string;
			readonly question: string;
			readonly options: readonly string[];
			readonly multiSelect: boolean;
	  }
	/**
	 * Real provider numbers, not estimates. Surfaced because compaction anchors
	 * on them, so a context meter is free here and expensive to retrofit.
	 */
	| {
			readonly kind: 'usage';
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly contextTokens: number;
			/**
			 * What `contextTokens` is a share of. Absent when nobody has said what
			 * the model's window is, which is a supported state rather than a gap
			 * to fill with a plausible number.
			 */
			readonly contextWindow?: number;
			/**
			 * What the turn cost, in dollars, or absent when the rates are unknown.
			 *
			 * **All four, not a total.** pi computes the breakdown and it is the
			 * interesting part: a long conversation is mostly cache reads, which
			 * cost a tenth of what fresh input does, so a single figure hides the
			 * one number a person would act on. Summing is cheap and cannot be
			 * undone at the event boundary.
			 *
			 * Absent rather than zero when the model has no known rates. pi's
			 * `calculateCost` multiplies whatever rates it is given, so an unpriced
			 * model reports `$0.00` — indistinguishable from a turn that really
			 * was free.
			 */
			readonly cost?: {
				readonly input: number;
				readonly output: number;
				readonly cacheRead: number;
				readonly cacheWrite: number;
			};
	  }
	/** History was summarised. Without this the transcript silently loses detail. */
	| { readonly kind: 'compacted'; readonly tokensBefore: number; readonly summary: string }
	/**
	 * What you typed while the turn was running and has not been sent yet.
	 *
	 * The thirteenth kind, added by
	 * [ticket 22](docs/wayfinder/pi-harness/tickets/22-steering.md). The queue is
	 * pi's, and `queue_update` is a pi event — rendering that event directly would
	 * put pi's vocabulary inside a feature module, which is the one thing this
	 * contract exists to prevent.
	 *
	 * **The state, not the change.** pi sends all of its queues on every update,
	 * so a "one message was queued" event would make the UI rebuild a list it is
	 * already handed whole. Each array replaces the last.
	 *
	 * pi's third queue, `nextTurn`, is not here: it is what Enter already does
	 * when the harness is idle, so nothing can ever put a message in it and a
	 * field that is always empty is a field that will be misread.
	 */
	| {
			readonly kind: 'queued';
			/** Bound for the running turn. */
			readonly steer: readonly string[];
			/** Bound for a turn of its own, after this one. */
			readonly followUp: readonly string[];
	  }
	/**
	 * The tree was snapshotted before this turn, and this is the snapshot.
	 *
	 * The fourteenth kind, added by
	 * [ticket 28](docs/wayfinder/pi-harness/tickets/28-session-undo.md). The
	 * checkpoint has been taken on every turn since the walking skeleton and
	 * nothing could ever spend it, because the sha never left the provider.
	 *
	 * An event rather than a field on `AgentRun`: the transcript is built from
	 * events, and undo belongs to the *turn* — which outlives its run by exactly
	 * as long as anyone might want to undo it. Absent for a turn that changed
	 * nothing, in a repository-less workspace, or in browser mode, and a turn
	 * with no checkpoint simply cannot be undone.
	 */
	| { readonly kind: 'checkpoint'; readonly sha: string }
	/** A failure worth styling and acting on, rather than prose that reads like one. */
	| { readonly kind: 'error'; readonly message: string; readonly code?: string }
	| { readonly kind: 'complete' }
	| { readonly kind: 'cancelled' };

export interface AgentRun {
	cancel(): void;
	/**
	 * Put text into the running turn, or after it.
	 *
	 * Both are pi's, and both throw `invalid_state` on an idle harness — so they
	 * live on the run rather than on the provider, which is what makes them
	 * unreachable once the run is over. `follow` is what Enter does; `steer` is
	 * `/steer <text>`, because a steer that was meant as a follow-up changes a
	 * turn that was already correct, and that error cannot be undone.
	 */
	steer(text: string): void;
	follow(text: string): void;
	resolveApproval(approved: boolean): void;
	/** Answer the outstanding `question`. One or more of the offered choices,
	 * and/or whatever the user typed in the free-text box. */
	answerQuestion(chosen: readonly string[]): void;
}

export interface AgentProvider {
	start(prompt: string, onEvent: (event: AgentEvent) => void): AgentRun;
	/**
	 * Run a skill the user named, as its own turn.
	 *
	 * A sibling of `start` rather than a special prompt, because that is what it
	 * is underneath: pi's `AgentHarness.skill()` looks the name up in the
	 * harness's resources and formats the body itself, so the caller passes a
	 * name and never sees the instructions. `extra` is appended after them.
	 *
	 * Returns an `AgentRun` — unlike `compact`, this one really is a turn and
	 * really can be stopped.
	 */
	skill(name: string, extra: string | undefined, onEvent: (event: AgentEvent) => void): AgentRun;
	/**
	 * Run one of the user's own commands — a `.md` file in `.agents/commands`.
	 *
	 * The same shape as `skill` and for the same reason: pi's
	 * `promptFromTemplate` finds the template in the harness's resources and
	 * formats the turn itself, so the caller passes a name and the words that
	 * follow it. `args` is already split — pi's `parseCommandArgs` honours shell
	 * quoting, and the placeholders in the file are filled from that list.
	 */
	template(name: string, args: readonly string[], onEvent: (event: AgentEvent) => void): AgentRun;
	/**
	 * Summarise history now, on the user's instruction.
	 *
	 * Returns nothing rather than an `AgentRun`, because there is nothing to
	 * return: **pi's compaction takes no abort signal**, so it cannot be
	 * cancelled and offering a handle that could only lie would be worse than
	 * offering none. It ends with `complete` like a turn does.
	 */
	compact(onEvent: (event: AgentEvent) => void): void;
	/**
	 * Put the tree back to a turn's checkpoint, and tell the model it happened.
	 *
	 * Rejects rather than resolving on failure — a caller that showed "undone"
	 * for a restore that did not run would be worse than no undo at all. The
	 * *conversation* is not rewound; see `undo.ts` for why, and for the note this
	 * appends to the session so the model's context stays true.
	 */
	undo(checkpoint: string): Promise<UndoOutcome>;
	/**
	 * The workspace's stored conversations, newest first, for the navigator.
	 *
	 * On the provider because the session store is: sessions live inside the
	 * workspace root and are reached through the agent's own `ExecutionEnv`, so
	 * nothing above this layer can read them and nothing needs to.
	 *
	 * Never rejects. A workspace with no sessions and a workspace whose sessions
	 * could not be read are the same answer here — an empty list — because the
	 * navigator is a convenience and must not be able to break the window.
	 */
	listSessions(): Promise<readonly StoredSession[]>;
	/**
	 * The open session's own conversation, as turns, for the transcript to start
	 * from.
	 *
	 * **Without this, opening a session is invisible.** The harness resumes the
	 * file either way — it has since sessions persisted — but the transcript is
	 * built from events in this window, so a resumed conversation used to come up
	 * blank with a model that remembered all of it. Switching sessions is what
	 * made that impossible to ignore.
	 *
	 * Never rejects, for `listSessions`' reason: a corrupt or half-written file
	 * costs you the history, not the window.
	 */
	history(): Promise<readonly HistoryTurn[]>;
	/**
	 * The file this session is appending to, for the navigator to recognise.
	 *
	 * A window holds several conversations now, and a stored row that is *already
	 * open* must not be offered as something to open — it would make two harnesses
	 * append to one file. Undefined where there is no disk, and never rejects.
	 */
	path(): Promise<string | undefined>;
	/**
	 * Give up the root this session claimed. Called when the session is closed.
	 *
	 * Not a cancel: a run is stopped through its `AgentRun`, and this is the
	 * *root* being handed back — after it, every command carrying this session's
	 * id is refused by Rust rather than resolved against whatever is focused.
	 */
	dispose(): void;
}

export { createAgentProvider } from './provider';
export { listSessionsIn, type SessionWant, type StoredSession } from './sessionStore';
export { replayEntries, type HistoryTurn } from './history';
export { undoNote, type UndoOutcome } from './undo';
export { loadProfileFiles, type ProfileLoad } from './profileFiles';
