// Where conversations live, and which one the window comes up in.
//
// Lifted out of `provider.ts` whole by the session-switching slice. The move was
// not tidying: switching sessions has to *list* two workspaces and *open* a
// named one, and both were private to a file the review had already flagged for
// collecting unrelated reasons to change. Everything below is what a session
// store is; nothing below knows what a model or a harness is.

import {
	InMemorySessionStorage,
	JsonlSessionRepo,
	Session,
	type ExecutionEnv,
	type JsonlSessionMetadata,
} from '@earendil-works/pi-agent-core';
import { contentText } from '@earendil-works/pi-ai';
import { createReadOnlyTauriEnv } from './env';
import { recordUnopened, sessionCandidates } from '../sessionRequest';

/**
 * Where the transcript lives.
 *
 * Inside the workspace, as [ticket 09](docs/wayfinder/pi-harness/tickets/09-session-store.md)
 * settled — which means no containment exemption is needed, because the agent's
 * own root already covers it.
 */
const SESSIONS_ROOT = '/.ade/sessions';

/**
 * The window's own conversation, and somewhere to put a subagent's.
 *
 * Both come from one place because they share a directory: ticket 24 chose one
 * `/.ade/sessions` over a second root once pi's own parentage fields were found,
 * and that only works if whatever opens the window's session is also what knows
 * which files are children.
 */
export interface SessionStore {
	readonly own: Promise<Session>;
	/**
	 * The file `own` is appending to, once it is known.
	 *
	 * Needed by the navigator, which has to tell a stored row apart from the
	 * *same* conversation already open in a tab — with several sessions live at
	 * once, "active" stopped being a property one store could answer alone.
	 * Undefined where there is no disk, and never rejects.
	 */
	readonly path: Promise<string | undefined>;
	/** A session of a subagent's own, recorded as belonging to `own`. */
	child(): Promise<Session>;
	/** Every stored conversation in this workspace, newest first. */
	list(): Promise<readonly StoredSession[]>;
}

/**
 * One stored conversation, at the width the navigator draws it.
 *
 * Metadata and a name, never entries: this is what a *list* needs, and reading
 * a transcript to show a row is how a session list becomes slower than the
 * conversation it lists.
 */
export interface StoredSession {
	/** The file's path under the sessions root. Stable, and unique per session. */
	readonly id: string;
	readonly name: string;
	readonly startedAt: string;
}

/**
 * Which conversation a store opens with.
 *
 * **The choice is the caller's now, and that is ticket 45.** It used to be made
 * here, from a module-level cache that guaranteed one session per window — which
 * is precisely the thing a window holding several of them cannot have. The
 * double-creation that cache existed to prevent has not gone away; it has moved
 * to where creating a session is an *action* rather than a render, and one
 * action cannot happen twice. See `sessionSet.ts`.
 */
export type SessionWant =
	/** A conversation of its own, whatever is already on disk. */
	| { readonly fresh: true }
	/** Resume: this stored session if it can be opened, else the newest. */
	| { readonly fresh?: false; readonly requested?: string };

export function diskSessions(env: ExecutionEnv, want: SessionWant = {}): SessionStore {
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: SESSIONS_ROOT });
	const own = openSession(env, repo, want);
	return {
		own,
		path: own.then(
			async (session) => (await session.getMetadata()).path,
			() => undefined
		),
		list: () => listStored(repo),
		/*
		 * **Both fields, and they are not the same claim.** `parentSessionPath`
		 * because it is true and because the deferred child chat view needs the
		 * link. `metadata.delegatedFrom` because that is what start-up filters on
		 * — filtering on `parentSessionPath` alone would also hide a *forked*
		 * session, and a fork is a session the user should still see on the day
		 * forking gets a UI.
		 */
		child: async () => {
			const parent = await (await own).getMetadata();
			return repo.create({
				cwd: '/',
				parentSessionPath: parent.path,
				metadata: { delegatedFrom: parent.path },
			});
		},
	};
}

/**
 * How many stored sessions the navigator is told about.
 *
 * A cap rather than a page, because the work per row is a file read: naming a
 * session means opening it and finding its first user message, and an unbounded
 * list would make opening a long-lived workspace cost one parse per conversation
 * ever had in it. Twenty is the recent ones, which is what a switcher is for.
 */
const MAX_LISTED = 20;

/**
 * The same, for a workspace you are not in.
 *
 * Much smaller, because the cost multiplies by the number of recent roots and
 * lands at start-up: eight roots at twenty rows is a hundred and sixty file
 * reads on the dispatcher before anyone has asked for anything. Five is enough
 * to recognise the conversation you left, which is what a cross-workspace
 * switcher is actually for — and switching there shows all twenty.
 */
const MAX_LISTED_ELSEWHERE = 5;

