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
// What remains is two things that have to cross a boundary in *time*. One is a
// failure that happens inside start-up code, long before anything can speak to
// the user. The other is the record of which conversations were open when the
// window closed — [ticket 53](docs/wayfinder/pi-harness/tickets/53-launch-reopens-sessions.md),
// and the second job this module was always going to finish. It is a *set* now
// rather than the one-slot note switching used to leave.

const UNOPENED = 'ade.session-unopened';
const OPEN = 'ade.open-sessions';

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

/**
 * One conversation that was open, as much of it as reopening needs.
 *
 * The root is a **path**, and it is matched against Rust's recent list on the way
 * back up rather than handed to Rust as one — the renderer still never names a
 * folder, it recognises one. A root that has since been deleted, unmounted, or
 * pushed off the end of the recents list simply matches nothing, which is how
 * "dropped with a message, and the rest still open" happens.
 */
export interface OpenSession {
	/** The root it lived in. */
	readonly root: string;
	/** Its file, root-relative, as `listSessions` reports it. */
	readonly path: string;
	readonly focused?: boolean;
}

/**
 * Remember the set of open conversations, for the next launch.
 *
 * Written on every change rather than at shutdown: a desktop app is closed by
 * the window manager, by a crash, and by the user, and only one of those is a
 * moment anything could run in.
 */
export function recordOpenSessions(sessions: readonly OpenSession[]): void {
	try {
		localStorage.setItem(OPEN, JSON.stringify(sessions));
	} catch {
		// Then the next launch opens one session, which is what it did before.
	}
}

/**
 * What was open last time. **Not consumed**: unlike a request, this is state
 * rather than an instruction, and clearing it would mean a launch that crashed
 * on the way up came back to nothing.
 *
 * Anything malformed is no record at all. A half-parsed list would reopen a
 * subset chosen by whichever field happened to survive.
 */
export function takeOpenSessions(): readonly OpenSession[] {
	try {
		const raw = localStorage.getItem(OPEN);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed)
			? parsed.filter(
					(entry): entry is OpenSession =>
						typeof entry?.root === 'string' && typeof entry?.path === 'string'
				)
			: [];
	} catch {
		return [];
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
