// The source-control seam. The Changes UI talks to `ChangesProvider` and does
// not know whether the working tree is real: in the browser it is a fixture,
// under Tauri it is the installed `git` in the selected workspace.

import { basename } from './ids';
import { isTauri } from './native';

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface Change {
	/** Workspace-relative path, the same id space the Explorer uses. */
	readonly id: string;
	readonly name: string;
	readonly status: ChangeStatus;
	readonly staged: boolean;
	/**
	 * False where the change cannot be undone by restoring a previous version —
	 * an untracked or newly added file has none. The UI hides Revert instead of
	 * offering an action that would fail or delete the file.
	 */
	readonly revertable: boolean;
}

export interface ChangeDiff {
	readonly id: string;
	readonly name: string;
	/** Content at HEAD. Empty for an added file. */
	readonly original: string;
	/** Content in the working tree. Empty for a deleted file. */
	readonly modified: string;
}

export interface ChangesProvider {
	getChanges(): Promise<readonly Change[]>;
	getDiff(id: string): Promise<ChangeDiff>;
	stage(id: string): Promise<void>;
	unstage(id: string): Promise<void>;
	/** Destructive: drops the working-tree edit. Confirmed by the caller. */
	revert(id: string): Promise<void>;
	/** Fires whenever the change set moves. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void;
	/**
	 * Signal that something outside this provider moved the working tree — a
	 * file save, most importantly. Nothing here watches the filesystem.
	 */
	refresh(): void;
}

interface Seed {
	readonly id: string;
	readonly status: ChangeStatus;
	readonly original: string;
	readonly modified: string;
}

const SEED: readonly Seed[] = [
	{
		id: 'src/main.ts',
		status: 'modified',
		original: "console.log('hello');\n",
		modified: "console.log('hello from the fixture');\nexport {};\n",
	},
	{
		id: 'src/util.ts',
		status: 'added',
		original: '',
		modified: 'export const noop = (): void => {};\n',
	},
	{
		id: 'src/legacy.ts',
		status: 'deleted',
		original: 'export const old = 1;\n',
		modified: '',
	},
];

/**
 * Deterministic changes over an in-memory working tree.
 *
 * Staging and reverting mutate this object only; no repository is touched.
 * Reverting removes the entry entirely, which is what "the file matches HEAD
 * again" means for a change list.
 */
function fixtureChangesProvider(): ChangesProvider {
	let seeds = [...SEED];
	const staged = new Set<string>();
	const { subscribe, emit } = signal();

	function find(id: string): Seed {
		const seed = seeds.find((candidate) => candidate.id === id);
		if (!seed) {
			throw new Error(`no such change: ${id}`);
		}
		return seed;
	}

	return {
		async getChanges() {
			return seeds.map((seed) => ({
				id: seed.id,
				name: basename(seed.id),
				status: seed.status,
				staged: staged.has(seed.id),
				// Mirrors git: an addition has no earlier version to restore.
				revertable: seed.status !== 'added',
			}));
		},
		async getDiff(id) {
			const seed = find(id);
			return {
				id: seed.id,
				name: basename(seed.id),
				original: seed.original,
				modified: seed.modified,
			};
		},
		async stage(id) {
			find(id);
			staged.add(id);
			emit();
		},
		async unstage(id) {
			staged.delete(id);
			emit();
		},
		async revert(id) {
			find(id);
			seeds = seeds.filter((seed) => seed.id !== id);
			staged.delete(id);
			emit();
		},
		subscribe,
		// Nothing outside this provider can move an in-memory working tree, but
		// the interface is the same shape in both modes.
		refresh: emit,
	};
}

/**
 * Real repository state via the native layer.
 *
 * Every mutation re-emits rather than patching a local copy: git is the source
 * of truth and a single `git add` can move more than the row that was clicked.
 */
function gitChangesProvider(): ChangesProvider {
	const core = () => import('@tauri-apps/api/core');
	const { subscribe, emit } = signal();

	const mutate = async (command: string, id: string) => {
		await (await core()).invoke(command, { id });
		emit();
	};

	return {
		async getChanges() {
			return (await core()).invoke<Change[]>('git_changes');
		},
		async getDiff(id) {
			return (await core()).invoke<ChangeDiff>('git_diff', { id });
		},
		stage: (id) => mutate('git_stage', id),
		unstage: (id) => mutate('git_unstage', id),
		revert: (id) => mutate('git_revert', id),
		subscribe,
		refresh: emit,
	};
}

/** Shared listener set: both providers notify the same way. */
function signal() {
	const listeners = new Set<() => void>();
	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit() {
			for (const listener of listeners) {
				listener();
			}
		},
	};
}

export function createChangesProvider(): ChangesProvider {
	return isTauri() ? gitChangesProvider() : fixtureChangesProvider();
}
