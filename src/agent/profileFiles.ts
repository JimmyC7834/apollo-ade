// Where profiles and user tools come from, once they come from anywhere but
// the built-ins.
//
// An adapter, which is why it may call Tauri directly — the same licence
// `env.ts` has. Everything above it sees `loadProfileFiles()` and a list of
// problems; the parsing and merging it feeds is `profile.ts` and
// `userTools.ts`, which stay pure so they can be checked without a native
// shell.
//
// Two files, as decision 4 of
// docs/wayfinder/pi-harness/tickets/04-profile-data-model.md settled: a global
// one and a project one, project winning. They are **read, never written** —
// the profile editor is deliberately not built, so these are hand-authored in
// the editor this app already is.
//
// **The same two files carry the tool manifests.** Ticket 13 asked for
// "discovery follows the profile convention: a global file and a project file,
// project winning", and the same file satisfies that more literally than a
// parallel pair would: no second path to learn, no second write-protection
// entry in Rust, and — the part that matters — a tool and the profile that has
// to name it are authored side by side, which is what the opt-in rule makes
// necessary.

import { installProfiles } from './profile';
import { installUserTools } from './userTools';

/**
 * The project file, at the workspace root.
 *
 * *Not* inside `.ade/`, though the session store lives there and the symmetry
 * is tempting. Two things rule it out: `.ade/.gitignore` is `*`, so a profile
 * meant to be shared with the project would be untracked, and `list_tree` skips
 * `.ade` — so the file would be invisible in the explorer of the editor the user
 * is supposed to edit it in.
 */
const PROJECT_FILE = 'ade.profiles.json';

export interface ProfileLoad {
	/** Everything that was ignored, and why. Empty is the normal case. */
	readonly problems: readonly string[];
	/** Where the global file goes, so the UI can say it. */
	readonly globalPath?: string;
}

interface Declared {
	readonly profiles: unknown[];
	readonly tools: unknown[];
}

/**
 * Parse one file's worth of JSON into what it declares.
 *
 * Shape is `{ "profiles": [ ... ], "tools": [ ... ] }`, either key optional. A
 * bare array is accepted as profiles, because it is the obvious thing to write
 * and refusing it would teach nothing — and because it was the whole format
 * before tools arrived.
 */
function definitionsIn(text: string, source: string, problems: string[]): Declared {
	const nothing = { profiles: [], tools: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		problems.push(`${source} is not valid JSON: ${(cause as Error).message}`);
		return nothing;
	}
	if (Array.isArray(parsed)) {
		return { profiles: parsed, tools: [] };
	}
	if (typeof parsed !== 'object' || parsed === null) {
		problems.push(`${source}: expected { "profiles": [ ... ] }`);
		return nothing;
	}

	const list = (key: 'profiles' | 'tools'): unknown[] => {
		const value = (parsed as Record<string, unknown>)[key];
		if (value === undefined) {
			return [];
		}
		if (!Array.isArray(value)) {
			problems.push(`${source}: "${key}" must be an array`);
			return [];
		}
		return value;
	};

	if (!('profiles' in parsed) && !('tools' in parsed)) {
		// A file that declares neither is almost certainly a typo in a key name,
		// and silence would leave someone wondering why their profile did nothing.
		problems.push(`${source}: expected { "profiles": [ ... ] } or { "tools": [ ... ] }`);
	}
	return { profiles: list('profiles'), tools: list('tools') };
}

let sources: ProfileSources = { projectFile: PROJECT_FILE };

export interface ProfileSources {
	readonly globalPath?: string;
	readonly projectFile: string;
}

/**
 * Where profiles are read from, for the UI to say out loud.
 *
 * There is no profile editor by design, so the only way anyone learns where to
 * write one is being told. Remembered from the last load rather than asked for
 * again, because `/profile` is a synchronous branch.
 */
export function profileSources(): ProfileSources {
	return sources;
}

/**
 * Read both files and install what they define.
 *
 * Always resolves. A missing file is the normal state and not a problem; an
 * unreadable or malformed one is reported and skipped, and the profiles that
 * did parse still install — losing every profile because one file has a stray
 * comma would be a worse failure than the comma.
 *
 * Called after the workspace root is selected, because the project file is read
 * through the root-confined commands and there is no root before then.
 */
export async function loadProfileFiles(): Promise<ProfileLoad> {
	const problems: string[] = [];
	if (!('__TAURI_INTERNALS__' in globalThis)) {
		// Browser mode has no config directory and no root. The built-ins are
		// the whole set there, which is what `npm run dev` has always shown.
		return { problems };
	}

	const { invoke } = await import('@tauri-apps/api/core');
	const profiles: unknown[] = [];
	const tools: unknown[] = [];
	const collect = (text: string, source: string) => {
		const declared = definitionsIn(text, source, problems);
		profiles.push(...declared.profiles);
		tools.push(...declared.tools);
	};
	let globalPath: string | undefined;

	try {
		globalPath = await invoke<string>('global_profiles_path');
	} catch {
		// No config directory. Nothing to say about a file that cannot exist.
	}

	try {
		const text = await invoke<string | null>('read_global_profiles');
		if (text !== null) {
			collect(text, globalPath ?? 'the global profiles file');
		}
	} catch (cause) {
		problems.push(`could not read the global profiles file: ${reason(cause)}`);
	}

	// Second, so a project profile of the same name merges over the global one.
	try {
		const present = await invoke<unknown>('stat_path', { id: PROJECT_FILE });
		if (present !== null) {
			const text = await invoke<string>('read_file', { id: PROJECT_FILE });
			collect(text, PROJECT_FILE);
		}
	} catch (cause) {
		problems.push(`could not read ${PROJECT_FILE}: ${reason(cause)}`);
	}

	// Tools first. A profile naming a tool that has not been declared yet
	// refuses to activate, which would make the order of two lines decide
	// whether the user's own profile works.
	installUserTools(tools, problems);
	installProfiles(profiles, problems);
	sources = { globalPath, projectFile: PROJECT_FILE };
	return { problems, globalPath };
}

/** Rust rejections arrive as strings, not Errors. */
function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
