// The terminal seam. The React terminal never manages a native process: it
// owns an xterm.js instance and an opaque session id, and everything else
// happens behind this adapter.

import { isTauri } from './native.ts';

export type OutputListener = (id: string, data: string) => void;
export type ExitListener = (id: string, code: number | undefined) => void;

/**
 * One shell, and the folder it was opened in — ticket 31.
 *
 * A PTY's working directory is set when it is spawned and never moves again, so
 * a shell cannot follow the window into another root. It stays where it is,
 * still running, and is shown only there. That is the same answer open editors
 * got: put down on the way out, picked up on the way back.
 */
export interface TerminalSession {
	readonly id: string;
	readonly name: string;
	readonly exited: boolean;
	/** Undefined before a workspace is chosen: the shell is in the app's own directory. */
	readonly root: string | undefined;
}

/** The shells belonging to `root`, oldest first. */
export function terminalsIn(
	sessions: readonly TerminalSession[],
	root: string | undefined
): readonly TerminalSession[] {
	return sessions.filter((session) => session.root === root);
}

/**
 * Which tab is on screen in `root`: the one remembered there if it is still
 * open, and otherwise the most recent shell in that folder.
 *
 * `remembered` is checked against this root's shells rather than trusted,
 * because the id it holds after a switch is the *other* folder's — which is
 * exactly the stale handle the ticket asks not to be left with.
 */
export function activeIn(
	sessions: readonly TerminalSession[],
	root: string | undefined,
	remembered: string | undefined
): string | undefined {
	const mine = terminalsIn(sessions, root);
	return mine.some((session) => session.id === remembered)
		? remembered
		: mine[mine.length - 1]?.id;
}

export interface TerminalAdapter {
	/** True when sessions are real shells rather than the echo fallback. */
	readonly isNative: boolean;
	/** The working directory is the provider's business, not the caller's. */
	create(id: string, cols: number, rows: number): Promise<void>;
	write(id: string, data: string): Promise<void>;
	resize(id: string, cols: number, rows: number): Promise<void>;
	kill(id: string): Promise<void>;
	/** Both return an unsubscribe function. */
	onOutput(listener: OutputListener): () => void;
	onExit(listener: ExitListener): () => void;
}

const OUTPUT_EVENT = 'terminal://output';
const EXIT_EVENT = 'terminal://exit';

const CRLF = '\r\n';
const PROMPT = '\x1b[36mfixture\x1b[0m> ';

/**
 * Deterministic fallback: an echo, not a shell.
 *
 * It exists so the terminal UI — tabs, resizing, exit state, focus — can be
 * built and exercised in the browser with no native process anywhere.
 */
function echoAdapter(): TerminalAdapter {
	const outputs = new Set<OutputListener>();
	const exits = new Set<ExitListener>();
	const lines = new Map<string, string>();

	function emit(id: string, data: string): void {
		for (const listener of outputs) {
			listener(id, data);
		}
	}

	return {
		isNative: false,
		async create(id) {
			lines.set(id, '');
			emit(id, `Browser fixture terminal. Input is echoed, not run.${CRLF}${PROMPT}`);
		},
		async write(id, data) {
			let line = lines.get(id);
			if (line === undefined) {
				return;
			}
			for (const char of data) {
				if (char === '\r') {
					emit(id, `${CRLF}you typed: ${line}${CRLF}${PROMPT}`);
					line = '';
				} else if (char === '\x7f') {
					// Backspace: erase one cell, and one character of state.
					if (line.length > 0) {
						line = line.slice(0, -1);
						emit(id, '\b \b');
					}
				} else {
					line += char;
					emit(id, char);
				}
			}
			lines.set(id, line);
		},
		async resize() {
			// Nothing to resize: no process is attached.
		},
		async kill(id) {
			if (!lines.delete(id)) {
				return;
			}
			for (const listener of exits) {
				listener(id, 0);
			}
		},
		onOutput(listener) {
			outputs.add(listener);
			return () => outputs.delete(listener);
		},
		onExit(listener) {
			exits.add(listener);
			return () => exits.delete(listener);
		},
	};
}

/*
 * Tauri's `listen` is async, but subscribing has to return an unsubscribe
 * function immediately for React effect cleanup. So the unlisten handle is
 * awaited in the background, and a cancelled flag covers the case where
 * cleanup runs before the subscription is even established.
 */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
	let cancelled = false;
	let unlisten: (() => void) | undefined;
	void import('@tauri-apps/api/event').then(async ({ listen }) => {
		const stop = await listen<T>(event, (message) => handler(message.payload));
		if (cancelled) {
			stop();
		} else {
			unlisten = stop;
		}
	});
	return () => {
		cancelled = true;
		unlisten?.();
	};
}

function tauriAdapter(): TerminalAdapter {
	const core = () => import('@tauri-apps/api/core');
	return {
		isNative: true,
		async create(id, cols, rows) {
			await (await core()).invoke('terminal_create', { id, cols, rows });
		},
		async write(id, data) {
			await (await core()).invoke('terminal_write', { id, data });
		},
		async resize(id, cols, rows) {
			await (await core()).invoke('terminal_resize', { id, cols, rows });
		},
		async kill(id) {
			await (await core()).invoke('terminal_kill', { id });
		},
		onOutput(listener) {
			return subscribe<{ id: string; data: string }>(OUTPUT_EVENT, (payload) =>
				listener(payload.id, payload.data)
			);
		},
		onExit(listener) {
			return subscribe<{ id: string; code: number | null }>(EXIT_EVENT, (payload) =>
				listener(payload.id, payload.code ?? undefined)
			);
		},
	};
}

export function createTerminalAdapter(): TerminalAdapter {
	return isTauri() ? tauriAdapter() : echoAdapter();
}
