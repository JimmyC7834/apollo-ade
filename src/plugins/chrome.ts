// What a plugin changes about the ADE itself — ticket 76.
//
// Two rungs of "modify the UI/UX", and **neither of them involves the plugin
// drawing anything**:
//
// - `theme(tokens)` — values for custom properties the workbench already has.
// - `claim('layout', …)` — hide, rename and reorder what already exists, by
//   public id.
//
// ## The third rung is not here, and will not be
//
// A plugin never **replaces** one of our components. ADR 0005 ruled it out and
// this file is where that shows: everything below is data about things we draw,
// and there is no way to express "draw this instead". Anything a plugin
// substituted would freeze at the moment of substitution, and the Shell Guide's
// focus order, keyboard model and accessibility contracts are ours to keep
// working. A plugin that wants its own transcript gets a panel next to ours
// (ticket 75), not instead of ours.
//
// ## A theme is values, never rules
//
// No selectors, no declarations, no stylesheet. A plugin that could put a rule
// into our document would be replacing components by another route — one
// `.ide-strip { display: none }` and the accessibility contracts are gone with
// no claim ever having been made. A plugin with a whole stylesheet has one: it
// is its panel's stylesheet.
//
// ## Only public ids
//
// `publicNames.ts` is the whole of what a layout claim may name, and an id
// outside it is refused rather than quietly ignored. An unknown id is a *visible
// failure* for the same reason: a plugin that hides `terminal` when we have
// renamed it must say so, or a rename on our side becomes a plugin that appears
// to work and does nothing.

// Through `publicNames.ts`, never around it. That file *is* the promise, and a
// layout claim is the one feature that turns an id into an API — importing the
// same names from where they happen to live would be the drift it exists to stop.
import {
	COMMAND_IDS,
	TOOL_ARTIFACTS,
	TOOL_ARTIFACT_IDS,
	showArtifactCommandId,
} from '../publicNames.ts';

/** Every id a layout claim may name. See `publicNames.ts` for what earns a place. */
export const PUBLIC_IDS: readonly string[] = [
	...TOOL_ARTIFACT_IDS,
	...TOOL_ARTIFACT_IDS.map(showArtifactCommandId),
	...Object.values(COMMAND_IDS),
];

/**
 * The way back, which no claim can take away.
 *
 * A plugin that hides everything it is allowed to is a plugin that has hidden
 * its own off switch. The Plugins artifact and the command that shows it are
 * therefore refused as claim targets — not silently kept, *refused*, so a plugin
 * trying it is told rather than left wondering why one line of its manifest did
 * nothing.
 */
export const PROTECTED_IDS: readonly string[] = [
	TOOL_ARTIFACTS.plugins.id,
	showArtifactCommandId(TOOL_ARTIFACTS.plugins.id),
];

export interface LayoutClaim {
	readonly pluginId: string;
	readonly pluginName: string;
	readonly hide: readonly string[];
	readonly rename: Readonly<Record<string, string>>;
	/** Ids in the order they should appear. Anything unnamed keeps its place after. */
	readonly order: readonly string[];
}

export interface ThemeClaim {
	readonly pluginId: string;
	readonly pluginName: string;
	readonly tokens: Readonly<Record<string, string>>;
}

/**
 * A value, and nothing that could be a rule.
 *
 * Braces and semicolons are the whole of what turns a declaration into a
 * stylesheet, and `<` is what turns it into markup. Refusing them is a blunt
 * test and it is the right kind of blunt: there is no legal token value that
 * needs any of them, so nothing honest is lost.
 */
const NOT_A_VALUE = /[{};<>]/;

export function declareTheme(
	plugin: { readonly id: string; readonly manifest: { readonly name: string } },
	tokens: unknown,
	/** Whether the workbench actually defines this custom property. */
	isDefined: (name: string) => boolean
): ThemeClaim {
	if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) {
		throw new Error('theme takes an object of token names and values');
	}
	const accepted: Record<string, string> = {};
	for (const [name, value] of Object.entries(tokens as Record<string, unknown>)) {
		if (!name.startsWith('--')) {
			throw new Error(`theme("${name}") is not a token; every token name starts with --`);
		}
		if (typeof value !== 'string' || value.trim() === '') {
			throw new Error(`the token ${name} needs a value, saw ${JSON.stringify(value)}`);
		}
		if (NOT_A_VALUE.test(value)) {
			throw new Error(
				`the token ${name} carries a rule rather than a value; a theme sets values and ` +
					'a stylesheet belongs to a panel'
			);
		}
		if (!isDefined(name)) {
			throw new Error(`${name} is not a token this ADE defines`);
		}
		accepted[name] = value.trim();
	}
	return { pluginId: plugin.id, pluginName: plugin.manifest.name, tokens: accepted };
}

