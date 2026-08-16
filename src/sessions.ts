// The session model the Session Navigator draws.
//
// This app runs exactly one harness, one gate and one confinement root, so
// exactly one session here is live. The rest are the workspace's *stored*
// conversations, read back from `.ade/sessions` — real records of real turns,
// which is what the three hardcoded fixtures that used to sit here were
// standing in for. `live: false` no longer means "invented"; it means "not the
// one a harness is attached to right now".
//
// **That is why the prototype marking is gone rather than kept.** It was keyed
// off `live`, so the moment these rows came off disk it labelled real
// conversations as fixtures — a worse error than the one it was put there to
// prevent. The fixture workspace group went with it: it existed to draw the
// grouping, and the recent roots draw it for real now.
//
// Concurrent live sessions are deliberately not modelled. N harnesses against
// one git tree makes the per-turn `git_checkpoint` meaningless: two turns
// interleaving produce a checkpoint neither can be rolled back to. That is its
// own ticket. Multi-root is `docs/adr/0001-multi-root-confinement.md`.

import type { StoredSession } from './agent';
import type { WorkspaceSelection } from './workspace';

/**
 * The four states the Shell Guide's markers show.
 *
 * `waiting` is a real distinction the running harness already makes and not a
 * decoration: the gate blocks on a prompt, and the agent does nothing at all
 * until it is answered. Telling that apart from `running` is the difference
 * between "wait for it" and "it is waiting for you".
 */
export type SessionStatus = 'running' | 'waiting' | 'idle' | 'done';

export interface Session {
	readonly id: string;
	readonly name: string;
	readonly status: SessionStatus;
	/**
	 * Unread is **not** a lifecycle state. A session can be done and read, or
	 * done and unread; folding the two loses the second. Slice 44 raises it.
	 */
	readonly unread?: boolean;
	/**
	 * True for the one session a harness is attached to. False means stored, not
	 * invented — the view shows the difference with the marker's size and must
	 * not label the others, which is what it used to do back when `false` meant
	 * fixture.
	 */
	readonly live: boolean;
	/**
	 * The file this row opens, as `listSessions` reported it. Absent on the live
	 * row, which is already open — and that absence is what `selectSession` keys
	 * "there is nothing to switch to" off.
	 */
	readonly storedPath?: string;
	/**
	 * Index into Rust's recent list, for a session in a root that is not the
	 * current one. Present means opening it switches workspace first, which is
	 * the whole of "switching a session switches you to its workspace".
	 *
	 * Absent for a session in the current root, where there is nowhere to go.
	 */
	readonly switchIndex?: number;
}

export interface WorkspaceGroup {
	readonly id: string;
	readonly label: string;
	/** Undefined when the workspace is not a repository, or HEAD is detached. */
	readonly branch?: string;
	/**
	 * Index into Rust's recent-workspaces list, for a root that is *not* the
	 * current one. Present means activating this header switches to it — and
	 * it is an index rather than a path for the reason
	 * `docs/adr/0001-multi-root-confinement.md` gives.
	 *
	 * Absent on the current workspace, where there is nothing to switch to.
	 */
	readonly switchIndex?: number;
	readonly sessions: readonly Session[];
}

/**
 * The status of the one live session, from what the harness is doing.
 *
 * `blocked` means an approval or a question is outstanding. It outranks
 * `running` because the run is technically in flight either way, and the
 * useful answer is the one that says whose turn it is.
 */
export function liveStatus(options: {
	readonly running: boolean;
	readonly blocked: boolean;
	readonly turns: number;
}): SessionStatus {
	if (options.blocked) {
		return 'waiting';
	}
	if (options.running) {
		return 'running';
	}
	return options.turns > 0 ? 'done' : 'idle';
}

/** The single session that is actually backed by a harness. */
export const LIVE_SESSION_ID = 'live';

/**
 * A stored conversation, as the row it becomes.
 *
 * `done` rather than `idle` when it has messages in it, because that is the
 * difference the marker is for: a conversation someone had, versus a session
 * that was opened and abandoned. Neither is running — nothing but the live one
 * can be, and `live: false` is what the view keys that off.
 */
