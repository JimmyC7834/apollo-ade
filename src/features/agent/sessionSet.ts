// The conversations this window is holding, and which one you are looking at.
//
// One module-level object, and that is deliberate: what ticket 45 removes is
// module-level state that *is* a session, not the window's collection of them.
// The collection has to be module-level, because it outlives every component
// that draws it — a turn running in a session nobody has on screen has nothing
// else to belong to.
//
// It is also what makes StrictMode's double render harmless without a promise
// cache. Creating a session is an *action* now: `bootstrap` is idempotent and
// everything else happens because someone pressed something, and a press does
// not happen twice.

import { createAgentProvider, type HistoryTurn, type SessionWant } from '../../agent';
import { createLiveSession, type LiveSession } from './liveSession';
import { applyEvent, type Turn } from './transcript';

export interface SessionSetView {
	readonly sessions: readonly LiveSession[];
	readonly focused: LiveSession | undefined;
	/**
	 * Bumped whenever any session's own state changes.
	 *
	 * The collection's identity does not change when a turn arrives inside one of
	 * its sessions, so without this the navigator would never redraw a status.
	 * Cheaper than making every session's state part of this object, and it is
	 * the only field the workbench reads without caring what it says.
	 */
	readonly revision: number;
}

/**
 * One conversation to put back — the shape `sessionRequest.ts` writes down.
 *
 * Structurally `OpenSession`, and declared here rather than imported for the
 * reason `SessionRoot` is: the record is the workbench's, and this is underneath
 * it.
 */
export interface Reopen {
	/** The folder it lived in, as a path — recognised, never handed to Rust. */
	readonly root: string;
	/** The session file to open, root-relative. */
	readonly path: string;
	readonly focused?: boolean;
}

/**
 * Which index into Rust's recent list a root is at, *now*.
 *
 * Asked per session rather than once for the batch, because the list is Rust's
 * and can be reordered by anything that adopts a root. An index resolved for the
 * whole batch and spent one entry at a time is an index that can go stale
 * halfway through — which it did, and a conversation came back in the wrong
 * folder. Undefined means the root is gone.
 */
export type Locate = (root: string) => Promise<number | undefined>;

export interface SessionSet {
	subscribe(listener: () => void): () => void;
	view(): SessionSetView;
	/**
	 * The conversations this window comes up with. Safe to call any number of
	 * times; only the first call does anything.
	 *
	 * @param reopen What was open when the window last closed — ticket 53. Empty
	 * is a first launch, and opens one session exactly as it always did.
	 */
	bootstrap(reopen?: readonly Reopen[], locate?: Locate): void;
	/**
	 * A conversation of its own. Empty, and focused as soon as it exists.
	 *
	 * @param at Which recent root to create it in, by index — ticket 49.
	 * Undefined is the root the window is in.
	 */
	open(want?: SessionWant, at?: number): Promise<LiveSession | undefined>;
	focus(key: string): void;
	/** Stop watching. The file stays on disk and the row stays in the navigator. */
	close(key: string): void;
	/** Where a session's lifecycle is said out loud. The workbench installs it. */
	onAnnounce(announce: (message: string) => void): void;
}

