// The source-control seam. The Changes UI talks to `ChangesProvider` and does
// not know whether the working tree is real. Slice 9 adds a git-backed
// implementation behind this same interface.

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface Change {
	/** Workspace-relative path, the same id space the Explorer uses. */
	readonly id: string;
	readonly name: string;
	readonly status: ChangeStatus;
	readonly staged: boolean;
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
	const listeners = new Set<() => void>();

	function emit(): void {
		for (const listener of listeners) {
			listener();
		}
	}

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
				name: seed.id.slice(seed.id.lastIndexOf('/') + 1),
				status: seed.status,
				staged: staged.has(seed.id),
			}));
		},
		async getDiff(id) {
			const seed = find(id);
			return {
				id: seed.id,
				name: seed.id.slice(seed.id.lastIndexOf('/') + 1),
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
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/*
 * ponytail: one implementation, chosen unconditionally. Unlike the workspace
 * there is no native counterpart yet — Slice 9 adds the git-backed provider
 * and the environment check alongside it.
 */
export function createChangesProvider(): ChangesProvider {
	return fixtureChangesProvider();
}
