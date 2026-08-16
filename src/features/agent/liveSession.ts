// One conversation, as an object that outlives the view of it.
//
// **This is ticket 45, and the reason it had to come first.** A session used to
// be three module-level things at once: a promise cached in `sessionStore.ts`, a
// provider built during `WorkbenchController`'s render, and a transcript in
// `AgentChat`'s `useState`. All three are "the one session", so a second one was
// not a feature that had not been built — it was unrepresentable.
//
// What changes is where the state lives, not what it means. The turns, the run
// and the flags move onto an object; `AgentChat` renders whichever object is
// focused and holds none of it. That is also what makes a background turn
// possible at all (ticket 48): the sink an event arrives at belongs to the
// session, so unmounting its view stops nothing.

import type { AgentEvent, AgentProvider, AgentRun, SessionRoot } from '../../agent';
// Explicit extensions: `liveSession.check.ts` runs this under plain node.
import { liveStatus, type SessionStatus } from '../../sessions.ts';
import { applyEvent, type Turn } from './transcript.ts';

/**
 * Everything about a session that has to survive not being looked at.
 *
 * The draft is in here for the same reason the turns are: switching away from a
 * half-typed message and losing it would make focus expensive, and the whole
 * point of ticket 47 is that it is not. Purely visual state — which completion
 * is highlighted, whether the file drawer is open — stays in the component,
 * where resetting it on focus is right rather than merely tolerable.
 */
export interface LiveState {
	readonly turns: readonly Turn[];
	readonly running: boolean;
	/**
	 * Tracked apart from `running` because compaction cannot be stopped: pi's
	 * `compact()` takes no abort signal, so the Stop button must be gone rather
	 * than present and inert.
	 */
	readonly compacting: boolean;
	/** An approval or a question is outstanding. The run is stopped dead. */
	readonly awaiting: boolean;
	/**
	 * Something happened here while you were looking somewhere else.
	 *
	 * **Not a status.** A session can be done and read or done and unread, and
	 * folding the two loses the second — which is the only thing that makes a
	 * background turn discoverable.
	 */
	readonly unread: boolean;
	/** What is typed in the composer, and the files chipped onto it. */
	readonly draft: string;
	readonly attachments: readonly string[];
}

const EMPTY: LiveState = {
	turns: [],
	running: false,
	compacting: false,
	awaiting: false,
	unread: false,
	draft: '',
	attachments: [],
};

export interface LiveSession {
	/** Window-local identity. Not the file, which may not exist yet. */
	readonly key: string;
	readonly provider: AgentProvider;
	/** The stored file this session appends to, once the provider has said. */
	path: string | undefined;
	/**
	 * The folder this conversation lives in, fixed when it was created.
	 *
	 * Read from the provider rather than stored beside it, so there is one answer
	 * and it is the one Rust minted. Undefined in browser mode.
	 */
	readonly root: SessionRoot | undefined;
	/**
	 * The run in flight, or null.
	 *
	 * A mutable box rather than state: nothing renders it, and it has to be
	 * reachable from a sink that closes over the session rather than over a
	 * component that may since have unmounted.
	 */
	readonly run: { current: AgentRun | null };
	/** Whether this is the session on screen. The collection owns it. */
	focused: boolean;
	/** Called when a turn ends and this session is the one being looked at. */
	onIdle?: () => void;

	subscribe(listener: () => void): () => void;
	snapshot(): LiveState;
	patch(next: Partial<LiveState>): void;
	setTurns(update: (turns: readonly Turn[]) => readonly Turn[]): void;
	/** Open a turn and return the sink its events go into. */
	begin(label: string): (event: AgentEvent) => void;

	status(): SessionStatus;
	/** The first prompt, which is the only part of a conversation that is a name. */
	name(): string | undefined;
}

/**
 * @param announce Where this session's lifecycle is said out loud. Given by the
 * collection, which is the only thing that knows whether anyone is looking.
 */
