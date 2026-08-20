// Running plugins — tickets 72 and 73.
//
// ## What this is, in one line
//
// A plugin is **injected into our own document with our own authority**, and the
// object below is a *compatibility promise, not a fence*. `invoke` is on the
// global whether we hand it over or not, and nothing here pretends otherwise.
// `docs/adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md` is the
// decision; the two rules it turns on are enforced by the shape of `PluginApi`:
//
// 1. **Nothing but data crosses.** No component, no React, no controller state,
//    no DOM node is ever passed to a plugin.
// 2. **Everything is asynchronous**, including calls that could answer
//    instantly, and nothing returns a *function*. Both are what keep the move to
//    a sandboxed child webview available later: a synchronous getter and a
//    returned closure are the two things no transport can preserve, and either
//    one closes that door quietly.
//
// So `on` returns `Promise<void>` rather than a disposer. A plugin does not
// unregister its handlers; disabling the plugin drops all of them at once, which
// is the only granularity that survives a transport anyway.
//
// ## A module singleton, deliberately
//
// The host loads before React mounts, and `provider.ts` reaches it from outside
// the tree (ticket 73). Prop-drilling a boot-time singleton through the
// workbench would be a second way to say the same thing.

import { isTauri } from '../native.ts';
import {
	dropPlugin,
	isPluginEvent,
	registerHandler,
	setOnBreach,
	withDeadline,
	PLUGIN_EVENTS,
	type PluginEventName,
} from './hooks.ts';
import {
	evaluatePlugin,
	isEnabled,
	type Discovery,
	type LoadablePlugin,
	type PluginFailure,
} from './manifest.ts';

/** A command a plugin contributed. Data, plus the plugin's own callback. */
export interface ClaimedCommand {
	/** Namespaced by plugin, so two plugins cannot collide and provenance shows. */
	readonly id: string;
	readonly title: string;
	readonly category: string;
	readonly run: () => void;
}

/**
 * The six messages.
 *
 * `invoke`, `on` and `claim('command')` do something. `panel`, `relay`, `theme`
 * and every other claim kind are names that **reject**, naming the ticket that
 * will implement them — declared now rather than added later, because a plugin
 * author discovering the shape one message at a time cannot tell a feature that
 * has not landed from a misspelling.
 */
export interface PluginApi {
	invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
	on(event: string, handler: (payload: unknown) => unknown): Promise<void>;
	claim(kind: string, spec: unknown): Promise<void>;
	panel(url: string): Promise<void>;
	relay(payload: unknown): Promise<void>;
	theme(tokens: Record<string, string>): Promise<void>;
}

/** What the workbench renders. Plain data — see rule 1. */
export interface PluginState {
	/** Every folder found, loadable or not, so a broken one can still be seen. */
	readonly listed: readonly ListedPlugin[];
	readonly commands: readonly ClaimedCommand[];
	readonly failures: readonly PluginFailure[];
	readonly globalDir?: string;
	readonly localDir?: string;
}

export interface ListedPlugin {
	readonly id: string;
	readonly scope: 'global' | 'local';
	readonly name: string;
	readonly description: string;
	readonly dir: string;
	readonly enabled: boolean;
	/** Running now. False for a local plugin that is listed and inert. */
	readonly loaded: boolean;
	readonly reason?: string;
}

const EMPTY: PluginState = { listed: [], commands: [], failures: [] };

/** Which local plugins the user has enabled, keyed by their folder. */
const ENABLED_KEY = 'ade.plugins.enabled';

function readEnabled(): Record<string, string[]> {
	try {
		const raw = localStorage.getItem(ENABLED_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, string[]>)
			: {};
	} catch {
		return {};
	}
}

function writeEnabled(all: Record<string, string[]>): void {
	try {
		localStorage.setItem(ENABLED_KEY, JSON.stringify(all));
	} catch {
		// Quota or private mode. The plugin stays enabled for this session.
	}
}

/**
 * Load a plugin's script by making it a module.
 *
 * A blob URL and `import()`, which is the only way to get a real ES module out
 * of a string: the plugin gets `import`, top-level `await` and its own module
 * scope, exactly as though it had been served. The URL is revoked immediately —
 * the module graph holds its own reference once the import resolves.
 */
async function importModule(source: string): Promise<{ default?: unknown }> {
	const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
	try {
		return (await import(/* @vite-ignore */ url)) as { default?: unknown };
	} finally {
		URL.revokeObjectURL(url);
	}
}