/**
 * How many session files may be read to fill a capped list — ticket 58.
 *
 * The cap counts *rows*, and abandoned sessions are dropped after they are
 * named, so applying it first would let a run of them push real conversations
 * off the end: twenty abandoned sessions in a row would leave an empty list in
 * a workspace full of conversations. Applying no cap at all is the unbounded
 * read the cap exists to prevent.
 *
 * So the cap is on rows and this is the ceiling on reads. Three to one is an
 * allowance, not a measurement — an abandoned session is rarer than a real one,
 * and a workspace where it is not has little to list either way.
 */
const SCAN_RATIO = 3;

/**
 * How far into a session to look for the message that names it.
 *
 * The first user message is near the front but not at it — a session opens with
 * tool, model and thinking-level entries, and the sample in this repo had ten
 * before the first prompt. Sixty is generous for that and still bounded, so a
 * session that somehow contains no user message costs sixty entries rather than
 * its whole transcript.
 */
const NAME_WINDOW = 60;

/**
 * What to call a stored session.
 *
 * A name the user set wins. Failing that it is the first thing they said, which
 * is the only part of a conversation that is naturally its title — the same rule
 * the live session's own name follows.
 *
 * Every failure below lands on the same answer rather than propagating: a
 * corrupt file must cost you that row's *name*, not the navigator.
 */
async function nameStored(
	repo: JsonlSessionRepo,
	metadata: JsonlSessionMetadata
): Promise<{ name: string; empty: boolean }> {
	const untitled = { name: 'Untitled session', empty: true };
	try {
		const session = await repo.open(metadata);
		const named = await session.getSessionName();
		const entries = await session.getEntries({ limit: NAME_WINDOW });
		/*
		 * `content` is checked, not assumed. `AgentMessage` is a union and one of
		 * its members — pi's bash-execution message — carries no content at all,
		 * so a session whose first user entry is one of those has no title in it
		 * and says so rather than failing to compile around it.
		 */
		const first = entries.find(
			(entry) => entry.type === 'message' && entry.message.role === 'user' && 'content' in entry.message
		);
		if (named) {
			return { name: named, empty: first === undefined };
		}
		if (first === undefined || first.type !== 'message' || !('content' in first.message)) {
			return untitled;
		}
		return { name: summarise(contentText(first.message.content)), empty: false };
	} catch {
		return untitled;
	}
}