export function declareLayout(
	plugin: { readonly id: string; readonly manifest: { readonly name: string } },
	spec: unknown
): LayoutClaim {
	const record = (spec ?? {}) as Record<string, unknown>;
	const names = (raw: unknown, field: string): string[] => {
		if (raw === undefined) {
			return [];
		}
		if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
			throw new Error(`a layout claim's "${field}" is a list of ids`);
		}
		return raw as string[];
	};

	const hide = names(record.hide, 'hide');
	const order = names(record.order, 'order');
	const renameRaw = (record.rename ?? {}) as Record<string, unknown>;
	if (typeof renameRaw !== 'object' || renameRaw === null || Array.isArray(renameRaw)) {
		throw new Error('a layout claim\'s "rename" maps an id to a title');
	}
	const rename: Record<string, string> = {};
	for (const [id, title] of Object.entries(renameRaw)) {
		if (typeof title !== 'string' || title.trim() === '') {
			throw new Error(`renaming ${id} needs a title, saw ${JSON.stringify(title)}`);
		}
		rename[id] = title.trim();
	}

	for (const id of [...hide, ...order, ...Object.keys(rename)]) {
		if (PROTECTED_IDS.includes(id)) {
			throw new Error(
				`${id} is the way back to the plugin list and cannot be hidden, renamed or moved`
			);
		}
		if (!PUBLIC_IDS.includes(id)) {
			throw new Error(
				`${id} is not an id a plugin may name — see the public names this ADE promises`
			);
		}
	}

	return { pluginId: plugin.id, pluginName: plugin.manifest.name, hide, rename, order };
}

/*
 * The stores. Whole replacement on every load, like the tool store, so a plugin
 * that has been disabled or has failed stops changing the chrome.
 */

let themes: readonly ThemeClaim[] = [];
let layouts: readonly LayoutClaim[] = [];
const listeners = new Set<() => void>();

export function onChromeChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function installChrome(
	nextThemes: readonly ThemeClaim[],
	nextLayouts: readonly LayoutClaim[]
): void {
	themes = nextThemes;
	layouts = nextLayouts;
	for (const listener of listeners) {
		listener();
	}
}

export function themeClaims(): readonly ThemeClaim[] {
	return themes;
}

export function layoutClaims(): readonly LayoutClaim[] {
	return layouts;
}

/**
 * Every plugin's tokens, folded into one map.
 *
 * **Last enabled wins**, which is the boring rule the ticket asked for: plugins
 * load in folder order, so the later one overwrites, and there are no precedence
 * weights to reason about. What is not boring is a conflict going unseen, so
 * every token two plugins both set comes back beside the values, for Problems to
 * show.
 */
export function mergeTokens(claims: readonly ThemeClaim[]): {
	readonly tokens: Readonly<Record<string, string>>;
	readonly conflicts: readonly string[];
} {
	const tokens: Record<string, string> = {};
	const owner: Record<string, string> = {};
	const conflicts: string[] = [];
	for (const claim of claims) {
		for (const [name, value] of Object.entries(claim.tokens)) {
			if (owner[name] !== undefined && owner[name] !== claim.pluginName) {
				conflicts.push(
					`${claim.pluginName} and ${owner[name]} both set ${name}; ${claim.pluginName} wins`
				);
			}
			tokens[name] = value;
			owner[name] = claim.pluginName;
		}
	}
	return { tokens, conflicts };
}

/** One thing a layout claim can act on: anything with an id and a title. */
export interface Titled {
	readonly id: string;
	readonly title: string;
}

/**
 * Hide, rename and reorder a list of things we draw.
 *
 * One function for strip items, dock tabs and command centre entries, because
 * all three are lists of `{ id, title }` rendered by our own components — which
 * is what makes this ticket a data change rather than new machinery.
 *
 * Order is a *pull to the front*, not a permutation: named ids come first in the
 * order they were named, everything else keeps its relative place behind them.
 * A permutation would need a plugin to name every id there is, and it would go
 * wrong the day we add one.
 */
export function applyLayout<T extends Titled>(
	items: readonly T[],
	claims: readonly LayoutClaim[]
): T[] {
	const hidden = new Set(claims.flatMap((claim) => claim.hide));
	const titles: Record<string, string> = {};
	const order: string[] = [];
	for (const claim of claims) {
		Object.assign(titles, claim.rename);
		for (const id of claim.order) {
			if (!order.includes(id)) {
				order.push(id);
			}
		}
	}

	const kept = items
		.filter((item) => !hidden.has(item.id))
		.map((item) => (titles[item.id] ? { ...item, title: titles[item.id] } : item));
	if (order.length === 0) {
		return kept;
	}
	const rank = (item: T) => {
		const at = order.indexOf(item.id);
		return at === -1 ? order.length : at;
	};
	// A stable sort, which every engine has given since ES2019 — that is what
	// keeps "everything else keeps its relative place" true.
	return [...kept].sort((left, right) => rank(left) - rank(right));
}
