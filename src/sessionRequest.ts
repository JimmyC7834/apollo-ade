// Which stored conversation the next start-up should open.
//
// **Switching sessions is a reload, and this is the note it leaves itself.**
//
// The alternative was rebinding the live session in place, and it is the same
// trap `switchWorkspace` documents: the harness, the provider and the session
// store are all built once, at render, around one `Session`. Swapping that
// underneath them means rebuilding three things mid-life while a transcript is
// on screen. Reloading rebinds all of it through ordinary start-up — the path
// that already runs on every launch and every root switch, and the only one
// that has ever been proven.
//
// So a switch writes down what it wants and reloads, and `openSession` reads
// this instead of taking the newest file. Crossing into another workspace needs
// nothing extra: the root switch reloads too, so the note is simply still there
// when the new root comes up.

const KEY = 'ade.session-request';

/**
 * Open this conversation on the next start-up.
 *
 * The path is a session file's id, exactly as `listSessions` reported it. It is
 * not validated here — `sessionToOpen` does that against what is actually on
 * disk, which is the only place the answer is knowable.
 */
export function requestSession(path: string): void {
	try {
		localStorage.setItem(KEY, path);
	} catch {
		// Quota or private mode. The switch will land on the newest session
		// instead, which is what it did before this existed.
	}
}

/**
 * The request, consumed.
 *
 * **Read-and-clear, in one call, deliberately.** A request that survived being
 * acted on would reopen the same conversation at every launch afterwards, which
 * looks exactly like a session you cannot leave. Clearing before the open is
 * also what makes a *failed* open self-healing: the fallback runs, and the next
 * launch is ordinary.
 */
export function takeSessionRequest(): string | undefined {
	try {
		const path = localStorage.getItem(KEY);
		localStorage.removeItem(KEY);
		return path ?? undefined;
	} catch {
		return undefined;
	}
}

const UNOPENED = 'ade.session-unopened';

/**
 * The session that was picked and could not be opened.
 *
 * **Written across the same reload the request travels on**, because the failure
 * happens in start-up code with no way to speak to the user: `openSession` runs
 * inside the provider, long before anything can announce. Without it, picking a
 * damaged conversation lands you silently in a different one — which is the same
 * window a successful switch produces, and indistinguishable from it.
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

/** Abandon a request whose switch never happened. */
export function clearSessionRequest(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		// Nothing to do, and nothing worth telling the user.
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
 * **The request is matched against the list rather than trusted.** It comes out
 * of `localStorage`, it names a file by a root-relative path, and the root it
 * was written for may not be the root that came up — a switch can fail after the
 * note is written. An unmatched request therefore contributes nothing rather
 * than being handed to `repo.open`.
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