/** A prompt, at row width: one line, and short enough not to widen anything. */
function summarise(text: string): string {
	const line = text.trim().split('\n')[0]?.trim() ?? '';
	if (line === '') {
		return 'Untitled session';
	}
	return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * A workspace's stored conversations, newest first.
 *
 * **Which of them are open is not answered here.** It cannot be: a window holds
 * several sessions now, each with its own store, so "is this the one being
 * appended to" is a question only the collection can answer. The navigator
 * filters by the paths its open sessions report — see `SessionStore.path`.
 *
 * **Children are excluded, for the reason `openSession` excludes them.** A
 * subagent's session is a sub-task's record, not a conversation the user had,
 * and listing them would bury the four turns someone remembers under forty they
 * never saw.
 */
async function listStored(
	repo: JsonlSessionRepo,
	limit = MAX_LISTED
): Promise<readonly StoredSession[]> {
	const stored = (await repo.list({ cwd: '/' }))
		.filter((entry) => !entry.metadata?.delegatedFrom)
		.slice(0, limit * SCAN_RATIO);

	const named = await Promise.all(
		stored.map(async (metadata) => {
			const { name, empty } = await nameStored(repo, metadata);
			return { id: metadata.path, name, startedAt: metadata.createdAt, empty };
		})
	);
	/*
	 * **Started and abandoned is not a conversation** — ticket 58. A session
	 * file is written the moment one is opened, so every glance at a workspace
	 * left an `Untitled session` behind, and they accumulated faster than anyone
	 * would remove them. They were also the one row that could not be removed
	 * while it was the one you were in.
	 *
	 * Filtered on the way out rather than deleted: the file is small and the
	 * store's write path is pi's, so not-listing is the whole of what "not
	 * saved" has to mean here. The cost is that the files stay on disk, unread
	 * by anything. If that ever matters, deleting an empty session's file when
	 * it closes is the change.
	 */
	return named
		.filter((entry) => !entry.empty)
		.slice(0, limit)
		.map(({ id, name, startedAt }) => ({ id, name, startedAt }));
}

/**
 * Another recent workspace's stored conversations.
 *
 * **This is the whole reason the navigator can offer a session in a root you are
 * not in**, and it reads that root through the read-only, index-named side of
 * `workspace.rs` — see `read_root` there for why an index grants no authority
 * the renderer does not already have.
 *
 * Never rejects, for `listSessions`' reason: a root that has been deleted,
 * unmounted or never had a session in it is an empty list, not a broken
 * navigator.
 */
export async function listSessionsIn(index: number): Promise<readonly StoredSession[]> {
	try {
		const repo = new JsonlSessionRepo({
			fs: createReadOnlyTauriEnv(index),
			sessionsRoot: SESSIONS_ROOT,
		});
		return await listStored(repo, MAX_LISTED_ELSEWHERE);
	} catch {
		return [];
	}
}

/**
 * The session to open: the one that was asked for, or the newest.
 *
 * **Asking is how switching works** — see `sessionRequest.ts`. The request is a
 * note left by the previous window before it reloaded, and it is matched against
 * what is on disk rather than trusted, so a note meant for a root that never
 * came up costs nothing.
 *
 * **Every candidate is tried, not just the best one.** A session whose parent
 * chain has a hole in it cannot be replayed, and this repo has such files. The
 * first build of this opened one candidate and started a *blank* session when it
 * failed — so asking for a damaged conversation silently lost the healthy one
 * you already had. Found by switching to exactly such a file.
 *
 * **Newest that is not a subagent's**, when there is no request. A child's file
 * is written after its parent's by definition, so once delegation exists "the
 * newest file" is usually a child — and the next launch would resume somebody's
 * sub-task instead of the conversation the user was having.
 *
 * Failing to open a stored session must not cost you the agent. A corrupt or
 * half-written JSONL file falls back to a fresh session — losing history is
 * bad, but refusing to run at all is worse, and the broken file is left on disk
 * rather than deleted.
 */
async function openSession(
	env: ExecutionEnv,
	repo: JsonlSessionRepo,
	want: SessionWant
): Promise<Session<JsonlSessionMetadata>> {
	/*
	 * A self-ignoring directory, so the transcript never reaches the user's
	 * commits and their `.gitignore` is never edited by us. `git` reads a
	 * `.gitignore` at any level, and `*` there covers everything beneath it.
	 */
	await env.createDir('/.ade');
	await env.writeFile('/.ade/.gitignore', '*\n');

	/*
	 * A new session skips all of it. Nothing on disk is a candidate for a
	 * conversation that is meant to be empty, and *"resume unless asked"* was
	 * only ever right when a window held one session.
	 */
	if (want.fresh) {
		return repo.create({ cwd: '/' });
	}
	const requested = want.requested;

	let asked: string | undefined;
	try {
		const candidates = sessionCandidates(await repo.list({ cwd: '/' }), requested);
		/*
		 * Only a request this root can actually satisfy counts as one. A note left
		 * for a workspace that never came up matches nothing, and reporting *that*
		 * as a failure would blame a damaged file for a switch that was refused.
		 */
		asked = candidates[0]?.path === requested ? requested : undefined;

		for (const candidate of candidates) {
			try {
				const session = await repo.open(candidate);
				/*
				 * **Opening is not enough to know it is usable.** `open` parses the
				 * file; nothing walks the parent chain until the first turn builds a
				 * context, and `getPathToRootOrCompaction` throws `Entry <id> not
				 * found` there on a chain with a hole in it. That arrived as the
				 * agent's reply to every prompt, in a build with one session and no
				 * way to start another — so the window was unusable and the fallback
				 * below never ran.
				 *
				 * `getBranch()` is that same walk, done here where failing costs only
				 * this candidate. The loop is what makes that true: a damaged file is
				 * skipped for the next one, rather than costing you every stored
				 * conversation in the workspace.
				 */
				await session.getBranch();
				/*
				 * Landing somewhere other than where you pointed is the one outcome
				 * that must not be silent: it produces the same window a successful
				 * switch does. Recorded here and announced by the workbench, because
				 * this runs long before anything can speak to the user.
				 */
				if (asked !== undefined && candidate.path !== asked) {
					recordUnopened(asked);
				}
				return session;
			} catch {
				// This file cannot be replayed. Leave it on disk and try the next.
			}
		}
	} catch {
		/*
		 * The list itself could not be read, so nothing was even tried. Reported
		 * against the raw request rather than `asked`, which is still undefined
		 * here — that ordering is what made this silent in the first build: an
		 * unreadable sessions directory produced a blank window with no reason
		 * given, which is the exact outcome `recordUnopened` exists to prevent.
		 */
		if (requested !== undefined) {
			recordUnopened(requested);
		}
		return repo.create({ cwd: '/' });
	}
	if (asked !== undefined) {
		recordUnopened(asked);
	}
	return repo.create({ cwd: '/' });
}

/** Browser mode's, where there is no disk and a child is simply another one. */
export function memorySessions(): SessionStore {
	return {
		own: Promise.resolve(new Session(new InMemorySessionStorage())),
		// No disk, so no file to name. The navigator reads this as "not one of
		// the stored rows", which is exactly right in browser mode.
		path: Promise.resolve(undefined),
		child: async () => new Session(new InMemorySessionStorage()),
		/*
		 * Empty, not fabricated. Browser mode has no disk, so it has no stored
		 * conversations — and a fixture list here would be the parallel fiction
		 * ticket 10 ruled out, in the one place the navigator would look most
		 * convincing. The live session still shows; it is the only one there is.
		 */
		list: () => Promise.resolve([]),
	};
}
