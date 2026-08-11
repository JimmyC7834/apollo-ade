// The session model the Session Navigator draws.
//
// This app runs exactly one harness, one gate and one confinement root, so
// exactly one session here is live. The rest are fixtures, and they are marked
// as fixtures in the model rather than only in the view — a navigator that
// shows three sessions when one exists, with nothing saying so, is how a
// fixture gets mistaken for a feature.
//
// Concurrent live sessions are deliberately not modelled. N harnesses against
// one git tree makes the per-turn `git_checkpoint` meaningless: two turns
// interleaving produce a checkpoint neither can be rolled back to. That is its
// own ticket. Multi-root is `docs/adr/0001-multi-root-confinement.md`.

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
	 * False for every session but the live one. The view must show this, not
	 * merely honour it — see the module comment.
	 */
	readonly live: boolean;
}

export interface WorkspaceGroup {
	readonly id: string;
	readonly label: string;
	/** Undefined when the workspace is not a repository, or HEAD is detached. */
	readonly branch?: string;
	/** True when nothing in this group is real. */
	readonly fixture: boolean;
	/**
	 * Index into Rust's recent-workspaces list, for a root that is *not* the
	 * current one. Present means activating this header switches to it — and
	 * it is an index rather than a path for the reason
	 * `docs/adr/0001-multi-root-confinement.md` gives.
	 *
	 * Absent on the current workspace (there is nothing to switch to) and on
	 * the fixture group (there is nothing there).
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
 * Sessions that exist only to draw the navigator, and one extra workspace group
 * to draw the grouping. Every one is `live: false`, which is what the view
 * keys its prototype marking off.
 */
const FIXTURE_SESSIONS: readonly Session[] = [
	{ id: 'fixture:review', name: 'Review the gate policy', status: 'done', unread: true, live: false },
	{ id: 'fixture:diag', name: 'Chase a failing check', status: 'waiting', live: false },
	{ id: 'fixture:idle', name: 'Untitled session', status: 'idle', live: false },
];

const FIXTURE_GROUP: WorkspaceGroup = {
	id: 'fixture:workspace',
	label: 'another-workspace',
	branch: 'feature/pinned-dock',
	fixture: true,
	sessions: [
		{ id: 'fixture:other', name: 'Port the dock to portrait', status: 'running', live: false },
	],
};

/**
 * The navigator's whole model: the current workspace first with the live session
 * at the top of it, then every other root this app has been given, then the
 * fixtures.
 *
 * The live session's name comes from its first prompt, which is the only thing
 * about a session that is naturally a name. Nothing else names sessions yet.
 *
 * **The recent roots are groups with no sessions, and that is honest.** Sessions
 * do not persist, so a root that is not open right now has none to show. What it
 * has is a header you can activate to switch to it, which is the whole of
 * ticket 31 and the only real functionality in this slice.
 */
export function buildGroups(options: {
	readonly workspace: WorkspaceSelection | undefined;
	readonly branch: string | undefined;
	readonly recents: readonly WorkspaceSelection[];
	readonly liveName: string | undefined;
	readonly liveStatus: SessionStatus;
	/** Something happened while you were not looking. Not a status — see `Session`. */
	readonly liveUnread?: boolean;
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
			fixture: false,
			sessions: [
				{
					id: LIVE_SESSION_ID,
					name: options.liveName ?? 'New session',
					status: options.liveStatus,
					unread: options.liveUnread,
					live: true,
				},
				...FIXTURE_SESSIONS,
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
							fixture: false,
							switchIndex: index,
							sessions: [],
						},
					]
		),
		FIXTURE_GROUP,
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
