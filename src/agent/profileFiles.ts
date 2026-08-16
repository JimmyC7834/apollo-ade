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

import { FIXTURE_PROFILES } from './canned';
import { installProfiles, listProfiles } from './profile';
import { isTauri } from '../native';
import { reloadTemplates, templateWarnings } from './promptTemplates';
import { reloadSkills } from './skills';
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
	/**
	 * Something true worth saying that is **not** a problem.
	 *
	 * Separate from `problems` because the two mean different things to a caller:
	 * a problem means the thing did not work and the surface stays open on it, and
	 * this means it worked and here is a caveat. Folding the browser-mode caveat
	 * into `problems` left Save reporting failure every time it succeeded.
	 */
	readonly note?: string;
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

/**
 * Which root the load now in flight is for — see `loadProfileFiles`.
 *
 * A module variable read *during* the install rather than an argument threaded
 * through four stores, because that is exactly when it is true: every store
 * notifies synchronously inside the load, so a listener asking here is asking
 * about the load that woke it. A runner in another root uses it to ignore the
 * change entirely.
 */
let loadingFor: string | undefined;

export function loadedRoot(): string | undefined {
	return loadingFor;
}

/**
 * The project file's contents as last read — the half of the two files this app
 * is allowed to write.
 *
 * The global file stays hand-authored. Editing a global profile from the modal
 * writes a *project* entry of the same name instead, which is not a workaround
 * but the merge rule the data model already has: project wins, field by field.
 * Writing the global file from a project's UI would let one repository change
 * what every other one runs under.
 */
/** What `ade.profiles.json` holds. Unparsed on purpose — see `definitionsIn`. */
interface ProjectFile {
	profiles: unknown[];
	tools: unknown[];
}

let project: ProjectFile = { profiles: [], tools: [] };

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
 *
 * @param root Which folder this load is *for*. **Load-bearing since ticket 49**:
 * a window holds sessions in several roots at once, and everything read here —
 * profiles, user tools, skills, prompt templates — is project-scoped. Without it,
 * focusing a conversation in one folder installed that folder's tool manifests
 * and skills into every other session's harness, including one confined to a
 * root the user had not opened this file from. Undefined means "everyone", which
 * is browser mode and the fixture.
 */
export async function loadProfileFiles(root?: string): Promise<ProfileLoad> {
	loadingFor = root;
	const problems: string[] = [];
	if (!isTauri()) {
		/*
		 * Browser mode has no config directory and no root, so its one extra
		 * profile is a fixture rather than a file — see `FIXTURE_PROFILES`, which
		 * exists because without a delegable profile the `task` tool can only ever
		 * answer that it has nobody to delegate to.
		 *
		 * It is installed *here* rather than in `createAgentProvider`, and the
		 * reason is React: that function runs inside a `useMemo` during
		 * `WorkbenchController`'s render, and installing notifies
		 * `onProfileChange` — whose subscriber is `ComposerBar`. Updating one
		 * component while rendering another is the warning that produced, and a
		 * store mutation belongs on the effect path this function is already on.
		 */
		installProfiles(FIXTURE_PROFILES, problems);
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
			const declared = definitionsIn(text, PROJECT_FILE, problems);
			// Held so `saveProfile` can rewrite this file without losing the tool
			// manifests beside the profiles, or the profiles it is not touching.
			project = { profiles: [...declared.profiles], tools: [...declared.tools] };
			profiles.push(...declared.profiles);
			tools.push(...declared.tools);
		} else {
			project = { profiles: [], tools: [] };
		}
	} catch (cause) {
		problems.push(`could not read ${PROJECT_FILE}: ${reason(cause)}`);
	}

	/*
	 * Skills are read here for two reasons, neither of them tidiness.
	 *
	 * **Order.** A profile naming a skill that has not been loaded yet fails
	 * `danglingReferences` and refuses to activate — the same argument that puts
	 * tools before profiles, one line down.
	 *
	 * **Timing.** Skills come off disk through the workspace commands, so they
	 * cannot be read before a root exists, and this function is already the thing
	 * that runs once a root does. It is also what `/reload` calls, which is how an
	 * edited `SKILL.md` reaches a running app without a restart.
	 */
	let skillsPath: string | undefined;
	try {
		skillsPath = await invoke<string>('global_skills_path');
	} catch {
		// No config directory. `/skills` then names only the project directory,
		// which is the honest answer rather than a path that does not exist.
	}
	await reloadSkills(skillsPath);

	/*
	 * The user's commands, read on the same trip and for the same two reasons —
	 * they come off disk through the workspace commands, and `/reload` is how an
	 * edited file reaches a running app.
	 *
	 * Its warnings *are* problems here, where a skill's are not: a shadowed or
	 * unparseable skill is reported by `/skills`, and there is no `/commands` to
	 * report a template. The completion menu is the listing, and a file missing
	 * from it says nothing about why.
	 */
	await reloadTemplates();
	problems.push(...templateWarnings());

	// Tools first. A profile naming a tool that has not been declared yet
	// refuses to activate, which would make the order of two lines decide
	// whether the user's own profile works.
	installUserTools(tools, problems);
	installProfiles(profiles, problems);
	sources = { globalPath, projectFile: PROJECT_FILE };
	return { problems, globalPath };
}

