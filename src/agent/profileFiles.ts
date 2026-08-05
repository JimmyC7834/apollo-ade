// Where profiles come from, once they come from anywhere but the built-ins.
//
// An adapter, which is why it may call Tauri directly — the same licence
// `env.ts` has. Everything above it sees `loadProfileFiles()` and a list of
// problems; the parsing and merging it feeds is `profile.ts`, which stays pure
// so it can be checked without a native shell.
//
// Two files, as decision 4 of
// docs/wayfinder/pi-harness/tickets/04-profile-data-model.md settled: a global
// one and a project one, project winning. They are **read, never written** —
// the profile editor is deliberately not built, so these are hand-authored in
// the editor this app already is.

import { installProfiles } from './profile';

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

/**
 * Parse one file's worth of JSON into profile definitions.
 *
 * Shape is `{ "profiles": [ ... ] }`. A bare array is accepted too, because it
 * is the obvious thing to write and refusing it would teach nothing.
 */
function definitionsIn(text: string, source: string, problems: string[]): unknown[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		problems.push(`${source} is not valid JSON: ${(cause as Error).message}`);
		return [];
	}
	const list = Array.isArray(parsed)
		? parsed
		: typeof parsed === 'object' && parsed !== null
			? (parsed as { profiles?: unknown }).profiles
			: undefined;
	if (!Array.isArray(list)) {
		problems.push(`${source}: expected { "profiles": [ ... ] }`);
		return [];
	}
	return list;
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
	const definitions: unknown[] = [];
	let globalPath: string | undefined;

	try {
		globalPath = await invoke<string>('global_profiles_path');
	} catch {
		// No config directory. Nothing to say about a file that cannot exist.
	}

	try {
		const text = await invoke<string | null>('read_global_profiles');
		if (text !== null) {
			definitions.push(...definitionsIn(text, globalPath ?? 'the global profiles file', problems));
		}
	} catch (cause) {
		problems.push(`could not read the global profiles file: ${reason(cause)}`);
	}

	// Second, so a project profile of the same name merges over the global one.
	try {
		const present = await invoke<unknown>('stat_path', { id: PROJECT_FILE });
		if (present !== null) {
			const text = await invoke<string>('read_file', { id: PROJECT_FILE });
			definitions.push(...definitionsIn(text, PROJECT_FILE, problems));
		}
	} catch (cause) {
		problems.push(`could not read ${PROJECT_FILE}: ${reason(cause)}`);
	}

	installProfiles(definitions, problems);
	sources = { globalPath, projectFile: PROJECT_FILE };
	return { problems, globalPath };
}

/** Rust rejections arrive as strings, not Errors. */
function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
