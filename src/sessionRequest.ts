// Which conversation was asked for, and which one could not be opened.
//
// **The `localStorage` half of this is gone, and that is ticket 47.** Switching
// sessions used to be a page reload — the only way to rebind a harness, a
// provider and a session store that were all module-level — so a switch wrote
// down what it wanted and read the note back on the way up. Focus replaced it:
// opening a conversation now passes the path straight to the session that is
// being created, in memory, and nothing survives a reload because nothing
// reloads.
//
// What remains is the part that still has to cross a boundary in *time*: a
// failure that happens inside start-up code, long before anything can speak to
// the user. [Ticket 53](docs/wayfinder/pi-harness/tickets/53-launch-reopens-sessions.md)
// is where a persisted *set* of open sessions comes back, and it will want a
// record of its own rather than the one-slot note this used to hold.

const UNOPENED = 'ade.session-unopened';

/**
 * The session that was picked and could not be opened.
 *
 * **Written where the failure happens, read where someone can be told.**
 * `openSession` runs inside the provider, before there is any way to speak to
 * the user. Without it, picking a damaged conversation lands you silently in a
 * different one — which is the same window a successful open produces, and
 * indistinguishable from it.
 *
 * A session is damaged when its parent chain has a hole in it; this repo has
 * such files, written by a development double-mount. See `openSession`.
 */
export function recordUnopened(path: string): void {
	try {
		localStorage.setItem(UNOPENED, path);
	} catch {
		// Then it goes unsaid, which is what happened before this existed.
	}
}

/** The failure, consumed — it belongs to the launch that caused it and no other. */
export function takeUnopened(): string | undefined {
	try {
		const path = localStorage.getItem(UNOPENED);
		localStorage.removeItem(UNOPENED);
		return path ?? undefined;
	} catch {
		return undefined;
	}
}

/** As much of a session's metadata as choosing between them needs. */
export interface Openable {
	readonly path: string;
	readonly metadata?: { readonly delegatedFrom?: unknown };
}

/**
 * Which of a workspace's session files to try, best first.
 *
 * **A list rather than a choice, because opening can fail.** `getBranch()` walks
 * the parent chain and throws on a file with a hole in it — and this repo has
 * such files, written by a development double-mount long before switching
 * existed. The first version of this returned one candidate, so asking for a
 * damaged session did not fall back to the conversation you had: it started a
 * blank one. Found by switching to exactly such a file.
 *
 * **The request is matched against the list rather than trusted.** It names a
 * file by a root-relative path, and the root it was written for may not be the
 * root being read — a stale row in the navigator names a file that has since been
 * deleted, and ticket 53 will replay requests recorded in an earlier launch. An
 * unmatched request therefore contributes nothing rather than being handed to
 * `repo.open`.
 *
 * Subagents' sessions are excluded, for the reason `listStored` excludes them: a
 * child's file is written after its parent's, so once delegation exists the
 * newest file is usually somebody's sub-task rather than the conversation the
 * user was having. A *request* is not filtered that way — nothing the navigator
 * lists is a child, and the answer to "open this one" should be that file.
 */
export function sessionCandidates<T extends Openable>(
	existing: readonly T[],
	requested: string | undefined
): readonly T[] {
	const asked = requested === undefined ? [] : existing.filter((e) => e.path === requested);
	return [...asked, ...existing.filter((e) => !e.metadata?.delegatedFrom && !asked.includes(e))];
}