/**
 * Write one profile into the project file, and reload everything.
 *
 * The modal's whole persistence story, and it deliberately has no store of its
 * own: the file that a user hand-authors is the file the modal edits, so there
 * is one place a profile lives and `/reload` and the modal cannot disagree.
 * Reloading afterwards rather than patching the in-memory list means a saved
 * profile goes through exactly the parse and merge a cold start would give it —
 * a profile that would not survive a restart fails here, visibly, instead.
 *
 * In browser mode there is no root and no file. The profile is installed for
 * the session and the caller is told, because a Save that silently does nothing
 * across restarts is worse than one that says it did not.
 */
export async function saveProfile(
	/** The root being edited — `loadProfileFiles` says why it is carried. */
	root: string | undefined,
	definition: Record<string, unknown>
): Promise<ProfileLoad> {
	const name = definition.name;
	const kept = project.profiles.filter(
		(entry) => !(isRecord(entry) && entry.name === name)
	);
	const profiles = [...kept, definition];

	if (!isTauri()) {
		/*
		 * No root and no file, so the session's own list is the base — not
		 * `project.profiles`, which is empty here because nothing was ever read.
		 * Browser mode installs fixture profiles of its own (`canned.ts`), and
		 * saving over an empty base silently deleted them. A resolved profile is a
		 * valid definition, so re-installing the list is idempotent.
		 */
		const survivors = listProfiles().filter((existing) => existing.name !== name);
		return {
			problems: installProfiles([...survivors, definition]),
			note: 'Browser mode has no workspace file, so this profile lasts until the page reloads.',
		};
	}

	const { invoke } = await import('@tauri-apps/api/core');
	try {
		/*
		 * `write_file` overwrites and cannot create — `resolve` requires the target
		 * to exist, deliberately, so the editor cannot bring files into being by
		 * saving. That made the *first* save from this modal fail with "not found"
		 * every time, which is why no `ade.profiles.json` had ever existed: the
		 * only way to get one was to write it by hand.
		 *
		 * `create_file` is `create_new`, so this cannot truncate a file another
		 * window just wrote, and a failure here is left to the write below to
		 * report — if the file does exist, creating it was never needed.
		 */
		if ((await invoke<unknown>('stat_path', { id: PROJECT_FILE })) === null) {
			await invoke('create_file', { id: PROJECT_FILE }).catch(() => undefined);
		}
		await invoke('write_file', {
			id: PROJECT_FILE,
			// Two spaces and a trailing newline, because this file is meant to be
			// opened and edited by hand — it is the documented way to write one.
			content: `${JSON.stringify({ profiles, tools: project.tools }, null, 2)}\n`,
		});
	} catch (cause) {
		return { problems: [`could not write ${PROJECT_FILE}: ${reason(cause)}`] };
	}
	return await loadProfileFiles(root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rust rejections arrive as strings, not Errors. */
function reason(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
