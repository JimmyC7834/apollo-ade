/*
 * A page you can look at, inside the dock — ticket 69.
 *
 * Everything awkward about this component follows from one fact: **the page is
 * not in the React tree.** It is a child webview Rust owns, painted over the
 * box below by the operating system. So this renders an address row and an
 * empty box that reserves the space, measures that box, and tells Rust where it
 * is — on mount, on dock resize, on window resize and on the portrait flip.
 *
 * It also never draws over the page, because it cannot: a child HWND is always
 * on top. The refusal line below the address row is outside the box for that
 * reason, not for layout taste.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { browserTabLabel } from '../../artifacts';
import { hiddenRect, normalizeUrl, urlHost, type BrowserAdapter, type Rect } from '../../browser';
import { Icon } from '../../ui';

export interface BrowserTabProps {
	/** The artifact id — `browser:1`. Also, through `browserTabLabel`, the webview's. */
	readonly id: string;
	readonly adapter: BrowserAdapter;
	/**
	 * False whenever the page must not be seen: another dock tab is in front,
	 * the dock is collapsed, or an overlay is open. A hidden tab is moved below
	 * the window rather than destroyed — see `hiddenRect`.
	 */
	readonly visible: boolean;
	/** Where the tab got its URL, for a tab the agent opened. */
	readonly initialUrl?: string;
	/** The page loaded. Carries the host, which is what the dock tab is labelled with. */
	readonly onOpened: (id: string, host: string) => void;
	/**
	 * Rust refused the URL, or the page would not load.
	 *
	 * Reported upward as well as rendered, because a tab the agent opened has no
	 * dock slot and nobody is looking at it — the refusal has to reach the tool
	 * call that asked for it or it reaches nobody.
	 */
	readonly onFailed: (id: string, reason: string) => void;
	/**
	 * False for a plugin panel — ticket 75.
	 *
	 * The same component, because a panel is the same thing: a child webview in
	 * a dock tab, measured by the same box and hidden by the same rule. What it
	 * does not get is an address row, because a plugin drew this page and there
	 * is nowhere else for it to go.
	 */
	readonly chrome?: boolean;
}

interface Refusal {
	readonly url: string;
	readonly reason: string;
}

function boxRect(element: HTMLElement | null): Rect | undefined {
	if (!element) {
		return undefined;
	}
	const box = element.getBoundingClientRect();
	return { x: box.x, y: box.y, width: box.width, height: box.height };
}

export function BrowserTab({
	id,
	adapter,
	visible,
	initialUrl,
	onOpened,
	onFailed,
	chrome = true,
}: BrowserTabProps) {
	const label = browserTabLabel(id);
	const boxRef = useRef<HTMLDivElement>(null);
	const [url, setUrl] = useState(initialUrl ?? '');
	const [draft, setDraft] = useState(initialUrl ?? '');
	const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
	// Whether Rust is holding a webview for this label. Not state: the position
	// sync reads it during layout, where a re-render has not happened yet.
	const opened = useRef(false);

	const place = useCallback(() => {
		const rect = boxRect(boxRef.current);
		if (!rect || !opened.current) {
			return;
		}
		void adapter.place(label, visible ? rect : hiddenRect(rect, window.innerHeight));
	}, [adapter, label, visible]);

	const go = useCallback(
		async (typed: string) => {
			const target = normalizeUrl(typed);
			if (target === '') {
				return;
			}
			const rect = boxRect(boxRef.current) ?? { x: 0, y: 0, width: 640, height: 480 };
			try {
				await adapter.open(
					label,
					target,
					visible ? rect : hiddenRect(rect, window.innerHeight)
				);
				opened.current = true;
				setUrl(target);
				setDraft(target);
				setRefusal(undefined);
				onOpened(id, urlHost(target));
			} catch (error) {
				// Rust holds the allow-list, and this is the only place its answer
				// is rendered. The UI never decides what is permitted.
				const reason = String(error);
				setRefusal({ url: target, reason });
				onFailed(id, reason);
			}
		},
		[adapter, id, label, onFailed, onOpened, visible]
	);

	/*
	 * The tab the agent opened already knows where it is going. A tab the dev
	 * opened does not, and shows an empty box with a focused address row until
	 * they say.
	 */
	useEffect(() => {
		if (initialUrl) {
			void go(initialUrl);
		}
		// Once, for the URL the tab was born with. Re-running on `go` would
		// re-navigate the page every time the dock was resized.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// The webview outlives every render but not the component: unpinning a tab,
	// or switching to a session that does not own it, destroys the page.
	useEffect(
		() => () => {
			void adapter.close(label);
			opened.current = false;
		},
		[adapter, label]
	);

	/*
	 * Position sync. `ResizeObserver` covers the dock drag, the collapse and the
	 * portrait flip in one, because all three change this box; the window
	 * listener covers a window move, which changes the box's screen position
	 * without changing its size.
	 */
	useLayoutEffect(() => {
		place();
		const box = boxRef.current;
		if (!box) {
			return;
		}
		const observer = new ResizeObserver(() => place());
		observer.observe(box);
		window.addEventListener('resize', place);
		window.addEventListener('scroll', place, true);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', place);
			window.removeEventListener('scroll', place, true);
		};
	}, [place]);

	// Escape, pressed with the caret inside the page. The init script sends it
	// up the navigation channel; this is where the ADE takes the keyboard back.
	useEffect(
		() =>
			adapter.onMessage((from, message) => {
				if (from === label && message === 'esc') {
					void adapter.returnFocus();
				}
			}),
		[adapter, label]
	);

	// A link the page followed to a host the allow-list refuses. The page stayed
	// where it was — Rust cancelled the navigation — so this only reports.
	useEffect(
		() =>
			adapter.onRefused((from, refusedUrl, reason) => {
				if (from === label) {
					setRefusal({ url: refusedUrl, reason });
				}
			}),
		[adapter, label]
	);

	return (
		<div className="ide-browser">
			{chrome ? (
			<form
				className="ide-browser-address"
				onSubmit={(event) => {
					event.preventDefault();
					void go(draft);
				}}
			>
				<input
					className="ide-browser-url"
					type="text"
					value={draft}
					spellCheck={false}
					autoComplete="off"
					aria-label="Address"
					placeholder="localhost:5173"
					onChange={(event) => setDraft(event.target.value)}
				/>
				{/*
				 * Reload and nothing else. No back and no forward: history is a
				 * state machine, and localhost browsing does not use one.
				 */}
				<button
					type="button"
					className="ide-browser-reload"
					aria-label="Reload the page"
					title="Reload"
					disabled={url === ''}
					onClick={() => void go(url)}
				>
					<Icon name="discard" />
				</button>
			</form>
			) : null}
			{refusal ? (
				<p className="ide-browser-refusal" role="status">
					<span>{refusal.reason}</span>
					<button
						type="button"
						className="ide-browser-external"
						onClick={() => {
							void adapter.openExternal(refusal.url);
							setRefusal(undefined);
						}}
					>
						Open in the OS browser
					</button>
				</p>
			) : null}
			{/*
			 * The box the page is painted over. Empty on purpose: anything drawn
			 * in here would be underneath the page and invisible the moment a
			 * URL loads. What it says is only ever seen before the first one.
			 */}
			<div className="ide-browser-page" ref={boxRef}>
				{url === '' ? (
					<p className="ide-browser-empty">
						{!adapter.isNative
							? 'A page needs the native window; there is none here under npm run dev.'
							: chrome
								? 'Type a URL. Localhost and file: URLs only.'
								: 'This panel has not loaded.'}
					</p>
				) : null}
			</div>
		</div>
	);
}
