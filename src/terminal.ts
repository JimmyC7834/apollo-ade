// The terminal seam. The React terminal never manages a native process: it
// owns an xterm.js instance and an opaque session id, and everything else
// happens behind this adapter.

export type OutputListener = (id: string, data: string) => void;
export type ExitListener = (id: string, code: number | undefined) => void;

export interface TerminalAdapter {
	/** True when sessions are real shells rather than the echo fallback. */
	readonly isNative: boolean;
	create(id: string, cols: number, rows: number, cwd?: string): Promise<void>;
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
		async create(id, cols, rows, cwd) {
			await (await core()).invoke('terminal_create', { id, cols, rows, cwd });
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
	const isTauri = '__TAURI_INTERNALS__' in window;
	return isTauri ? tauriAdapter() : echoAdapter();
}
