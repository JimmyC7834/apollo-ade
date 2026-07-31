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
	readonly canChooseWorkspace: boolean;
	/**
	 * A workspace that exists without the user choosing one — the browser
	 * fixture. Undefined natively, where an empty workbench is the honest
	 * starting state.
	 */
	readonly defaultWorkspace?: WorkspaceSelection;
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
// The same policy numbers `workspace.rs` enforces. Duplicated deliberately:
// the browser cannot import the Rust constants, and a browser root has to obey
// the same rules or the two modes stop being the same app.
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_PREVIEW_CHARS = 200;
const IGNORED = new Set(['.git', 'node_modules', 'target', 'dist']);

declare global {
	interface Window {
		showDirectoryPicker?: (options?: {
			mode?: 'read' | 'readwrite';
		}) => Promise<FileSystemDirectoryHandle>;
	}
	// Present in every engine that ships the picker, but absent from lib.dom.
	interface FileSystemDirectoryHandle {
		entries(): AsyncIterableIterator<
			[string, FileSystemDirectoryHandle | FileSystemFileHandle]
		>;
	}
}

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
		defaultWorkspace: { label: 'Fixture', path: '' },
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

/**
 * Walk a chosen directory under the same policy as `workspace.rs`: ignored
 * directories skipped, depth capped, directories before files, names sorted.
 */
async function walkHandle(
	dir: FileSystemDirectoryHandle,
	prefix: string,
	depth: number,
	out: WorkspaceEntry[]
): Promise<void> {
	if (depth >= MAX_DEPTH) {
		return;
	}
	const children: [string, FileSystemDirectoryHandle | FileSystemFileHandle][] = [];
	for await (const child of dir.entries()) {
		children.push(child);
	}
	children.sort(([a], [b]) => a.localeCompare(b));

	for (const wantDir of [true, false]) {
		for (const [name, handle] of children) {
			const isDir = handle.kind === 'directory';
			if (isDir !== wantDir || (isDir && IGNORED.has(name))) {
				continue;
			}
			const id = prefix ? `${prefix}/${name}` : name;
			out.push({ id, name, kind: isDir ? 'dir' : 'file', depth });
			if (handle.kind === 'directory') {
				await walkHandle(handle, id, depth + 1, out);
			}
		}
	}
}

/**
 * Resolve a root-relative id to a file handle.
 *
 * Ids reach this from persisted state and from the editor, so the segment
 * check is a real boundary and not decoration — `getDirectoryHandle('..')`
 * throws, but rejecting it here keeps the rule stated in one place, the same
 * way `resolve` does in Rust.
 */
async function handleAt(
	root: FileSystemDirectoryHandle,
	id: string
): Promise<FileSystemFileHandle> {
	const parts = id.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) {
		throw new Error(`invalid path: ${id}`);
	}
	let dir = root;
	for (const part of parts.slice(0, -1)) {
		dir = await dir.getDirectoryHandle(part);
	}
	return dir.getFileHandle(parts[parts.length - 1]!);
}

/**
 * A real local folder in the browser, via the File System Access API.
 *
 * Deviation from the guide, made at the user's explicit request: Slice 4
 * assigns folder opening to the native layer specifically so the frontend is
 * never handed filesystem authority. Here it is, so every rule Rust enforces
 * has to be re-enforced in untrusted code — depth, ignored directories, the
 * 2 MiB cap, UTF-8 only, and no `..` in an id.
 *
 * Until a folder is chosen this delegates to the fixture, so browser mode
 * still boots into the deterministic workspace the guide relies on.
 */
function fileSystemAccessProvider(pick: NonNullable<Window['showDirectoryPicker']>) {
	const fixture = fixtureProvider();
	let root: FileSystemDirectoryHandle | undefined;

	async function read(id: string): Promise<string> {
		const file = await (await handleAt(root!, id)).getFile();
		if (file.size > MAX_FILE_BYTES) {
			throw new Error('file is larger than 2 MiB');
		}
		// Fatal decoding, so a binary file fails instead of arriving as
		// replacement characters and being saved back over the original.
		return new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
	}

	const provider: WorkspaceProvider = {
		canChooseWorkspace: true,
		defaultWorkspace: fixture.defaultWorkspace,

		async chooseWorkspace() {
			// Read/write up front: asking again at the first save would put a
			// permission prompt in the middle of the editor's save path.
			const picked = await pick({ mode: 'readwrite' }).catch(() => undefined);
			if (!picked) {
				return undefined; // The user dismissed the picker.
			}
			root = picked;
			// A handle exposes no real path, and it should not: `label` is all
			// the UI shows and all that goes into persisted state.
			return { label: picked.name, path: picked.name };
		},

		/*
		 * A directory handle cannot be rebuilt from a name. Re-granting one
		 * needs the handle kept in IndexedDB *and* a user gesture, so a reload
		 * honestly returns to the fixture rather than pretending to restore.
		 */
		async restoreWorkspace() {
			throw new Error('a browser folder cannot be restored automatically');
		},

		async getTree() {
			if (!root) {
				return fixture.getTree();
			}
			const out: WorkspaceEntry[] = [];
			await walkHandle(root, '', 0, out);
			return out;
		},

		async getFiles() {
			return (await provider.getTree()).filter((entry) => entry.kind === 'file');
		},

		async readFile(id) {
			if (!root) {
				return fixture.readFile(id);
			}
			return { id, name: basename(id), content: await read(id) };
		},

		async writeFile(id, content) {
			if (!root) {
				return fixture.writeFile(id, content);
			}
			if (new Blob([content]).size > MAX_FILE_BYTES) {
				throw new Error('file is larger than 2 MiB');
			}
			// `handleAt` will not create a file, matching `write_file` in Rust:
			// saving can overwrite, never bring a new path into existence.
			const writable = await (await handleAt(root, id)).createWritable();
			await writable.write(content);
			await writable.close();
		},

		async search(query) {
			if (!root) {
				return fixture.search(query);
			}
			const needle = query.trim().toLowerCase();
			if (!needle) {
				return [];
			}
			const results: SearchResult[] = [];
			for (const entry of await provider.getFiles()) {
				if (results.length >= MAX_RESULTS) {
					break;
				}
				let text: string;
				try {
					text = await read(entry.id);
				} catch {
					continue; // Too large or not text: not a search failure.
				}
				for (const [index, line] of text.split('\n').entries()) {
					if (results.length >= MAX_RESULTS) {
						break;
					}
					if (!line.toLowerCase().includes(needle)) {
						continue;
					}
					const trimmed = line.trim();
					results.push({
						id: entry.id,
						name: entry.name,
						line: index + 1,
						preview:
							trimmed.length > MAX_PREVIEW_CHARS
								? `${trimmed.slice(0, MAX_PREVIEW_CHARS)}…`
								: trimmed,
					});
				}
			}
			return results;
		},
	};
	return provider;
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
	if ('__TAURI_INTERNALS__' in window) {
		return tauriProvider();
	}
	// Firefox and Safari have no picker; there the fixture is the whole story.
	const pick = window.showDirectoryPicker?.bind(window);
	return pick ? fileSystemAccessProvider(pick) : fixtureProvider();
}
