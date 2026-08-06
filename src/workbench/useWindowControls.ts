import { useCallback, useEffect, useState } from 'react';

import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { isTauri } from '../native';

const native = isTauri();

async function appWindow() {
	const { getCurrentWindow } = await import('@tauri-apps/api/window');
	return getCurrentWindow();
}

/*
 * The browser implementation of window chrome is doing nothing: a tab has no
 * frame to drag, minimize or close. It still has to exist. `available` gates
 * the button row, but Titlebar wires the drag region unconditionally, so
 * without this guard pressing the titlebar under `npm run dev` imports a
 * native-only module and rejects with nobody listening.
 */
function nativeWindow(run: (win: TauriWindow) => Promise<void>): void {
	if (native) {
		// Nothing useful follows a window that refuses to minimize, and an
		// unhandled rejection in a pointer handler is worse than silence.
		void appWindow().then(run).catch(noop);
	}
}

function noop(): void {}

export interface WindowControls {
	readonly available: boolean;
	readonly maximized: boolean;
	minimize: () => void;
	toggleMaximize: () => void;
	close: () => void;
	startDragging: () => void;
}

/**
 * Native window chrome behaviour. Maximize state is read back from the window
 * and re-read on every resize: a frameless window can be snapped or restored by
 * the OS without going through our buttons, so we never assume our own state.
 */
export function useWindowControls(): WindowControls {
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		if (!native) {
			return;
		}
		let unlisten: (() => void) | undefined;
		let disposed = false;

		void (async () => {
			const win = await appWindow();
			const sync = async () => setMaximized(await win.isMaximized());
			await sync();
			const stop = await win.onResized(() => void sync());
			if (disposed) {
				stop();
			} else {
				unlisten = stop;
			}
		})();

		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	const minimize = useCallback(() => nativeWindow((w) => w.minimize()), []);
	const toggleMaximize = useCallback(() => nativeWindow((w) => w.toggleMaximize()), []);
	const close = useCallback(() => nativeWindow((w) => w.close()), []);
	const startDragging = useCallback(() => nativeWindow((w) => w.startDragging()), []);

	return { available: native, maximized, minimize, toggleMaximize, close, startDragging };
}
