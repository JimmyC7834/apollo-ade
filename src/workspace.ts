// The workspace seam. Feature code talks to `WorkspaceProvider` and never to
// Tauri directly, so the UI runs in a plain browser (`npm run dev`) against
// the fixture provider with no native process involved.

export interface WorkspaceEntry {
	readonly id: string;
	readonly name: string;
	readonly kind: 'file' | 'dir';
	readonly depth: number;
}

export interface WorkspaceFile {
	readonly id: string;
	readonly name: string;
	readonly content: string;
}

export interface SearchResult {
	/** Root-relative path of the containing file. */
	readonly id: string;
	readonly name: string;
	/** 1-based, so the editor can reveal it directly. */
	readonly line: number;
	readonly preview: string;
}

export interface WorkspaceSelection {
	readonly label: string;
	readonly path: string;
}

export interface WorkspaceProvider {
	/** False in the browser: there is no real folder to choose. */
	readonly canChooseWorkspace: boolean;
	chooseWorkspace(): Promise<WorkspaceSelection | undefined>;
	/** Re-select a previously chosen root by absolute path. */
	restoreWorkspace(path: string): Promise<WorkspaceSelection>;
	getTree(): Promise<readonly WorkspaceEntry[]>;
	getFiles(): Promise<readonly WorkspaceEntry[]>;
	readFile(id: string): Promise<WorkspaceFile>;
	writeFile(id: string, content: string): Promise<void>;
	/** Case-insensitive line search. The Search UI cannot tell which impl ran. */
	search(query: string): Promise<readonly SearchResult[]>;
}

const MAX_RESULTS = 500;

const FIXTURE: Record<string, string> = {
	'README.md': '# Fixture workspace\n\nBrowser mode. Run `npm run tauri dev` to open a real folder.\n',
	'src/main.ts': "console.log('hello from the fixture');\n",
	'src/util.ts': 'export const noop = (): void => {};\n',
};

function basename(id: string): string {
	return id.slice(id.lastIndexOf('/') + 1);
}

function fixtureProvider(): WorkspaceProvider {
	const entries: WorkspaceEntry[] = [
		{ id: 'src', name: 'src', kind: 'dir', depth: 0 },
		{ id: 'src/main.ts', name: 'main.ts', kind: 'file', depth: 1 },
		{ id: 'src/util.ts', name: 'util.ts', kind: 'file', depth: 1 },
		{ id: 'README.md', name: 'README.md', kind: 'file', depth: 0 },
	];
	// Writes stay in this object for the session, so the dirty/save workflow is
	// exercisable in the browser without a native process.
	const contents = { ...FIXTURE };
	return {
		canChooseWorkspace: false,
		async chooseWorkspace() {
			return undefined;
		},
		async restoreWorkspace(path) {
			return { label: 'fixture', path };
		},
		async getTree() {
			return entries;
		},
		async getFiles() {
			return entries.filter((entry) => entry.kind === 'file');
		},
		async readFile(id) {
			const content = contents[id];
			if (content === undefined) {
				throw new Error(`not found: ${id}`);
			}
			return { id, name: basename(id), content };
		},
		async writeFile(id, content) {
			if (contents[id] === undefined) {
				throw new Error(`not found: ${id}`);
			}
			contents[id] = content;
		},
		// Same rules as the native search: case-insensitive, line-oriented,
		// capped. It searches the fixture's own (possibly edited) contents.
		async search(query) {
			const needle = query.trim().toLowerCase();
			if (!needle) {
				return [];
			}
			const results: SearchResult[] = [];
			for (const entry of entries) {
				for (const [index, line] of (contents[entry.id] ?? '').split('\n').entries()) {
					if (results.length >= MAX_RESULTS) {
						return results;
					}
					if (line.toLowerCase().includes(needle)) {
						results.push({
							id: entry.id,
							name: entry.name,
							line: index + 1,
							preview: line.trim(),
						});
					}
				}
			}
			return results;
		},
	};
}

function tauriProvider(): WorkspaceProvider {
	const core = () => import('@tauri-apps/api/core');
	// `set_workspace` is idempotent: choosing and restoring are the same
	// canonicalize-and-store operation, only the source of the path differs.
	const select = async (path: string) =>
		(await core()).invoke<WorkspaceSelection>('set_workspace', { path });
	const tree = async () => (await core()).invoke<WorkspaceEntry[]>('list_tree');

	return {
		canChooseWorkspace: true,
		async chooseWorkspace() {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const picked = await open({ directory: true, multiple: false });
			return typeof picked === 'string' ? select(picked) : undefined;
		},
		restoreWorkspace: select,
		getTree: tree,
		async getFiles() {
			return (await tree()).filter((entry) => entry.kind === 'file');
		},
		async readFile(id) {
			const content = await (await core()).invoke<string>('read_file', { id });
			return { id, name: basename(id), content };
		},
		async writeFile(id, content) {
			await (await core()).invoke('write_file', { id, content });
		},
		async search(query) {
			return (await core()).invoke<SearchResult[]>('search_workspace', { query });
		},
	};
}

export function createWorkspaceProvider(): WorkspaceProvider {
	const isTauri = '__TAURI_INTERNALS__' in window;
	return isTauri ? tauriProvider() : fixtureProvider();
}
