// The session model the Session Navigator draws.
//
// A window holds as many conversations as you have opened, each with its own
// harness and its own confinement root. The rest are the workspace's *stored*
// conversations, read back from `.ade/sessions` — real records of real turns,
// which is what the three hardcoded fixtures that used to sit here were
// standing in for. `live: false` no longer means "invented"; it means "not open
// in this window right now".
//
// **That is why the prototype marking is gone rather than kept.** It was keyed
// off `live`, so the moment these rows came off disk it labelled real
// conversations as fixtures — a worse error than the one it was put there to
// prevent. The fixture workspace group went with it: it existed to draw the
// grouping, and the recent roots draw it for real now.
//
// Concurrent live sessions *are* modelled now — tickets 45 to 48. The cost was
// taken with eyes open: N harnesses against one git tree makes the per-turn
// `git_checkpoint` ambiguous, because two turns interleaving produce a snapshot
// neither conversation was ever alone in. A per-root queue was declined in
// favour of telling the truth about it — tickets 51 and 52 — so until those
// land, undo in a contended root is the known sharp edge.
// Confinement is `docs/adr/0002-a-root-per-session.md`.

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
	 * True for a session a harness is attached to. False means stored, not
	 * invented — the view shows the difference with the marker's size and must
	 * not label the others, which is what it used to do back when `false` meant
	 * fixture.
	 */
	readonly live: boolean;
	/** True for the one live session on screen. At most one row ever has it. */
	readonly focused?: boolean;
	/**
	 * The file this row is, as `listSessions` reported it.
	 *
	 * Set on a live row too, and that is what stops the same conversation being
	 * offered twice: a session open in this window is filtered out of the stored
	 * list by matching on this. Undefined until the provider has said which file
	 * it got, and in browser mode where there is no disk.
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
	/**
	 * Which root this conversation is in — ticket 49, widened by ticket 62.
	 *
	 * A window's conversations no longer share a folder, so a live row belongs
	 * under its own workspace group rather than under whichever one is focused.
	 * Undefined means "wherever this window is", which is browser mode and the
	 * only case there was before.
	 *
	 * **Stored rows carry it too now, and that is what makes `switchIndex` safe
	 * to use.** An index is a position in a list that `remember` reorders; a path
	 * is what the row actually means, and the click re-resolves one into the other
	 * against the list as it stands rather than as it stood. The path never
	 * crosses to Rust — see `Locate` and ADR 0002.
	 */
	readonly root?: string;
}

/**
 * Whether a row offers archive and delete — ticket 56.
 *
 * Three noes, and only the last is arbitrary:
 *
 * - **A live session.** Archiving the conversation you are having is a state
 *   nothing downstream expects, and deleting a running session's file is worse.
 *   Only a live session runs a turn, so this one test covers "in flight" too.
 * - **A session in another workspace.** `rename_entry` and `delete_entry`
 *   resolve against the *window's* root, and a stored row is a file rather than
 *   a registered session, so there is no id to write with. Offering them here
 *   would mean a new write door into a root the window is not in — the
 *   confinement boundary itself. It costs one click: picking the row brings the
 *   window to its folder, and then the buttons are there.
 * - **No path.** Browser mode, and a live row before the store has said which
 *   file it got. Nothing to move.
 */
export function manageable(session: Session): boolean {
	return !session.live && session.switchIndex === undefined && session.storedPath !== undefined;
}

/**
 * Where the archive folder sits, relative to the root.
 *
 * **Beside `.ade/sessions`, not inside it.** `JsonlSessionRepo.list` called
 * without a `cwd` enumerates every *directory* under the sessions root and
 * parses the `.jsonl` files in each, so an archive folder in there would hand
 * every archived conversation straight back to the next caller that asks that
 * way. `listStored` passes a `cwd` today and would not have noticed; one
 * directory up costs nothing and removes the trap.
 */
const ARCHIVE = '.ade/archive';

/**
 * The rename that archives a session, as `WorkspaceProvider` wants its ids.
 *
 * **Root-relative, no leading slash.** `contained` in `workspace.rs` refuses an
 * absolute id outright and the session store spells every path with a leading
 * slash, so handing `storedPath` straight to `rename` fails every time.
 *
 * Only the file name is kept, so a path with directories in it cannot land
 * anywhere but in the archive folder.
 */
export function archiveMove(storedPath: string): {
	readonly folder: string;
	readonly from: string;
	readonly to: string;
} {
	const from = storedPath.replace(/^\/+/, '');
	const name = from.split('/').pop() ?? from;
	return { folder: ARCHIVE, from, to: `${ARCHIVE}/${name}` };
}