function createHost() {
	const listeners = new Set<() => void>();
	let state: PluginState = EMPTY;

	function publish(next: PluginState): void {
		state = next;
		for (const listener of listeners) {
			listener();
		}
	}

	function notYet(message: string): Promise<never> {
		return Promise.reject(new Error(message));
	}

	/**
	 * `invoke` — every Rust command the ADE has, and no privileged path.
	 *
	 * A pass-through under a deadline. Root confinement, the gate and every other
	 * rule apply because the plugin is just another caller: nothing is added here
	 * and nothing is taken away. This is what keeps the supported surface at six
	 * messages instead of growing one per capability.
	 */
	async function callInvoke(
		plugin: LoadablePlugin,
		command: string,
		args?: Record<string, unknown>
	): Promise<unknown> {
		if (!isTauri()) {
			throw new Error('invoke is only available in the native window');
		}
		const { invoke } = await import('@tauri-apps/api/core');
		return withDeadline(invoke(command, args), `${plugin.id} invoking ${command}`);
	}

	/**
	 * A plugin that breached its deadline or threw. It stops, the session does not.
	 *
	 * Its handlers are already gone by the time this runs — `hooks.ts` drops them
	 * before reporting, so the failing handler cannot be called again on the way
	 * out. This removes what is left: its commands, and its claim to be running.
	 */
	function disable(pluginId: string, reason: string): void {
		dropPlugin(pluginId);
		const entry = state.listed.find((candidate) => candidate.id === pluginId);
		publish({
			...state,
			listed: state.listed.map((candidate) =>
				candidate.id === pluginId ? { ...candidate, loaded: false, reason } : candidate
			),
			commands: state.commands.filter((command) => !command.id.startsWith(`${pluginId}/`)),
			failures: [
				...state.failures,
				{
					id: pluginId,
					scope: entry?.scope ?? 'global',
					dir: entry?.dir ?? '',
					name: entry?.name ?? pluginId,
					reason,
				},
			],
		});
	}

	setOnBreach(disable);

	/**
	 * The object one plugin is handed.
	 *
	 * Built per plugin rather than shared, because everything a message does has
	 * to be attributable: a claim carries the claimant's id, and a failure names
	 * the plugin in Problems. A shared object would have to be told who was
	 * calling, which is the sort of thing a plugin can lie about.
	 */
	function apiFor(plugin: LoadablePlugin, claimed: ClaimedCommand[]): PluginApi {
		return {
			invoke: (command, args) => callInvoke(plugin, command, args),
			on: async (event, handler) => {
				// An unknown event name fails loudly. Silently registering a handler
				// that can never fire is the one outcome an author cannot debug, and
				// a typo and an event we do not deliver yet look identical from
				// inside a plugin — so the message names what we do deliver.
				if (!isPluginEvent(event)) {
					throw new Error(
						`no event called "${event}" — this ADE delivers ${PLUGIN_EVENTS.join(', ')}`
					);
				}
				registerHandler(plugin.id, event as PluginEventName, handler);
			},
			claim: async (kind, spec) => {
				if (kind !== 'command') {
					throw new Error(`claim("${kind}") is not available yet — tickets 75 and 76`);
				}
				claimed.push(commandFrom(plugin, spec));
			},
			panel: () => notYet('panel is not available yet — ticket 75'),
			relay: () => notYet('relay is not available yet — ticket 75'),
			theme: () => notYet('theme is not available yet — ticket 76'),
		};
	}

	/** Validate one command claim. A bad claim fails the plugin, loudly. */
	function commandFrom(plugin: LoadablePlugin, spec: unknown): ClaimedCommand {
		const record = (spec ?? {}) as Record<string, unknown>;
		const id = typeof record.id === 'string' ? record.id.trim() : '';
		const title = typeof record.title === 'string' ? record.title.trim() : '';
		const run = record.run;
		if (!id || !title || typeof run !== 'function') {
			throw new Error('a command claim needs an id, a title and a run function');
		}
		return {
			// Namespaced, so a plugin cannot shadow `view.browser` and two plugins
			// claiming `refresh` are two commands rather than a silent overwrite.
			id: `${plugin.id}/${id}`,
			title,
			// The plugin's own name, so the palette says where a command came from
			// without the plugin having to remember to.
			category: plugin.manifest.name,
			run: () => {
				try {
					void (run as () => unknown)();
				} catch (cause) {
					// A throwing command must not take the palette down with it.
					console.error(`plugin ${plugin.id} command failed`, cause);
				}
			},
		};
	}

	async function activate(
		plugin: LoadablePlugin,
		claimed: ClaimedCommand[]
	): Promise<string | undefined> {
		if (!plugin.source) {
			// Panel-only or theme-only. Nothing to run, and that is a whole plugin.
			return undefined;
		}
		try {
			const module = await importModule(plugin.source);
			if (typeof module.default !== 'function') {
				return `${plugin.manifest.script} has no default export to call`;
			}
			// Under the deadline like every other call into a plugin: a plugin that
			// never finishes activating would otherwise never let the ADE start.
			await withDeadline(
				Promise.resolve(
					(module.default as (api: PluginApi) => unknown)(apiFor(plugin, claimed))
				),
				`${plugin.id} loading`
			);
			return undefined;
		} catch (cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
	}

	async function load(): Promise<void> {
		if (!isTauri()) {
			// `npm run dev` has no native process, so there is nowhere for a plugin
			// folder to be. Not an error: the workbench runs without one.
			return;
		}
		const { invoke } = await import('@tauri-apps/api/core');
		let discovery: Discovery;
		try {
			discovery = await invoke<Discovery>('list_plugins');
		} catch (cause) {
			publish({
				...EMPTY,
				failures: [
					{
						id: 'plugins',
						scope: 'global',
						dir: '',
						name: 'Plugins',
						reason: `could not read the plugins folders: ${String(cause)}`,
					},
				],
			});
			return;
		}

		// A reload is a full reload — every handler the previous run installed goes
		// with it, or a plugin whose folder has been deleted keeps deciding.
		for (const previous of state.listed) {
			dropPlugin(previous.id);
		}

		const key = discovery.localDir ?? '';
		const enabledLocally = readEnabled()[key] ?? [];
		const listed: ListedPlugin[] = [];
		const failures: PluginFailure[] = [];
		const commands: ClaimedCommand[] = [];

		for (const found of discovery.plugins) {
			const verdict = evaluatePlugin(found);
			if (!verdict.ok) {
				failures.push(verdict.failure);
				listed.push({
					id: found.id,
					scope: found.scope,
					name: verdict.failure.name,
					description: '',
					dir: found.dir,
					enabled: isEnabled(found, enabledLocally),
					loaded: false,
					reason: verdict.failure.reason,
				});
				continue;
			}
			const { plugin } = verdict;
			const enabled = isEnabled(plugin, enabledLocally);
			const claimed: ClaimedCommand[] = [];
			// **Inert until enabled.** Nothing above this line ran any of the
			// plugin's code; nothing below it runs unless this is true.
			const reason = enabled ? await activate(plugin, claimed) : undefined;
			if (reason) {
				// A plugin can install handlers and *then* throw. Its claims are
				// discarded by not being pushed; its handlers have to be taken back
				// explicitly, or a plugin that failed to load keeps deciding.
				dropPlugin(plugin.id);
				failures.push({
					id: plugin.id,
					scope: plugin.scope,
					dir: plugin.dir,
					name: plugin.manifest.name,
					reason,
				});
			} else {
				commands.push(...claimed);
			}
			listed.push({
				id: plugin.id,
				scope: plugin.scope,
				name: plugin.manifest.name,
				description: plugin.manifest.description,
				dir: plugin.dir,
				enabled,
				loaded: enabled && !reason,
				...(reason ? { reason } : {}),
			});
		}

		publish({
			listed,
			commands,
			failures,
			globalDir: discovery.globalDir,
			...(discovery.localDir ? { localDir: discovery.localDir } : {}),
		});
	}

	return {
		/**
		 * Discover, and run what may run.
		 *
		 * Called twice by design, and this is the one place the ADR's "at boot,
		 * before React mounts" meets reality. Global plugins load at boot, when
		 * there is no workspace yet. A *local* plugin lives under a root, and
		 * there is no root until one has been opened — so the second call happens
		 * when the workbench adopts one. Reloading is a full reload: the previous
		 * state is replaced rather than merged, because a plugin whose folder has
		 * gone must stop contributing.
		 */
		load,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		snapshot(): PluginState {
			return state;
		},
		/** Turn a local plugin on or off for this root, and reload. */
		async setEnabled(id: string, enabled: boolean): Promise<void> {
			const key = state.localDir ?? '';
			const all = readEnabled();
			const current = new Set(all[key] ?? []);
			if (enabled) {
				current.add(id);
			} else {
				current.delete(id);
			}
			writeEnabled({ ...all, [key]: [...current] });
			// Disabling cannot un-run code that has already run, and pretending
			// otherwise would be the worse lie: the reload is what actually stops
			// it, and until then the plugin is still in the document.
			await load();
		},
	};
}

export const pluginHost = createHost();
