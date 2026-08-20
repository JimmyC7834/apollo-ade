// What a plugin says about itself, and whether we believe it.
//
// Pure on purpose: everything here is text in and a verdict out, so the rules
// that decide whether a folder runs foreign code can be checked under bare
// `node` without a window, a filesystem or a Tauri process. `host.ts` is the
// half that does IO.
//
// `docs/adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md` is the
// decision this implements.

/**
 * The one integer that is the whole compatibility mechanism.
 *
 * No semver, no ranges, no lockfile, no registry. Bump it when a name in
 * `publicNames.ts` is renamed, or when one of the six messages changes shape.
 */
export const API_VERSION = 1;

/** The entry points a manifest may name. A plugin needs at least one. */
export const ENTRY_POINTS = ['script', 'panel', 'theme'] as const;
export type EntryPoint = (typeof ENTRY_POINTS)[number];

export interface PluginManifest {
	readonly name: string;
	readonly description: string;
	readonly api: number;
	/** Injected into our document — the code half. */
	readonly script?: string;
	/** A page of the plugin's own, in a child webview — ticket 75. */
	readonly panel?: string;
	/** Token values — ticket 76. */
	readonly theme?: string;
}

/** What Rust found in one folder. Mirrors `plugins.rs::DiscoveredPlugin`. */
export interface DiscoveredPlugin {
	readonly id: string;
	readonly scope: 'global' | 'local';
	readonly folder: string;
	readonly dir: string;
	readonly manifest?: string | null;
	readonly script?: string | null;
	readonly error?: string | null;
}

/** Everything discovery found, plus where to put more. */
export interface Discovery {
	readonly globalDir: string;
	readonly localDir?: string | null;
	readonly plugins: readonly DiscoveredPlugin[];
}

/**
 * A plugin that may run, or one that may not and why.
 *
 * There is no third state. A folder is either loadable or it is a line in
 * Problems — "loadable but with a warning" is how a broken plugin ends up half
 * running, and a plugin that half ran is worse than one that did not.
 */
export type PluginVerdict =
	| { readonly ok: true; readonly plugin: LoadablePlugin }
	| { readonly ok: false; readonly failure: PluginFailure };

export interface LoadablePlugin {
	readonly id: string;
	readonly scope: 'global' | 'local';
	readonly dir: string;
	readonly manifest: PluginManifest;
	/** Present when the manifest named a `script`. */
	readonly source?: string;
}

export interface PluginFailure {
	readonly id: string;
	readonly scope: 'global' | 'local';
	readonly dir: string;
	/** The manifest's `name` where we got that far, otherwise the folder's. */
	readonly name: string;
	/** One sentence, as it will read in Problems. */
	readonly reason: string;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Parse and validate a `plugin.json`.
 *
 * The `api` message names **both** numbers, which is the whole point of having
 * an integer: "this plugin is not compatible" tells the author nothing they can
 * act on, and "wants 2, this ADE speaks 1" tells them everything.
 */
export function parseManifest(source: string): { manifest: PluginManifest } | { reason: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch (cause) {
		return { reason: `plugin.json is not valid JSON: ${(cause as Error).message}` };
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { reason: 'plugin.json is not an object' };
	}
	const record = raw as Record<string, unknown>;
	const name = text(record.name);
	if (!name) {
		return { reason: 'plugin.json has no name' };
	}
	const api = record.api;
	if (typeof api !== 'number' || !Number.isInteger(api)) {
		return { reason: 'plugin.json has no integer api' };
	}
	if (api !== API_VERSION) {
		return {
			reason: `${name} was written for plugin api ${api}; this ADE speaks ${API_VERSION}`,
		};
	}
	const entries = ENTRY_POINTS.filter((entry) => text(record[entry]) !== undefined);
	if (entries.length === 0) {
		// A manifest with no entry point is a folder that would load and then do
		// nothing at all, which is indistinguishable from a typo in the field name.
		return { reason: `${name} names no script, panel or theme` };
	}
	return {
		manifest: {
			name,
			description: text(record.description) ?? '',
			api,
			...Object.fromEntries(entries.map((entry) => [entry, text(record[entry])])),
		},
	};
}

/**
 * The whole verdict for one discovered folder.
 *
 * Order matters: a folder Rust could not read never reaches the parser, because
 * "cannot read plugin.json" is a better sentence than "plugin.json is not valid
 * JSON" for a file that is not there.
 */
export function evaluatePlugin(found: DiscoveredPlugin): PluginVerdict {
	const fail = (name: string, reason: string): PluginVerdict => ({
		ok: false,
		failure: { id: found.id, scope: found.scope, dir: found.dir, name, reason },
	});
	if (found.error) {
		return fail(found.folder, found.error);
	}
	if (!found.manifest) {
		return fail(found.folder, 'cannot read plugin.json');
	}
	const parsed = parseManifest(found.manifest);
	if ('reason' in parsed) {
		return fail(found.folder, parsed.reason);
	}
	const { manifest } = parsed;
	// Rust reads the script when the manifest names one, so a named script with
	// no source is a file that is not there — and the manifest is the thing that
	// is wrong, not the folder.
	if (manifest.script && !found.script) {
		return fail(manifest.name, `cannot read ${manifest.script}`);
	}
	return {
		ok: true,
		plugin: {
			id: found.id,
			scope: found.scope,
			dir: found.dir,
			manifest,
			...(found.script ? { source: found.script } : {}),
		},
	};
}

/**
 * Whether a discovered plugin is allowed to run right now.
 *
 * **The sharpest edge in the design, and it is one line.** A global plugin runs
 * because putting a folder in the app-data directory *is* the trust decision. A
 * local plugin — one that arrived with a repository — runs only after somebody
 * enabled it for that root. Cloning a repository must never be the same act as
 * running its author's code.
 */
export function isEnabled(
	plugin: { readonly id: string; readonly scope: 'global' | 'local' },
	enabledLocally: readonly string[]
): boolean {
	return plugin.scope === 'global' || enabledLocally.includes(plugin.id);
}