export interface WorkspaceGroup {
	readonly id: string;
	readonly label: string;
	/**
	 * The root this group is, as a path.
	 *
	 * What `switchIndex` *means*, as opposed to where it currently sits. Ticket
	 * 62: the index is re-resolved from this at the moment it is used, because
	 * choosing a folder reorders the list the index points into.
	 */
	readonly root: string;
	/** Undefined when the workspace is not a repository, or HEAD is detached. */
	readonly branch?: string;
	/**
	 * Index into Rust's recent-workspaces list, for a root that is *not* the
	 * current one. Present means activating this header switches to it — and
	 * it is an index rather than a path for the reason
	 * `docs/adr/0002-a-root-per-session.md` gives.
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

/**
 * A stored conversation, as the row it becomes.
 *
 * `done` rather than `idle` when it has messages in it, because that is the
 * difference the marker is for: a conversation someone had, versus a session
 * that was opened and abandoned. Neither is running — nothing but the live one
 * can be, and `live: false` is what the view keys that off.
 */
function storedRow(stored: StoredSession, root: string, switchIndex?: number): Session {
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
		/*
		 * Always `done`. It used to be `done` or `idle` — had, versus opened and
		 * abandoned — and ticket 58 stopped listing the abandoned ones, so the
		 * second answer described a row that no longer arrives here.
		 */
		status: 'done',
		live: false,
		storedPath: stored.id,
		switchIndex,
		root,
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
 * **The recent roots have sessions, through the narrow command rather than the
 * wide one.** `workspace.rs` resolves a workbench read against the current root,
 * so the choice was between crossing that boundary and a command that reads
 * another root *by recents index*. The second is what was built — `read_root`
 * there, read-only — and it is not a session: it makes it possible to *list* the
 * conversations in a folder the user has already handed over, without spending a
 * switch to find out what is in it. Confinement itself belongs to the session
 * now — `docs/adr/0002-a-root-per-session.md`.
 *
 * `elsewhere` is keyed by root path rather than positionally, because the recent
 * list is reordered by every switch and a stale index would draw one workspace's
 * conversations under another's name.
 */
export function buildGroups(options: {
	readonly workspace: WorkspaceSelection | undefined;
	readonly branch: string | undefined;
	readonly recents: readonly WorkspaceSelection[];
	/**
	 * The sessions this window has open, in the order they were opened.
	 *
	 * Built by the caller rather than from a name and a status, because there is
	 * no longer one of them to describe — and because their statuses come from
	 * live objects this module has no business knowing about. Each carries the
	 * root it is in, which is what decides the group it lands in.
	 */
	readonly live: readonly Session[];
	/**
	 * Every root's stored conversations, newest first, under the root they were
	 * read from.
	 *
	 * **One store, and ticket 61 made it one.** It was two — a map of the *other*
	 * roots' conversations beside a bare list meaning "this root's". The bare one
	 * carried no root, so it was drawn against whichever root was current when it
	 * was rendered rather than the one it was read from, and switching changes the
	 * current root long before the new list has been read. For that moment the
	 * workspace you had just arrived in was drawn holding the conversations of the
	 * one you left.
	 *
	 * A root with no entry has no rows, which is what "not read yet" honestly
	 * looks like, and is a state a map can express and a bare list cannot.
	 */
	readonly stored: ReadonlyMap<string, readonly StoredSession[]>;
}): readonly WorkspaceGroup[] {
	const { workspace } = options;
	if (!workspace) {
		return [];
	}
	/**
	 * One root's rows: its open conversations, then its stored ones.
	 *
	 * A conversation already open is dropped from the stored half rather than
	 * listed twice: it is one of the rows above, drawn from live state, and live
	 * state is the only place its status and unread flag are true. Offering the
	 * stored row as well would invite opening one file into two harnesses, which
	 * is two writers appending to one JSONL.
	 */
	// An arrow rather than a declaration: a hoisted function is not covered by
	// the guard above it, and TypeScript is right to say so.
	const rowsFor = (path: string, stored: readonly StoredSession[], switchIndex?: number) => {
		// Undefined `root` is browser mode's single fixture, which belongs to
		// whichever root the window is in — there is only ever one.
		const here = options.live.filter((session) => (session.root ?? workspace.path) === path);
		/*
		 * **An empty name means "not known yet", and it is filled from the row
		 * this conversation was opened from** — ticket 59.
		 *
		 * A live session has no name until its history has replayed, which is a
		 * file read. For that moment the row read `New session`, which is the
		 * label for a conversation nobody has said anything in — so clicking a
		 * conversation renamed it to something it was not, and then back.
		 *
		 * `New session` survives for the case it was written for: a conversation
		 * that is genuinely new has no stored row to borrow from.
		 */
		const open = here.map((session) =>
			session.name
				? session
				: {
						...session,
						name:
							stored.find((entry) => entry.id === session.storedPath)?.name ?? 'New session',
					}
		);
		return [
			...open,
			...stored
				.filter((entry) => !open.some((session) => session.storedPath === entry.id))
				/*
				 * Not `.map(storedRow)`: `map` passes the array index as the second
				 * argument, which is `switchIndex` here — so every stored row in the
				 * *current* root would claim to live in some other one, and opening it
				 * would switch you there. The check caught it, which is what it is for.
				 */
				.map((entry) => storedRow(entry, path, switchIndex)),
		];
	};
	const current = {
		id: workspace.path || workspace.label,
		label: workspace.label,
		root: workspace.path,
		branch: options.branch,
		sessions: rowsFor(workspace.path, options.stored.get(workspace.path) ?? []),
	};
	/*
	 * **Rust's order, kept** — ticket 58. The current workspace used to be
	 * hoisted to the top and the rest listed under it, so arriving somewhere
	 * moved its group to the front and every other group down one. A list you
	 * navigate by position must not reorder itself when you arrive; the recent
	 * list only moves when a folder is *chosen*, which is what `remember` in
	 * `workspace.rs` has always meant.
	 *
	 * Matched by path, not by label: two checkouts of the same project are a
	 * normal thing to have open and they share a label. `switchIndex` is the
	 * index into the *unfiltered* list, because that is the list Rust indexes.
	 */
	const groups = options.recents.map((recent, index) =>
		recent.path === workspace.path
			? current
			: {
					id: `recent:${recent.path}`,
					label: recent.label,
					root: recent.path,
					switchIndex: index,
					sessions: rowsFor(recent.path, options.stored.get(recent.path) ?? [], index),
				}
	);
	/*
	 * A root the window is in that the recent list does not name — a restore
	 * whose recents file was lost. It has no position to keep, so it goes first
	 * rather than not at all.
	 */
	return groups.includes(current) ? groups : [current, ...groups];
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
