import { useCallback, useEffect, useState } from 'react';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function appWindow() {
	const { getCurrentWindow } = await import('@tauri-apps/api/window');
	return getCurrentWindow();
}

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
		if (!isTauri) {
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

	const minimize = useCallback(() => void appWindow().then((w) => w.minimize()), []);
	const toggleMaximize = useCallback(() => void appWindow().then((w) => w.toggleMaximize()), []);
	const close = useCallback(() => void appWindow().then((w) => w.close()), []);
	const startDragging = useCallback(() => void appWindow().then((w) => w.startDragging()), []);

	return { available: isTauri, maximized, minimize, toggleMaximize, close, startDragging };
}
