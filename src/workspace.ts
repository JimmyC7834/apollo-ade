// The workspace seam. Feature code talks to `WorkspaceProvider` and never to
// Tauri directly, so the UI runs in a plain browser (`npm run dev`) against
// the fixture provider with no native process involved.

import type { DeletePlan } from './features/explorer/fileOperations';
import { basename, dirname } from './ids';
import { isTauri } from './native';

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
	/**
	 * Re-select whatever root was last chosen. Deliberately takes no path: the
	 * provider is the side that knows which folder the user answered a dialog
	 * with, and persisted state is not evidence of that.
	 */
	restoreWorkspace(): Promise<WorkspaceSelection>;
	/**
	 * Roots this app has already been given, most recent first. Rust owns the
	 * list; this only reads it.
	 */
	recentWorkspaces(): Promise<readonly WorkspaceSelection[]>;
	getTree(): Promise<readonly WorkspaceEntry[]>;
	getFiles(): Promise<readonly WorkspaceEntry[]>;
	readFile(id: string): Promise<WorkspaceFile>;
	writeFile(id: string, content: string): Promise<void>;
	/** Case-insensitive line search. The Search UI cannot tell which impl ran. */
	search(query: string): Promise<readonly SearchResult[]>;

	/**
	 * Whether a delete is recoverable afterwards.
	 *
	 * A property of the workspace rather than of this app: natively it is the OS
	 * trash, and the browser fixture has nowhere to put anything. The dialog says
	 * whichever is true, because "you can put it back" is the sentence in it that
	 * changes what someone decides.
	 */
	readonly deletesToTrash: boolean;
	/*
	 * Ticket 29's operations. They are on the provider rather than invoked
	 * directly because that is what makes them work in the browser at all — and
	 * the rule from ticket 10 is that a mode which cannot do something says so,
	 * rather than succeeding at nothing.
	 */
	createFile(id: string): Promise<void>;
	createFolder(id: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** What a delete would take. Reads only; nothing has happened yet. */
	deletePlan(id: string): Promise<DeletePlan>;
	deleteEntry(id: string): Promise<void>;
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

/**
 * The browser-mode disk. Exported because the agent's in-memory `ExecutionEnv`
 * reads from the same map — if the explorer and the agent disagreed about what
 * exists, dev mode would be lying about one of them.
 */
export const FIXTURE: Record<string, string> = {
	'README.md': '# Fixture workspace\n\nBrowser mode. Run `npm run tauri dev` to open a real folder.\n',
	'src/main.ts': "console.log('hello from the fixture');\n",
	'src/util.ts': 'export const noop = (): void => {};\n',
};

/**
 * The fixture's tree, derived rather than maintained.
 *
 * It was a hand-written array until ticket 29 let the explorer create and delete
 * things — at which point an array and a content map would have been two records
 * of the same fact, disagreeing the moment one of them was edited.
 *
 * The ordering is `walk`'s in `workspace.rs`: directories before files at every
 * level, alphabetical within each, parents before their children.
 */
function fixtureEntries(
	files: readonly string[],
	folders: ReadonlySet<string>
): readonly WorkspaceEntry[] {
	// A folder exists if it was created or if something is in it.
	const dirs = new Set(folders);
	for (const id of files) {
		for (let parent = dirname(id); parent; parent = dirname(parent)) {
			dirs.add(parent);
		}
	}
	const nodes = [
		...[...dirs].map((id) => ({ id, kind: 'dir' as const })),
		...files.map((id) => ({ id, kind: 'file' as const })),
	];

	const out: WorkspaceEntry[] = [];
	function emit(parent: string | undefined, depth: number): void {
		const here = nodes
			.filter((node) => dirname(node.id) === parent)
			.sort((a, b) =>
				a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'dir' ? -1 : 1
			);
		for (const node of here) {
			out.push({ id: node.id, name: basename(node.id), kind: node.kind, depth });
			if (node.kind === 'dir') {
				emit(node.id, depth + 1);
			}
		}
	}
	emit(undefined, 0);
	return out;
}

function fixtureProvider(): WorkspaceProvider {
	// Writes stay in this object for the session, so the dirty/save workflow is
	// exercisable in the browser without a native process.
	const contents = { ...FIXTURE };
	// Only the empty ones need recording; the rest are implied by their contents.
	const folders = new Set<string>();
	const entries = () => fixtureEntries(Object.keys(contents), folders);

	/** Every id at or under `id`, which is what a folder operation acts on. */
	const under = (id: string) =>
		Object.keys(contents).filter((key) => key === id || key.startsWith(`${id}/`));

	return {
		canChooseWorkspace: false,
		// In memory, and gone when it goes.
		deletesToTrash: false,
		defaultWorkspace: { label: 'Fixture', path: '' },
		async chooseWorkspace() {
			return undefined;
		},
		async restoreWorkspace() {
			return { label: 'fixture', path: '' };
		},
		// The fixture is the only root there is, so the recent list is it.
		async recentWorkspaces() {
			return [{ label: 'Fixture', path: '' }];
		},
		async getTree() {
			return entries();
		},
		async getFiles() {
			return entries().filter((entry) => entry.kind === 'file');
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

		/*
		 * Ticket 29 against the fixture. The rule from ticket 10 is support it or
		 * refuse it out loud, and support is the better half of that here: it is
		 * in memory, it costs thirty lines, and it is the only way this app's file
		 * operations can be looked at without a native window.
		 */
		async createFile(id) {
			if (contents[id] !== undefined || folders.has(id)) {
				throw new Error('something with that name is already there');
			}
			contents[id] = '';
		},
		async createFolder(id) {
			if (contents[id] !== undefined || folders.has(id)) {
				throw new Error('something with that name is already there');
			}
			folders.add(id);
		},
		async rename(from, to) {
			if (contents[to] !== undefined || folders.has(to)) {
				throw new Error('something with that name is already there');
			}
			const moving = under(from);
			if (moving.length === 0 && !folders.has(from)) {
				throw new Error(`not found: ${from}`);
			}
			for (const id of moving) {
				contents[`${to}${id.slice(from.length)}`] = contents[id]!;
				delete contents[id];
			}
			for (const id of [...folders].filter((f) => f === from || f.startsWith(`${from}/`))) {
				folders.delete(id);
				folders.add(`${to}${id.slice(from.length)}`);
			}
		},
		async deletePlan(id) {
			if (contents[id] !== undefined) {
				return { kind: 'file', entries: 0, capped: false };
			}
			const inside = entries().filter((entry) => entry.id.startsWith(`${id}/`));
			return { kind: 'directory', entries: inside.length, capped: false };
		},
		async deleteEntry(id) {
			for (const key of under(id)) {
				delete contents[key];
			}
			for (const folder of [...folders].filter((f) => f === id || f.startsWith(`${id}/`))) {
				folders.delete(folder);
			}
		},

		// Same rules as the native search: case-insensitive, line-oriented,
		// capped. It searches the fixture's own (possibly edited) contents.
		async search(query) {
			const needle = query.trim().toLowerCase();
			if (!needle) {
				return [];
			}
			const results: SearchResult[] = [];
			for (const entry of entries()) {
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
	return (await parentOf(root, id)).getFileHandle(parts[parts.length - 1]!);
}

/**
 * The directory an id lives in, under the same segment rule as `handleAt`.
 *
 * `create` is what the explorer's new-file needs and what saving must never
 * have: `writeFile` can only overwrite, so a typo in a restored editor id
 * cannot conjure a directory tree on the way to writing nothing anyone asked
 * for.
 */
async function parentOf(
	root: FileSystemDirectoryHandle,
	id: string,
	create = false
): Promise<FileSystemDirectoryHandle> {
	const parts = id.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) {
		throw new Error(`invalid path: ${id}`);
	}
	let dir = root;
	for (const part of parts.slice(0, -1)) {
		dir = await dir.getDirectoryHandle(part, { create });
	}
	return dir;
}

/** Whether anything at all is already at `id`, file or directory. */
async function takenAt(root: FileSystemDirectoryHandle, id: string): Promise<boolean> {
	const dir = await parentOf(root, id);
	const name = basename(id);
	for (const check of [dir.getFileHandle(name), dir.getDirectoryHandle(name)]) {
		try {
			await check;
			return true;
		} catch {
			// Absent, which is the answer this is looking for.
		}
	}
	return false;
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
		// The browser has no trash either way; with a real root, delete is refused
		// outright rather than done unrecoverably.
		deletesToTrash: false,
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

		/*
		 * Same reason as `restoreWorkspace`: a directory handle cannot be
		 * rebuilt from a name, so there is nothing a recent list could hold that
		 * would actually reopen. Whatever is chosen this session is all there is.
		 */
		async recentWorkspaces() {
			return root ? [{ label: root.name, path: root.name }] : [];
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

		/*
		 * Ticket 29 against a real browser-picked folder. Creating is supported;
		 * renaming and deleting are refused, and for two different reasons.
		 *
		 * Rename has no portable API — `FileSystemHandle.move` is Chromium-only
		 * and recent — so there is nothing to call.
		 *
		 * Delete has an API, `removeEntry({ recursive: true })`, and is refused
		 * anyway. The ticket asked for recoverable over confirmed and the browser
		 * has no trash, so implementing it here would put the app's one
		 * unrecoverable action behind its least-tested provider, on a folder the
		 * user picked out of their real filesystem. A refusal is worse UI and
		 * better behaviour.
		 */
		async createFile(id) {
			if (!root) {
				return fixture.createFile(id);
			}
			if (await takenAt(root, id)) {
				throw new Error('something with that name is already there');
			}
			await (await parentOf(root, id, true)).getFileHandle(basename(id), { create: true });
		},
		async createFolder(id) {
			if (!root) {
				return fixture.createFolder(id);
			}
			if (await takenAt(root, id)) {
				throw new Error('something with that name is already there');
			}
			await (await parentOf(root, id, true)).getDirectoryHandle(basename(id), { create: true });
		},
		async rename(from, to) {
			if (!root) {
				return fixture.rename(from, to);
			}
			throw new Error('a browser folder cannot be renamed in — open it natively');
		},
		async deletePlan(id) {
			if (!root) {
				return fixture.deletePlan(id);
			}
			throw new Error('deleting is native-only: the browser has no trash to put it in');
		},
		async deleteEntry(id) {
			if (!root) {
				return fixture.deleteEntry(id);
			}
			throw new Error('deleting is native-only: the browser has no trash to put it in');
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
	const tree = async () => (await core()).invoke<WorkspaceEntry[]>('list_tree');

	return {
		canChooseWorkspace: true,
		deletesToTrash: true,
		/*
		 * The folder dialog runs in Rust, not here. Rust is the filesystem
		 * authority, so it is also the only side that gets to learn a root:
		 * neither command below takes a path, and there is nothing this
		 * provider could send that would widen what the app can reach.
		 */
		async chooseWorkspace() {
			const picked = await (await core()).invoke<WorkspaceSelection | null>('choose_workspace');
			return picked ?? undefined;
		},
		async restoreWorkspace() {
			return (await core()).invoke<WorkspaceSelection>('restore_workspace');
		},
		async recentWorkspaces() {
			return (await core()).invoke<WorkspaceSelection[]>('recent_workspaces');
		},
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
		async createFile(id) {
			await (await core()).invoke('create_file', { id });
		},
		async createFolder(id) {
			await (await core()).invoke('create_folder', { id });
		},
		async rename(from, to) {
			await (await core()).invoke('rename_entry', { from, to });
		},
		async deletePlan(id) {
			return (await core()).invoke<DeletePlan>('delete_plan', { id });
		},
		async deleteEntry(id) {
			await (await core()).invoke('delete_entry', { id });
		},
	};
}

export function createWorkspaceProvider(): WorkspaceProvider {
	if (isTauri()) {
		return tauriProvider();
	}
	// Firefox and Safari have no picker; there the fixture is the whole story.
	const pick = window.showDirectoryPicker?.bind(window);
	return pick ? fileSystemAccessProvider(pick) : fixtureProvider();
}