function createSessionSet(): SessionSet {
	let sessions: LiveSession[] = [];
	let focused: LiveSession | undefined;
	let revision = 0;
	let view: SessionSetView = { sessions, focused, revision };
	const listeners = new Set<() => void>();
	let booted = false;
	let speak: ((message: string) => void) | undefined;

	function publish() {
		revision += 1;
		view = { sessions: [...sessions], focused, revision };
		for (const listener of listeners) {
			listener();
		}
	}

	/**
	 * **The name is the notification.** A background session's message is
	 * useless without it — *"Agent finished"* from a conversation you are not
	 * looking at names nothing and reads like the one you are. The focused
	 * session keeps the bare wording it has always had.
	 */
	function announce(session: LiveSession, message: string) {
		speak?.(session.focused ? message : `${session.name() ?? 'Session'}: ${message}`);
	}

	async function build(want: SessionWant, at?: number): Promise<LiveSession | undefined> {
		let provider;
		try {
			provider = await createAgentProvider(want, at);
		} catch (cause) {
			// Registering the root is the one part of this that can fail before
			// anything exists to fail *into*, so it is reported rather than thrown
			// at a click handler.
			speak?.(`The session could not be started. ${(cause as Error)?.message ?? ''}`.trim());
			return undefined;
		}
		const session = createLiveSession({
			key: `session-${revision}-${Date.now()}`,
			provider,
			announce,
			changed: publish,
		});
		/*
		 * Which file this is — **before it joins the collection, not after**. The
		 * navigator uses it to tell an open conversation from a stored row
		 * offering to open the same one, and `bootstrap` uses it to refuse opening
		 * a file that is already open. Both of those are decisions, and a decision
		 * cannot be made against a field that has not arrived yet.
		 *
		 * It used to be awaited *below* the two lines that publish, which meant the
		 * decision was made twice and wrongly the first time: for the length of one
		 * file read the window held a session with no path, so the navigator could
		 * not match it to the row it had just been opened from and drew both —
		 * ticket 59. Awaiting it was always the intent; doing so after publishing
		 * bought none of what the intent was for.
		 */
		session.path = await provider.path();
		sessions = [...sessions, session];
		set.focus(session.key);

		/*
		 * History, once, into an empty transcript. Without it a resumed session
		 * comes up blank with a model that remembers all of it — the transcript is
		 * built from events in this window, and a resumed one has none.
		 *
		 * **Not awaited, and that is why the row borrows a name.** A session has no
		 * name of its own until this lands, so waiting for it would hold a clicked
		 * conversation off screen for a file read. `buildGroups` fills the gap from
		 * the stored row instead.
		 */
		void provider.history().then((restored) => {
			if (restored.length > 0 && session.snapshot().turns.length === 0) {
				session.patch({ turns: restored.map(replay) });
			}
		});
		publish();
		return session;
	}

	const set: SessionSet = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		view: () => view,

		bootstrap(reopen = [], locate) {
			if (booted) {
				return;
			}
			// Set before the await, which is what makes a second call — StrictMode's,
			// or a re-run of the effect — find it already true rather than race it.
			booted = true;
			if (reopen.length === 0) {
				/*
				 * The newest conversation in this root, which is what a launch has
				 * always done and what a first launch still does.
				 */
				void set.open({});
				return;
			}
			/*
			 * The set that was open, put back — ticket 53.
			 *
			 * **One at a time, in order.** Each one is a provider, a harness and a
			 * session file opened through Tauri's serialised dispatcher; asking for
			 * six at once puts every other command at start-up behind all of them.
			 * Order is also what makes the navigator come up in the order they were
			 * opened rather than in whatever order the disk answered.
			 *
			 * **Nothing resumes.** A turn interrupted by quitting stays interrupted:
			 * `replayEntries` closes an unanswered tool call, so a session that was
			 * mid-turn comes back with that turn recorded as it was written rather
			 * than with a spinner running for a run that ended yesterday.
			 */
			void (async () => {
				let focus: LiveSession | undefined;
				const lost: string[] = [];
				for (const entry of reopen) {
					/*
					 * Already open, so opening it again would put two harnesses on one
					 * JSONL, both appending. Reachable two ways: a record with the same
					 * file twice, and a damaged file whose candidate fallback lands on a
					 * conversation an earlier iteration already opened.
					 */
					if (sessions.some((open) => open.path === entry.path)) {
						continue;
					}
					// Immediately before opening it, never earlier. See `Locate`.
					const at = await locate?.(entry.root);
					if (at === undefined) {
						lost.push(entry.root);
						continue;
					}
					const opened = await set.open({ requested: entry.path }, at);
					// Same rule, one step later: the fallback may have handed back a file
					// another entry already had. Two writers on one file is worse than
					// one conversation short.
					if (opened && sessions.some((open) => open !== opened && open.path === opened.path)) {
						set.close(opened.key);
						continue;
					}
					if (opened && entry.focused) {
						focus = opened;
					}
				}
				if (lost.length > 0) {
					/*
					 * A root that has since been deleted, unmounted, or pushed off the
					 * end of the recent list. Dropped with a message; the rest still
					 * open, because a convenience must not be able to break the window.
					 */
					speak?.(
						`${lost.length} conversation${lost.length === 1 ? '' : 's'} could not be ` +
							`reopened: ${[...new Set(lost)].join(', ')} is no longer available.`
					);
				}
				if (focus) {
					set.focus(focus.key);
				} else if (sessions.length === 0) {
					// Every one of them was refused. A window with no conversation has
					// nothing to be, so it comes up as a first launch would.
					void set.open({});
				}
			})();
		},

		open: (want = { fresh: true }, at) => build(want, at),

		focus(key) {
			const next = sessions.find((session) => session.key === key);
			if (!next || next === focused) {
				return;
			}
			if (focused) {
				focused.focused = false;
			}
			focused = next;
			next.focused = true;
			// Looking at it is what makes it read. Nothing else clears this.
			next.patch({ unread: false });
			publish();
		},

		close(key) {
			const going = sessions.find((session) => session.key === key);
			if (!going) {
				return;
			}
			/*
			 * Stopped, then handed back. Cancelling first matters: `dispose` makes
			 * Rust refuse every command carrying this session's id, so a run left
			 * alive would spend its last moments failing every tool it tried.
			 */
			going.run.current?.cancel();
			going.provider.dispose();
			sessions = sessions.filter((session) => session !== going);
			if (focused === going) {
				focused = undefined;
			}
			publish();
			/*
			 * A window without a conversation has nothing to be. Closing the last
			 * one therefore opens a fresh one rather than leaving an empty shell —
			 * the closed session is still on disk and still in the navigator, which
			 * is what "closing is not deleting" means.
			 */
			if (sessions.length === 0) {
				void set.open({ fresh: true });
			} else if (!focused) {
				set.focus(sessions[sessions.length - 1]!.key);
			}
		},

		onAnnounce(next) {
			speak = next;
		},
	};

	return set;
}

/**
 * Restored turns are `Turn`s like any other: replay the events, reduce them.
 *
 * Which is why nothing here knows what a tool call or a compaction looks like —
 * `replayEntries` produces the events and `applyEvent` is the same reducer a
 * live turn goes through.
 */
function replay(turn: HistoryTurn): Turn {
	return turn.events.reduce<Turn>(applyEvent, {
		id: turn.id,
		prompt: turn.prompt,
		parts: [],
		status: 'running',
	});
}

export const sessionSet = createSessionSet();
