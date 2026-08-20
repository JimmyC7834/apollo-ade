// A plugin's own page, and the channel between its two halves — ticket 75.
//
// ## Why a page rather than widgets
//
// Claims cover the chrome a plugin wants to *add* to what we draw. A panel
// covers everything else, and it is the answer to "as diverse as possible" for
// pixels with no widget vocabulary for us to design and then maintain forever.
// It costs almost nothing because slice 43 already built it: a panel is a child
// webview in a dock tab, exactly like a browser tab, pointed at `plugin://`
// instead of at localhost.
//
// A panel is **its own origin**. It cannot reach our DOM, it holds none of our
// Tauri capabilities, and it cannot import our components. What it can do is
// link `plugin://ade/tokens.css` and get the workbench's palette, spacing, type
// and row height — which is the honest version of "can a plugin use your
// components".
//
// ## `relay` is opaque, and that is the point
//
// The injected script and the panel have no direct channel; every byte passes
// through us either way. So we carry an arbitrary JSON payload between them and
// **never parse it**. Whatever protocol a plugin wants between its own halves is
// its business, and that is what stops our six messages growing for reasons that
// have nothing to do with us.
//
// The transport underneath is uneven — out of a page a message is a URL, and
// into one it is an evaluation — so the way out is cut into pieces by the init
// script and rejoined by `joinRelay` below. Neither half of the plugin ever
// learns that happened.

import { notifyPlugin } from './hooks.ts';

/** One panel the workbench is showing. Plain data, like everything else here. */
export interface OpenPanel {
	/** The artifact id — `panel:3`. Also, through `panelLabel`, the webview's. */
	readonly id: string;
	readonly pluginId: string;
	/** The plugin's name, which is what its dock tab is labelled with. */
	readonly title: string;
	/** `plugin://<scope>/<folder>/<file>`, built here and translated in Rust. */
	readonly url: string;
}

/**
 * What the workbench does about panels, registered rather than passed.
 *
 * The same seam `setBrowserHost` uses and for the same reason: a plugin is
 * loaded before React mounts, so the thing that opens dock tabs does not exist
 * yet when the plugin's `panel` call is written.
 */
export interface PanelHost {
	open(panel: Omit<OpenPanel, 'id'>): void;
	/** Deliver a payload into every panel this plugin has open. */
	deliver(pluginId: string, payload: unknown): void;
	/** Close them all — the plugin was disabled, failed, or was reloaded. */
	closeFor(pluginId: string): void;
}

let host: PanelHost | undefined;

/*
 * Panels asked for before the workbench existed.
 *
 * **Global plugins load before React mounts** — that is where ADR 0005 puts
 * injection — so a global plugin calling `panel` during activation is calling it
 * before there is a dock to put one in. Without this, the first thing a global
 * plugin does would fail it. The queue is drained the moment the controller
 * registers, which is the same frame the dock first renders.
 */
let waiting: Omit<OpenPanel, 'id'>[] = [];

export function setPanelHost(next: PanelHost | undefined): void {
	host = next;
	if (!host) {
		return;
	}
	const queued = waiting;
	waiting = [];
	for (const panel of queued) {
		host.open(panel);
	}
}

/**
 * `panel(url)` — a **relative path inside the plugin's own folder**.
 *
 * Relative, never a full URL. A plugin naming its own file is the whole of what
 * this message is for, and accepting a URL would mean deciding what to do with
 * `https://`, `file:` and another plugin's folder — three questions the ticket
 * did not ask and every one of which is a rule to keep for ever.
 */
export function panelUrl(
	plugin: { readonly scope: 'global' | 'local'; readonly dir: string },
	relative: string
): string {
	const folder = plugin.dir.split(/[\\/]/).filter(Boolean).pop() ?? '';
	const path = relative.replace(/^\.?\//, '').trim();
	if (!path || path.includes('..')) {
		throw new Error(`panel("${relative}") must name a file inside the plugin's own folder`);
	}
	return `plugin://${plugin.scope}/${folder}/${path}`;
}

export async function openPanel(
	plugin: {
		readonly id: string;
		readonly scope: 'global' | 'local';
		readonly dir: string;
		readonly manifest: { readonly name: string };
	},
	relative: string
): Promise<void> {
	const panel = {
		pluginId: plugin.id,
		title: plugin.manifest.name,
		// Built before the host is consulted, so a bad path fails the plugin that
		// wrote it whether or not the workbench is up yet.
		url: panelUrl(plugin, relative),
	};
	if (host) {
		host.open(panel);
	} else {
		waiting.push(panel);
	}
}

/** `relay(payload)` from the injected script, on its way to the plugin's panels. */
export async function relayToPanel(pluginId: string, payload: unknown): Promise<void> {
	if (!host) {
		throw new Error('relay is only available in the native window');
	}
	host.deliver(pluginId, payload);
}

/** Every panel a plugin has, gone at once. Disabling is all-or-nothing. */
export function closePanels(pluginId: string): void {
	// The queue as well as the open ones. A plugin disabled between asking for a
	// panel and the dock existing must not have it appear a moment later.
	waiting = waiting.filter((panel) => panel.pluginId !== pluginId);
	host?.closeFor(pluginId);
}

/*
 * The other direction.
 *
 * A page talks to us by asking to navigate to `ade-ipc:<message>`, which Rust
 * cancels and forwards. A URL is not a place to put a megabyte, so the init
 * script cuts the payload up and this puts it back together.
 */

const RELAY = /^relay:(\d+)\.(\d+)\.(\d+)\.(.*)$/s;

/** Partial payloads, keyed by the panel that is sending them and the sequence. */
export type Pending = Map<string, string[]>;

/**
 * Fold one `ade-ipc:` message into the pieces already collected.
 *
 * Returns the payload once the last piece arrives, and `undefined` while it is
 * still being assembled or when the message is not a relay at all — `esc` comes
 * up the same channel.
 *
 * **Out of order is not handled and does not need to be**: the init script sends
 * one chunk per task, in order, over a channel that preserves it. What *is*
 * handled is a page reloading mid-payload, because the sequence number restarts
 * and the old pieces are simply never completed. They are dropped when the panel
 * closes, along with the map.
 */
export function joinRelay(
	pending: Pending,
	label: string,
	message: string
): { readonly payload: unknown } | undefined {
	const match = RELAY.exec(message);
	if (!match) {
		return undefined;
	}
	const [, seq, index, total, body] = match;
	const key = `${label}/${seq}`;
	const pieces = pending.get(key) ?? new Array<string>(Number(total)).fill('');
	pieces[Number(index)] = body;
	pending.set(key, pieces);
	if (Number(index) + 1 < Number(total)) {
		return undefined;
	}
	pending.delete(key);
	try {
		return { payload: JSON.parse(decodeURIComponent(pieces.join(''))) as unknown };
	} catch {
		// A payload we cannot read is the plugin's problem and not a workbench
		// failure. It is dropped rather than thrown, because there is nobody in
		// the call stack to throw at — this arrives on a Tauri event.
		return undefined;
	}
}

/** Hand a rejoined payload to the plugin that owns the panel it came from. */
export async function deliverToPlugin(pluginId: string, payload: unknown): Promise<void> {
	await notifyPlugin(pluginId, 'relay', payload);
}
