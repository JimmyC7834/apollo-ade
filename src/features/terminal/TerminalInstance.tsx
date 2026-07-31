import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import type { TerminalAdapter } from '../../terminal';

export interface TerminalInstanceProps {
	readonly adapter: TerminalAdapter;
	readonly id: string;
	/** Inactive instances stay mounted so their scrollback survives. */
	readonly active: boolean;
	readonly cwd: string | undefined;
	readonly onExit: (id: string, code: number | undefined) => void;
}

/*
 * One xterm.js instance bound to one session id.
 *
 * The session is created here, on mount, rather than by the panel: the shell
 * needs the terminal's real column and row count, and that is only known once
 * the element has been laid out and fitted.
 */
export function TerminalInstance({ adapter, id, active, cwd, onExit }: TerminalInstanceProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<FitAddon>(null);
	// The exit callback must not re-create the terminal when it changes.
	const exitRef = useRef(onExit);
	exitRef.current = onExit;

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		/*
		 * xterm measures and paints on a canvas, so it needs literal values —
		 * a `var(--ide-*)` string would be taken as a font name. The tokens
		 * are still the single source: they are read off the document here.
		 */
		const styles = getComputedStyle(document.documentElement);
		const token = (name: string) => styles.getPropertyValue(name).trim();

		const terminal = new Terminal({
			fontFamily: token('--ide-terminal-font-family'),
			fontSize: Number.parseInt(token('--ide-terminal-font-size'), 10),
			// VS Code's defaults: block cursor, no blink, no extra leading.
			cursorStyle: 'block',
			cursorBlink: false,
			lineHeight: 1,
			letterSpacing: 0,
			scrollback: 1000,
			theme: {
				background: token('--ide-bg-panel'),
				foreground: token('--ide-terminal-fg'),
				cursor: token('--ide-terminal-fg'),
				selectionBackground: token('--ide-terminal-selection'),
				black: token('--ide-ansi-black'),
				red: token('--ide-ansi-red'),
				green: token('--ide-ansi-green'),
				yellow: token('--ide-ansi-yellow'),
				blue: token('--ide-ansi-blue'),
				magenta: token('--ide-ansi-magenta'),
				cyan: token('--ide-ansi-cyan'),
				white: token('--ide-ansi-white'),
				brightBlack: token('--ide-ansi-bright-black'),
				brightRed: token('--ide-ansi-bright-red'),
				brightGreen: token('--ide-ansi-bright-green'),
				brightYellow: token('--ide-ansi-bright-yellow'),
				brightBlue: token('--ide-ansi-bright-blue'),
				brightMagenta: token('--ide-ansi-bright-magenta'),
				brightCyan: token('--ide-ansi-bright-cyan'),
				brightWhite: token('--ide-ansi-bright-white'),
			},
		});
		const fit = new FitAddon();
		fitRef.current = fit;
		terminal.loadAddon(fit);
		terminal.open(host);
		fit.fit();

		/*
		 * xterm claims Tab for the shell, which would trap keyboard focus in
		 * the panel. Shift+Tab is handed back to the browser as the escape
		 * hatch — no shell needs it, and without one the terminal is a dead
		 * end for anyone not using a pointer.
		 */
		terminal.attachCustomKeyEventHandler((event) => !(event.key === 'Tab' && event.shiftKey));

		const stopOutput = adapter.onOutput((sessionId, data) => {
			if (sessionId === id) {
				terminal.write(data);
			}
		});
		const stopExit = adapter.onExit((sessionId, code) => {
			if (sessionId !== id) {
				return;
			}
			terminal.write(`\r\n\x1b[90m[process exited${code === undefined ? '' : ` (${code})`}]\x1b[0m\r\n`);
			exitRef.current(sessionId, code);
		});

		const typed = terminal.onData((data) => void adapter.write(id, data));
		void adapter.create(id, terminal.cols, terminal.rows, cwd);

		// The panel is resizable by sash and by window, so measure the element
		// rather than listening for window resizes.
		const observer = new ResizeObserver(() => {
			if (host.clientWidth === 0 || host.clientHeight === 0) {
				return; // Hidden: fitting now would give a 1x1 terminal.
			}
			fit.fit();
			void adapter.resize(id, terminal.cols, terminal.rows);
		});
		observer.observe(host);

		return () => {
			observer.disconnect();
			typed.dispose();
			stopOutput();
			stopExit();
			terminal.dispose();
			void adapter.kill(id);
		};
	}, [adapter, id, cwd]);

	// Becoming visible again is not a resize of the element, so fit explicitly.
	useEffect(() => {
		if (active) {
			fitRef.current?.fit();
		}
	}, [active]);

	return (
		<div
			className="ide-terminal-instance"
			hidden={!active}
			ref={hostRef}
			role="group"
			aria-label={`Terminal ${id}`}
		/>
	);
}
