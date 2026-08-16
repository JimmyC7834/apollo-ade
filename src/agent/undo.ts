// Undoing a turn: what came back, and what the model has to be told about it.
//
// [Ticket 28](docs/wayfinder/pi-harness/tickets/28-session-undo.md) asked which
// of two honest options to take, and the answer is **rewind the tree and tell
// the model, in its own context, that it happened.**
//
// pi offers both. `Session.moveTo(entryId)` really would rewind the conversation
// as well, and `appendCustomMessageEntry` puts a message into the context
// without pretending anyone said it. The second is chosen because the first
// throws away the reasoning that produced the edits — which is the part the user
// most often wants to keep and rephrase — and because our `Turn` ids are ours,
// not pi entry ids, so mapping one to the other is machinery bought to lose
// something.
//
// The desync the ticket names is real, and this note is the whole answer to it:
// the last thing in the model's context after an undo says the edits are gone.
// Same argument as `stripNote` — the model is told what happened to its output
// rather than left to infer it.

/** What Rust's `git_restore_checkpoint` did. */
export interface UndoOutcome {
	/**
	 * The tree as it was just before the undo, stashed. Absent when there was
	 * nothing to save.
	 *
	 * Surfaced rather than kept private because it is the answer to "what
	 * happened to the work I did by hand between turns" — it is in `git stash
	 * list`, and the UI says so.
	 */
	readonly backup?: string;
	/** Paths put back to their checkpoint contents. */
	readonly restored: readonly string[];
	/** Paths the checkpoint did not have, and that were therefore removed. */
	readonly removed: readonly string[];
	/**
	 * Whether the model was told. **Set by the provider, not by Rust.**
	 *
	 * The restore and the session write are two operations and cannot be made
	 * one: the tree is already back by the time the note is attempted. So the
	 * failure is *reported* rather than hidden — a `false` here is the transcript
	 * saying, in the turn, that the model's context still describes edits that
	 * are gone, which is the only honest end state left once the write has
	 * failed. Throwing instead would leave the transcript recording nothing at
	 * all, which is the state ticket 28 forbids.
	 */
	readonly told: boolean;
}

/** `n things`, with the singular right. */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * What another session is told when somebody else's undo took its work too.
 *
 * The same sentence from the other side — ticket 52's last criterion: a session
 * whose edits were reverted must not be left claiming them. It is put into that
 * session's own context and its own transcript, because a note only the undoing
 * conversation can see leaves the other model confidently wrong.
 */
export function revertedElsewhereNote(by: string | undefined): string {
	// Elided like every other place a conversation is named by its first prompt:
	// this goes into a model's context and a transcript line, and a paragraph
	// there is noise that costs tokens.
	const who = by === undefined ? 'another session' : by.length > 60 ? `${by.slice(0, 57)}…` : by;
	return (
		`A turn was undone in ${who}, which shares this folder. Its ` +
		'checkpoint was taken before some of your edits, so restoring it reverted those ' +
		'edits too. Files you wrote may no longer say what you wrote — re-read anything ' +
		'you are relying on before you act on it.'
	);
}

/**
 * At most three names, then how many more. The note goes into the model's
 * context on every undo, and a hundred paths there is a hundred paths of
 * context spent saying one thing.
 */
function some(paths: readonly string[]): string {
	const head = paths.slice(0, 3).join(', ');
	return paths.length > 3 ? `${head} and ${paths.length - 3} more` : head;
}

/**
 * What the transcript shows and the model is told, in one sentence set.
 *
 * One function for both, because they must not be able to differ: a transcript
 * that says one thing and a context that says another is the exact failure the
 * note exists to prevent, and two format strings is how that happens.
 *
 * @param alsoReverted Other live conversations whose work was in this checkpoint
 * — ticket 52. A checkpoint captures the whole working tree, so one taken before
 * another session's edits contains none of them and restoring it takes them
 * back out. The note has to say so: *"undone"* alone would not be true, and the
 * transcript is the record.
 */
export function undoNote(outcome: UndoOutcome, alsoReverted: readonly string[] = []): string {
	const parts: string[] = [];
	if (outcome.restored.length > 0) {
		parts.push(`${count(outcome.restored.length, 'file')} restored (${some(outcome.restored)})`);
	}
	if (outcome.removed.length > 0) {
		parts.push(`${count(outcome.removed.length, 'file')} removed (${some(outcome.removed)})`);
	}
	const what =
		parts.length > 0
			? `${parts.join(', ')}. Untracked files were not touched.`
			: 'Nothing on disk had changed, so nothing was put back.';
	/*
	 * Named, not counted. The point of saying it at all is that somebody reading
	 * the transcript afterwards can go and look at what else moved, and "another
	 * session" is not something anyone can go and look at.
	 */
	const shared =
		alsoReverted.length > 0
			? ` This checkpoint was taken before work done in ${some(alsoReverted)}, which ` +
				`share${alsoReverted.length === 1 ? 's' : ''} this folder — that work was reverted ` +
				'as well, and this tree is now in a state neither conversation was alone in.'
			: '';
	const body =
		'The user undid this turn. The working tree was restored to the checkpoint taken ' +
		`before it, so edits made during it are gone from disk: ${what}${shared} ` +
		'Re-read any file before relying on what you know about its contents.';
	/*
	 * The failure case says what to do about it, because the person reading it is
	 * the only one who now can: the model cannot be told from here, so telling it
	 * has to happen in the next message the user sends.
	 */
	return outcome.told
		? body
		: `${body} This could not be recorded in the agent's context — it still ` +
				'believes those edits exist. Say so in your next message, or start a new session.';
}
