/*
 * What is currently on top of the workbench, counted in one place.
 *
 * This exists for exactly one reason, and it is a consequence of ADR 0004: a
 * browser tab is a child webview, which on Windows is a real child HWND placed
 * `HWND_TOP`. It paints above the whole React tree, so **no overlay of ours can
 * draw over it** — a command centre opened while a tab is showing would open
 * behind the page.
 *
 * The mitigation the ADR settled on is one rule: any overlay that opens hides
 * the tab. This module is what makes that one rule rather than a concern spread
 * through the UI. Every modal in the workbench is an `Overlay`, every anchored
 * menu is a `ContextMenu`, and notices are `Toasts` — three mount points, each
 * of which declares itself here, so a fourth kind of overlay added later fails
 * visibly (it is drawn behind the page) rather than silently.
 *
 * It is a module-level counter and not a React context on purpose: a context
 * would have to be provided above every consumer, and the consumers here are a
 * UI primitive and a dock artifact that share no ancestor worth threading.
 */

import { useEffect, useSyncExternalStore } from 'react';

let count = 0;
const listeners = new Set<() => void>();

function changed(): void {
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Declare that this component is covering the workbench while `active`.
 *
 * Called with the same `open` flag the surface already renders from, so a
 * surface cannot be open without saying so — there is no separate call to
 * forget. Unmounting while open releases the claim, which is what a dialog
 * removed from the tree in one commit does.
 */
export function useOccluder(active: boolean): void {
	useEffect(() => {
		if (!active) {
			return;
		}
		count += 1;
		changed();
		return () => {
			count -= 1;
			changed();
		};
	}, [active]);
}

/** True while anything is drawn over the workbench. */
export function useOccluded(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => count > 0,
		// Server snapshot: nothing is open before the first paint.
		() => false
	);
}