export function createLiveSession(options: {
	readonly key: string;
	readonly provider: AgentProvider;
	readonly announce: (session: LiveSession, message: string) => void;
	/** Anything at all changed. The collection re-derives its rows from it. */
	readonly changed: (session: LiveSession) => void;
}): LiveSession {
	let state = EMPTY;
	const listeners = new Set<() => void>();

	const session: LiveSession = {
		key: options.key,
		provider: options.provider,
		path: undefined,
		root: options.provider.root,
		run: { current: null },
		focused: false,

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		snapshot: () => state,

		patch(next) {
			state = { ...state, ...next };
			for (const listener of listeners) {
				listener();
			}
			options.changed(session);
		},

		setTurns(update) {
			session.patch({ turns: update(state.turns) });
		},

		begin(label) {
			/*
			 * What this conversation is called, told to Rust so ticket 51's warning
			 * can name it. It is the first prompt — the session's name, not the
			 * turn's — so this says the same thing every time.
			 *
			 * **Every turn, not only the first**, and that is a bug found by driving
			 * it: a session restored from disk has its turns replayed rather than
			 * begun, so a "first turn only" label was never sent for any conversation
			 * that came back from a launch — and Rust's ids are minted fresh on every
			 * page load, so the label from before the reload names an id nobody has.
			 * The other agent's warning then read *"another session"*, which is the
			 * one thing ticket 51 says it must not say.
			 *
			 * Shortened, because this is a *name* and a whole prompt is not one: it
			 * goes into a sentence in another agent's tool result, where a paragraph
			 * reads as noise and costs context. The navigator's rows elide the same
			 * way, with CSS.
			 */
			const name = session.name() ?? label;
			options.provider.label(name.length > 60 ? `${name.slice(0, 57)}…` : name);
			const turn: Turn = { id: nextTurnId(state.turns), prompt: label, parts: [], status: 'running' };
			session.patch({ turns: [...state.turns, turn], running: true });

			return (event: AgentEvent) => {
				session.setTurns((current) =>
					current.map((item) => (item.id === turn.id ? applyEvent(item, event) : item))
				);
				if (event.kind === 'approval') {
					session.patch({ awaiting: true, unread: !session.focused });
					options.announce(session, `Approval required: ${event.name}`);
				} else if (event.kind === 'question') {
					session.patch({ awaiting: true, unread: !session.focused });
					options.announce(session, `The agent asked: ${event.question}`);
				} else if (event.kind === 'complete' || event.kind === 'cancelled') {
					/*
					 * **`unread` is decided here and not by the view**, because by the
					 * time a background turn ends its view was never mounted. This is the
					 * whole of "come back and find out what happened".
					 */
					session.patch({
						running: false,
						compacting: false,
						awaiting: false,
						unread: !session.focused,
					});
					session.run.current = null;
					options.announce(session, event.kind === 'complete' ? 'Agent finished' : 'Agent stopped');
					if (session.focused) {
						// The composer is where the next action starts; a keyboard user
						// should not have to find their way back to it.
						session.onIdle?.();
					}
				}
			};
		},

		status: () =>
			liveStatus({
				running: state.running || state.compacting,
				blocked: state.awaiting,
				turns: state.turns.length,
			}),
		name: () => state.turns[0]?.prompt,
	};

	return session;
}

/**
 * A turn id no turn in this session already has.
 *
 * `Date.now()` alone was the id and is not unique enough: restored history can
 * carry several turns written in the same millisecond, and a turn id is both the
 * React key and the identity `applyEvent` matches on — so a collision sends one
 * turn's events into another's transcript. The same trap `history.ts` hit when
 * replay was built, which is why it is solved the same way.
 */
export function nextTurnId(turns: readonly Turn[]): number {
	const now = Date.now();
	const highest = turns.reduce((top, turn) => Math.max(top, turn.id), 0);
	return highest >= now ? highest + 1 : now;
}
