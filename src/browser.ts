// The browser-tab seam. Feature code never calls Tauri: it opens a tab, moves
// it, and asks it a question, and where the page actually lives is this file's
// business.
//
// See docs/adr/0004-a-browser-tab-is-a-child-webview.md. The page is a child
// webview, which means it is **not in the React tree** — it is a foreign HWND
// borrowing a rectangle of our window, painted above everything the DOM draws.
// Two consequences leak out of here and cannot be hidden: the caller has to
// tell us where the rectangle is, and any overlay that opens has to hide it.

import { isTauri } from './native.ts';

/** A rectangle in CSS pixels, relative to the window's client area. */
export interface Rect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface BrowserAdapter {
	/** True when a tab is a real page rather than the browser stand-in. */
	readonly isNative: boolean;
	/** Open, or navigate and move the tab that already has this label. */
	open(label: string, url: string, rect: Rect): Promise<void>;
	place(label: string, rect: Rect): Promise<void>;
	navigate(label: string, url: string): Promise<void>;
	close(label: string): Promise<void>;
	/** Evaluate in the page and return the parsed result. */
	evaluate(label: string, js: string): Promise<unknown>;
	/** Hand a URL the allow-list refuses to the OS browser. */
	openExternal(url: string): Promise<void>;
	/** Take the keyboard back from a page. See `browser_return_focus`. */
	returnFocus(): Promise<void>;
	/** A message from a page — `esc` and nothing else so far. */
	onMessage(listener: (label: string, message: string) => void): () => void;
	/** A navigation Rust refused. Returns an unsubscribe function. */
	onRefused(listener: (label: string, url: string, reason: string) => void): () => void;
}

/**
 * Where a hidden tab goes.
 *
 * Directly below the window, where the OS clips it away but the page keeps its
 * size and keeps laying out. `hide()` would be simpler to read and is the thing
 * the design deliberately does not do — a webview that has never been shown may
 * report zero-size rects, and an agent driving a page with no layout reports a
 * working page as broken. `CONTEXT.md` records this repo meeting the same
 * hazard in the dev browser pane, where Monaco never laid out.
 */
export function hiddenRect(rect: Rect, windowHeight: number): Rect {
	return { ...rect, y: windowHeight + 32 };
}

/**
 * The rectangle a tab the agent opened is given.
 *
 * It has no box in the dock to measure — that is what "hidden" means here — so
 * it gets a plausible desktop-sized viewport, below the window where the OS
 * clips it. The size is the part that matters: it is what the page lays out
 * against, and what the agent then reads.
 */
export function agentRect(windowHeight: number): Rect {
	return { x: 0, y: windowHeight + 32, width: 1280, height: 800 };
}

/**
 * What the dev typed, as a URL.
 *
 * A bare `localhost:5173` is what anyone types into an address row, and it
 * parses as a URL with the scheme `localhost:` — which Rust then refuses with a
 * message about schemes, for what is plainly a valid thing to have typed. So a
 * missing scheme becomes `http://` here. Nothing else is guessed: the allow-list
 * itself stays in Rust, and this never decides whether a URL is permitted.
 */
export function normalizeUrl(typed: string): string {
	const trimmed = typed.trim();
	if (trimmed === '') {
		return '';
	}
	/*
	 * `://`, not just a colon: `localhost:5173` is a bare host and a port, and a
	 * colon alone reads it as the scheme `localhost:` — which is the exact case
	 * this function exists for. `file:` is the one scheme that has no authority
	 * and so has to be named.
	 */
	const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || /^file:/i.test(trimmed);
	return scheme ? trimmed : `http://${trimmed}`;
}

/** The host a tab is showing, for a tab title or a chip label. */
export function urlHost(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'file:' ? 'file' : parsed.host || parsed.protocol;
	} catch {
		return url;
	}
}

/**
 * The browser stand-in: a tab that remembers a URL and shows nothing.
 *
 * There is no honest fallback here — an `<iframe>` would be the second
 * mechanism the ADR rejected, and cross-origin means it could not answer
 * `evaluate` anyway. So it records the calls, answers `evaluate` with `null`,
 * and `isNative` is false so the view can say why the box is empty. That is
 * enough for the tab strip, the address row, the position sync and the
 * occlusion rule to be built and exercised under `npm run dev`.
 */
function fixtureAdapter(): BrowserAdapter {
	const tabs = new Map<string, string>();
	return {
		isNative: false,
		async open(label, url) {
			tabs.set(label, url);
		},
		async place() {},
		async navigate(label, url) {
			tabs.set(label, url);
		},
		async close(label) {
			tabs.delete(label);
		},
		async evaluate() {
			return null;
		},
		async openExternal() {},
		async returnFocus() {},
		onMessage() {
			return () => {};
		},
		onRefused() {
			return () => {};
		},
	};
}

/*
 * Same shape as `terminal.ts`: `listen` is async but React effect cleanup needs
 * an unsubscribe function immediately, so the handle is awaited in the
 * background and a cancelled flag covers cleanup that runs first.
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

function tauriAdapter(): BrowserAdapter {
	const core = () => import('@tauri-apps/api/core');
	const rect = (box: Rect) => ({
		x: Math.round(box.x),
		y: Math.round(box.y),
		width: Math.round(box.width),
		height: Math.round(box.height),
	});
	return {
		isNative: true,
		async open(label, url, box) {
			await (await core()).invoke('browser_open', { label, url, ...rect(box) });
		},
		async place(label, box) {
			await (await core()).invoke('browser_place', { label, ...rect(box) });
		},
		async navigate(label, url) {
			await (await core()).invoke('browser_navigate', { label, url });
		},
		async close(label) {
			await (await core()).invoke('browser_close', { label });
		},
		async evaluate(label, js) {
			const answer = await (await core()).invoke<string>('browser_eval', { label, js });
			// `eval_with_callback` serialises to JSON, and an expression that
			// returned nothing arrives as the string "undefined" rather than as
			// JSON. Parsing failure is the page's answer, not an error.
			try {
				return JSON.parse(answer) as unknown;
			} catch {
				return undefined;
			}
		},
		async openExternal(url) {
			await (await core()).invoke('browser_open_external', { url });
		},
		async returnFocus() {
			await (await core()).invoke('browser_return_focus');
		},
		onMessage(listener) {
			return subscribe<{ label: string; message: string }>('browser://message', (payload) =>
				listener(payload.label, payload.message)
			);
		},
		onRefused(listener) {
			return subscribe<{ label: string; url: string; reason: string }>(
				'browser://refused',
				(payload) => listener(payload.label, payload.url, payload.reason)
			);
		},
	};
}

export function createBrowserAdapter(): BrowserAdapter {
	return isTauri() ? tauriAdapter() : fixtureAdapter();
}
