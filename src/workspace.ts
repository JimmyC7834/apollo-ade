// The workspace seam. Feature code talks to `WorkspaceProvider` and never to
// Tauri directly, so the UI runs in a plain browser (`npm run dev`) against
// the fixture provider with no native process involved.

export interface WorkspaceEntry {
	readonly id: string;
	readonly name: string;
	readonly kind: 'file' | 'dir';
	readonly depth: number;
}

export interface WorkspaceSelection {
	readonly label: string;
	readonly path: string;
}

export interface WorkspaceProvider {
	/** False in the browser: there is no real folder to choose. */
	readonly canChooseWorkspace: boolean;
	chooseWorkspace(): Promise<WorkspaceSelection | undefined>;
	getTree(): Promise<readonly WorkspaceEntry[]>;
	readFile(id: string): Promise<string>;
}

const FIXTURE: Record<string, string> = {
	'README.md': '# Fixture workspace\n\nBrowser mode. Run `npm run tauri dev` to open a real folder.\n',
	'src/main.ts': "console.log('hello from the fixture');\n",
	'src/util.ts': 'export const noop = (): void => {};\n',
};

function fixtureProvider(): WorkspaceProvider {
	const entries: WorkspaceEntry[] = [
		{ id: 'src', name: 'src', kind: 'dir', depth: 0 },
		{ id: 'src/main.ts', name: 'main.ts', kind: 'file', depth: 1 },
		{ id: 'src/util.ts', name: 'util.ts', kind: 'file', depth: 1 },
		{ id: 'README.md', name: 'README.md', kind: 'file', depth: 0 },
	];
	return {
		canChooseWorkspace: false,
		async chooseWorkspace() {
			return undefined;
		},
		async getTree() {
			return entries;
		},
		async readFile(id) {
			const content = FIXTURE[id];
			if (content === undefined) {
				throw new Error(`not found: ${id}`);
			}
			return content;
		},
	};
}

function tauriProvider(): WorkspaceProvider {
	return {
		canChooseWorkspace: true,
		async chooseWorkspace() {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const { invoke } = await import('@tauri-apps/api/core');
			const picked = await open({ directory: true, multiple: false });
			if (typeof picked !== 'string') {
				return undefined;
			}
			return invoke<WorkspaceSelection>('set_workspace', { path: picked });
		},
		async getTree() {
			const { invoke } = await import('@tauri-apps/api/core');
			return invoke<WorkspaceEntry[]>('list_tree');
		},
		async readFile(id) {
			const { invoke } = await import('@tauri-apps/api/core');
			return invoke<string>('read_file', { id });
		},
	};
}

export function createWorkspaceProvider(): WorkspaceProvider {
	const isTauri = '__TAURI_INTERNALS__' in window;
	return isTauri ? tauriProvider() : fixtureProvider();
}
