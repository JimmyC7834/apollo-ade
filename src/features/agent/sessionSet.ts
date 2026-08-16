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

export interface SessionSet {
	subscribe(listener: () => void): () => void;
	view(): SessionSetView;
	/** The session this window comes up with. Safe to call any number of times. */
	bootstrap(): void;
	/** A conversation of its own. Empty, and focused as soon as it exists. */
	open(want?: SessionWant): Promise<LiveSession | undefined>;
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

	async function build(want: SessionWant): Promise<LiveSession | undefined> {
		let provider;
		try {
			provider = await createAgentProvider(want);
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
		sessions = [...sessions, session];
		set.focus(session.key);

		/*
		 * History, once, into an empty transcript. Without it a resumed session
		 * comes up blank with a model that remembers all of it — the transcript is
		 * built from events in this window, and a resumed one has none.
		 */
		void provider.history().then((restored) => {
			if (restored.length > 0 && session.snapshot().turns.length === 0) {
				session.patch({ turns: restored.map(replay) });
			}
		});
		// Which file this is, so the navigator can tell an open conversation from
		// a stored row offering to open the same one twice.
		void provider.path().then((path) => {
			session.path = path;
			publish();
		});
		return session;
	}

	const set: SessionSet = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		view: () => view,

		bootstrap() {
			if (booted) {
				return;
			}
			// Set before the await, which is what makes a second call — StrictMode's,
			// or a re-run of the effect — find it already true rather than race it.
			booted = true;
			/*
			 * The newest conversation in this root, which is what a launch has always
			 * opened with. Coming back to the *set* of sessions you had is
			 * [ticket 53](docs/wayfinder/pi-harness/tickets/53-launch-reopens-sessions.md);
			 * it needs a record of several, which is not what this ever held.
			 */
			void set.open({});
		},

		open: (want = { fresh: true }) => build(want),

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