function storedRow(stored: StoredSession, switchIndex?: number): Session {
	return {
		/*
		 * Prefixed by root for a session elsewhere, because the id is a *react*
		 * key and a session path is only unique within its own workspace: two
		 * roots each holding `/.ade/sessions/--/x.jsonl` is not a contrived case,
		 * it is what a copied checkout looks like. `storedPath` keeps the path
		 * that is actually opened.
		 */
		id: switchIndex === undefined ? stored.id : `${switchIndex}:${stored.id}`,
		name: stored.name,
		status: stored.empty ? 'idle' : 'done',
		live: false,
		storedPath: stored.id,
		switchIndex,
	};
}

/**
 * The navigator's whole model: the current workspace with the live session at
 * the top of it and its stored conversations under that, then every other root
 * this app has been given.
 *
 * The live session's name comes from its first prompt, which is the only thing
 * about a session that is naturally a name. A stored session's comes from the
 * same place, read back off disk — see `nameStored` in `agent/sessionStore.ts`.
 *
 * **The recent roots now have sessions, through the narrow command rather than
 * the wide one.** This used to say they could not: `workspace.rs` resolves every
 * read against the current root, so the choice was between crossing that
 * boundary and a command that reads another root *by recents index*. The second
 * is what was built — `read_root` there, read-only — so nothing about
 * `docs/adr/0001-multi-root-confinement.md` is reopened. One root is still the
 * confinement boundary; it is merely possible to read the session list of a
 * folder the user has already handed over, without spending a switch to find
 * out what is in it.
 *
 * `elsewhere` is keyed by root path rather than positionally, because the recent
 * list is reordered by every switch and a stale index would draw one workspace's
 * conversations under another's name.
 */
export function buildGroups(options: {
	readonly workspace: WorkspaceSelection | undefined;
	readonly branch: string | undefined;
	readonly recents: readonly WorkspaceSelection[];
	readonly liveName: string | undefined;
	readonly liveStatus: SessionStatus;
	/** Something happened while you were not looking. Not a status — see `Session`. */
	readonly liveUnread?: boolean;
	/** This workspace's stored conversations, newest first. */
	readonly stored: readonly StoredSession[];
	/** Other recent roots' stored conversations, keyed by root path. */
	readonly elsewhere?: ReadonlyMap<string, readonly StoredSession[]>;
}): readonly WorkspaceGroup[] {
	const { workspace } = options;
	if (!workspace) {
		return [];
	}
	return [
		{
			id: workspace.path || workspace.label,
			label: workspace.label,
			branch: options.branch,
			sessions: [
				{
					id: LIVE_SESSION_ID,
					name: options.liveName ?? 'New session',
					status: options.liveStatus,
					unread: options.liveUnread,
					live: true,
				},
				/*
				 * The active one is dropped rather than deduplicated: it is already
				 * the row above, drawn from live state, and live state is the only
				 * place its status and unread flag are true. Reading it back off
				 * disk would show the same conversation as `done` while it runs.
				 */
				/*
				 * Not `.map(storedRow)`: `map` passes the array index as the second
				 * argument, which is `switchIndex` here — so every stored row in the
				 * *current* root would claim to live in some other one, and opening it
				 * would switch you there. The check caught it, which is what it is for.
				 */
				...options.stored.filter((entry) => !entry.active).map((entry) => storedRow(entry)),
			],
		},
		/*
		 * Matched by path, not by label: two checkouts of the same project are a
		 * normal thing to have open and they share a label. `switchIndex` is the
		 * index into the *unfiltered* list, because that is the list Rust indexes.
		 */
		...options.recents.flatMap((recent, index) =>
			recent.path === workspace.path
				? []
				: [
						{
							id: `recent:${recent.path}`,
							label: recent.label,
							switchIndex: index,
							sessions: (options.elsewhere?.get(recent.path) ?? []).map((entry) =>
								storedRow(entry, index)
							),
						},
					]
		),
	];
}

/** `workspace/branch`, or the workspace alone when there is no branch. */
export function breadcrumb(
	workspace: WorkspaceSelection | undefined,
	branch: string | undefined
): string {
	if (!workspace) {
		return 'No folder open';
	}
	return branch ? `${workspace.label}/${branch}` : workspace.label;
}
