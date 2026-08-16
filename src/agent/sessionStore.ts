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
import { recordUnopened, sessionCandidates, takeSessionRequest } from '../sessionRequest';

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
	/** True for the one this window is appending to right now. */
	readonly active: boolean;
	/** No user message in it — started and abandoned, rather than had. */
	readonly empty: boolean;
}

let sessionOnce: Promise<Session<JsonlSessionMetadata>> | undefined;

/**
 * One session per window, however many times the provider is built.
 *
 * React's StrictMode double-invokes `useMemo` in development, so
 * `createAgentProvider` runs twice — and both runs found no stored session and
 * both created one, leaving an empty orphan on disk at every start. Caching the
 * *promise* rather than the session is what makes the second caller wait for
 * the first rather than race it.
 *
 * This does not make concurrent writers safe in general: two windows on the
 * same workspace are two module instances, and both would open the newest
 * session and append to the same file. Nothing here prevents that — and note
 * that picking a session does *not* reopen that hole, because a switch is a
 * reload of this same one window rather than a second one.
 */
export function diskSessions(env: ExecutionEnv): SessionStore {
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: SESSIONS_ROOT });
	const own = (sessionOnce ??= openSession(env, repo));
	return {
		own,
		list: () => listStored(repo, own),
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
 * **Children are excluded, for the reason `openSession` excludes them.** A
 * subagent's session is a sub-task's record, not a conversation the user had,
 * and listing them would bury the four turns someone remembers under forty they
 * never saw.
 */
async function listStored(
	repo: JsonlSessionRepo,
	own: Promise<Session<JsonlSessionMetadata>> | undefined,
	limit = MAX_LISTED
): Promise<readonly StoredSession[]> {
	/*
	 * The active path is read first and separately: if it cannot be read the
	 * list is still worth showing, it merely marks nothing as active — and the
	 * live row is drawn from live state regardless, so nothing disappears.
	 *
	 * Undefined for another workspace, where nothing is active by definition:
	 * one window, one harness, one root.
	 */
	let active: string | undefined;
	try {
		active = own === undefined ? undefined : (await (await own).getMetadata()).path;
	} catch {
		active = undefined;
	}

	const stored = (await repo.list({ cwd: '/' }))
		.filter((entry) => !entry.metadata?.delegatedFrom)
		.slice(0, limit);

	return await Promise.all(
		stored.map(async (metadata) => {
			const { name, empty } = await nameStored(repo, metadata);
			return {
				id: metadata.path,
				name,
				startedAt: metadata.createdAt,
				active: metadata.path === active,
				empty,
			};
		})
	);
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
		return await listStored(repo, undefined, MAX_LISTED_ELSEWHERE);
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
	repo: JsonlSessionRepo
): Promise<Session<JsonlSessionMetadata>> {
	/*
	 * A self-ignoring directory, so the transcript never reaches the user's
	 * commits and their `.gitignore` is never edited by us. `git` reads a
	 * `.gitignore` at any level, and `*` there covers everything beneath it.
	 */
	await env.createDir('/.ade');
	await env.writeFile('/.ade/.gitignore', '*\n');

	/*
	 * Taken outside the `try`, so it is consumed even if listing throws. A
	 * request that survived a failed start-up would reopen on the next launch,
	 * long after the user had forgotten asking.
	 */
	const requested = takeSessionRequest();

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
