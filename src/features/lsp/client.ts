// One conversation with one language server — ticket 33.
//
// The layer between `jsonrpc.ts`, which knows nothing about LSP, and the Monaco
// glue in `editorLsp.ts`, which knows nothing about transport. This one owns
// the handshake, the server's advertised capabilities, the open-document
// mirror, and — the part that is actually load-bearing — **what state the
// server is in and how it got there**.
//
// ## Degrading is a first-class state, not an error path
//
// Three of the five states below are ways of not working, and the ticket asks
// for every one of them to be visible and none of them to block anything:
// `rust-analyzer` that was never installed, one that died, and a workbench with
// no workspace root at all. They are modelled rather than thrown because a
// thrown error has to be caught somewhere and, wherever that is, the answer to
// "is there an LSP?" stops being a thing the UI can read.
//
// There is no browser fixture. `terminal.ts` has an echo adapter because a
// terminal UI can be exercised against fake bytes; a language server cannot be
// faked usefully — a stub that invented definitions would make `npm run dev`
// lie about the one thing this feature does. In the browser the state is
// `unavailable` and the UI says so, which is the same rule ticket 10 sets for
// every other mode that cannot do something.

import { isTauri } from '../../native.ts';
import { Peer, type Json } from './jsonrpc.ts';
import {
	fileIdFromUri,
	fileUri,
	toLspPosition,
	type EditorPosition,
	type LspDiagnostic,
	type LspLocation,
	type LspRange,
} from './protocol.ts';
import type { LspWorkspaceEdit } from './workspaceEdit.ts';

const MESSAGE_EVENT = 'lsp://message';
const EXIT_EVENT = 'lsp://exit';

/**
 * Which Monaco language ids a server is claimed for.
 *
 * Mirrors `SERVERS` in `lsp.rs`, which is the authority: Rust refuses a
 * language it has no entry for, so a mistake here is a start that fails with a
 * clear message rather than a program this app was tricked into running.
 */
const LANGUAGES: Record<string, string> = { rust: 'rust-analyzer' };

export function serverFor(languageId: string): string | undefined {
	return LANGUAGES[languageId];
}

export type LspState =
	| 'off'
	| 'starting'
	| 'ready'
	/** No binary. Not a failure of this app, and it must not read like one. */
	| 'missing'
	| 'crashed'
	/** The browser. There is no process to start. */
	| 'unavailable';

export interface LspStatus {
	readonly language: string;
	readonly server: string;
	readonly state: LspState;
	/** The sentence shown to the user when there is one worth showing. */
	readonly detail?: string;
}

export interface Diagnostics {
	readonly fileId: string;
	readonly diagnostics: readonly LspDiagnostic[];
}

interface Capabilities {
	readonly definition: boolean;
	readonly references: boolean;
	readonly hover: boolean;
	readonly rename: boolean;
}

const NO_CAPABILITIES: Capabilities = {
	definition: false,
	references: false,
	hover: false,
	rename: false,
};

function truthy(value: unknown): boolean {
	// A capability is advertised as `true` or as an options object; both mean
	// yes, and `false`/absent mean no. Treating an options object as "no" would
	// silently disable rename against a server that supports it.
	return value === true || (typeof value === 'object' && value !== null);
}

/**
 * Subscribe, and **wait until the listener is really attached**.
 *
 * `terminal.ts` has the fire-and-forget version of this — subscribe now,
 * resolve the handle later — and it is right there, because a shell produces
 * nothing until it is written to. A language server is not like that. It
 * answers `initialize` in single-digit milliseconds, and `listen` needs a round
 * trip to Rust to register: sending the request before this resolved meant the
 * reply arrived with nobody listening, the promise never settled, and the
 * client sat in `starting` forever with a perfectly healthy server attached.
 *
 * Found by running the real app, which is the only place it can happen.
 */
async function subscribe<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
	const { listen } = await import('@tauri-apps/api/event');
	return await listen<T>(event, (message) => handler(message.payload));
}

export class LanguageClient {
	readonly language: string;
	readonly server: string;

	private root: string | undefined;
	private peer: Peer | undefined;
	/** Which server instance this client is talking to. See `start`. */
	private epoch = 0;
	private state: LspState = isTauri() ? 'off' : 'unavailable';
	private detail: string | undefined = isTauri()
		? undefined
		: 'Language servers need the desktop app; the browser has no process to start one in.';
	private capabilities: Capabilities = NO_CAPABILITIES;
	private unlisten: (() => void)[] = [];
	/** Version per open document, which `didChange` is required to increment. */
	private readonly versions = new Map<string, number>();
	private readonly statusListeners = new Set<(status: LspStatus) => void>();
	private readonly diagnosticListeners = new Set<(diagnostics: Diagnostics) => void>();

	constructor(language: string) {
		this.language = language;
		this.server = LANGUAGES[language] ?? language;
	}

	status(): LspStatus {
		return {
			language: this.language,
			server: this.server,
			state: this.state,
			detail: this.detail,
		};
	}

	onStatus(listener: (status: LspStatus) => void): () => void {
		this.statusListeners.add(listener);
		listener(this.status());
		return () => this.statusListeners.delete(listener);
	}

	onDiagnostics(listener: (diagnostics: Diagnostics) => void): () => void {
		this.diagnosticListeners.add(listener);
		return () => this.diagnosticListeners.delete(listener);
	}

	private setState(state: LspState, detail?: string): void {
		this.state = state;
		this.detail = detail;
		const status = this.status();
		for (const listener of this.statusListeners) {
			listener(status);
		}
	}

	can(capability: keyof Capabilities): boolean {
		return this.state === 'ready' && this.capabilities[capability];
	}

	/**
	 * Start, handshake, and become ready — or say why not.
	 *
	 * Never throws. Every caller of this is a UI effect, and an effect that can
	 * reject is a start failure that arrives as an unhandled rejection in the
	 * console instead of as a sentence in the Problems panel.
	 */
	async start(root: string): Promise<void> {
		if (this.state === 'unavailable' || this.state === 'starting' || this.state === 'ready') {
			return;
		}
		this.root = root;
		this.setState('starting');

		const { invoke } = await import('@tauri-apps/api/core');

		this.peer = new Peer(
			(body) => void invoke('lsp_send', { language: this.language, body }),
			(method, params) => this.handleNotification(method, params)
		);
		// Listening comes first, and is awaited. Both of these have to be
		// attached before the process exists, never mind before it is spoken to
		// — see `subscribe`.
		this.unlisten = await Promise.all([
			subscribe<{ language: string; epoch: number; body: string }>(MESSAGE_EVENT, (payload) => {
				if (payload.language === this.language && payload.epoch === this.epoch) {
					this.peer?.receive(payload.body);
				}
			}),
			subscribe<{ language: string; epoch: number }>(EXIT_EVENT, (payload) => {
				/*
				 * The epoch, not just the language. Starting a server replaces
				 * any previous one, and killing that one emits an exit — which
				 * lands on this listener, for this language, milliseconds after
				 * asking for a *new* server. Without the epoch it is the same
				 * event as one's own server dying, and the panel reported a
				 * healthy indexing server as stopped every single time.
				 */
				if (payload.language !== this.language || payload.epoch !== this.epoch) {
					return;
				}
				// Only a state change, never a restart. A server that crashes on
				// startup would otherwise be restarted forever, and the loop is
				// invisible because each attempt looks like the first.
				this.teardown();
				this.setState('crashed', `${this.server} stopped. Restart it to try again.`);
			}),
		]);

		try {
			// The instance number this start produced. Every event carries one,
			// and anything with a different one belongs to a server this client
			// never asked for.
			this.epoch = (await invoke('lsp_start', { language: this.language })) as number;
		} catch (error) {
			const message = String(error);
			// The one failure told apart from the rest, because "you have not
			// installed it" and "it fell over" call for different actions.
			this.teardown();
			this.setState(/not installed/.test(message) ? 'missing' : 'crashed', message);
			return;
		}

		try {
			const result = (await this.peer.request('initialize', {
				processId: null,
				rootUri: fileUri(root, ''),
				workspaceFolders: [{ uri: fileUri(root, ''), name: 'workspace' }],
				capabilities: {
					textDocument: {
						synchronization: { didSave: true },
						publishDiagnostics: {},
						definition: {},
						references: {},
						hover: { contentFormat: ['markdown', 'plaintext'] },
						rename: {},
					},
				},
			})) as { capabilities?: Record<string, unknown> };

			const advertised = result?.capabilities ?? {};
			this.capabilities = {
				definition: truthy(advertised.definitionProvider),
				references: truthy(advertised.referencesProvider),
				hover: truthy(advertised.hoverProvider),
				rename: truthy(advertised.renameProvider),
			};
			this.peer.notify('initialized', {});
			this.setState('ready');
		} catch (error) {
			this.setState('crashed', `${this.server} did not start: ${String(error)}`);
			await this.stop();
		}
	}

	/** Ask politely, then stop asking. Safe to call in any state. */
	async stop(): Promise<void> {
		const peer = this.peer;
		this.teardown();
		if (peer) {
			// `exit` is sent and not waited on. The specification's `shutdown`
			// request comes first in a well-behaved client, but waiting for its
			// reply means a server that has stopped answering holds up closing
			// the workbench — and `lsp_stop` takes the process tree regardless,
			// so the wait buys nothing this app needs.
			peer.notify('exit');
			peer.fail('the language server was stopped');
		}
		if (this.state !== 'unavailable') {
			const { invoke } = await import('@tauri-apps/api/core');
			try {
				await invoke('lsp_stop', { language: this.language });
			} catch {
				// Stopping something that is already gone is not a failure.
			}
			if (this.state !== 'missing' && this.state !== 'crashed') {
				this.setState('off');
			}
		}
	}

	async restart(): Promise<void> {
		await this.stop();
		this.setState('off');
		if (this.root) {
			await this.start(this.root);
		}
	}

	private teardown(): void {
		for (const stop of this.unlisten) {
			stop();
		}
		this.unlisten = [];
		this.peer = undefined;
		this.capabilities = NO_CAPABILITIES;
		this.versions.clear();
	}

	private handleNotification(method: string, params: Json): void {
		if (method !== 'textDocument/publishDiagnostics' || !this.root) {
			return;
		}
		const payload = params as { uri?: string; diagnostics?: readonly LspDiagnostic[] };
		const fileId = payload.uri ? fileIdFromUri(this.root, payload.uri) : undefined;
		// Diagnostics for a file outside the root are dropped rather than shown
		// against nothing. rust-analyzer reports on its dependencies' sources
		// during a `cargo check`, and none of them are anybody's problem here.
		if (!fileId) {
			return;
		}
		const diagnostics = { fileId, diagnostics: payload.diagnostics ?? [] };
		for (const listener of this.diagnosticListeners) {
			listener(diagnostics);
		}
	}

	// --- The open-document mirror -------------------------------------------
	//
	// A server answers questions about the documents it has been told about, and
	// what it has been told must match what is on screen — otherwise a
	// definition points at the position a symbol was at before the last three
	// keystrokes. Whole-document sync is used rather than incremental: the
	// ranges are computed from the same text either way, and an incremental sync
	// bug desynchronises the server silently and permanently.

	didOpen(fileId: string, text: string): void {
		if (!this.peer || !this.root || this.versions.has(fileId)) {
			return;
		}
		this.versions.set(fileId, 1);
		this.peer.notify('textDocument/didOpen', {
			textDocument: {
				uri: fileUri(this.root, fileId),
				languageId: this.language,
				version: 1,
				text,
			},
		});
	}

	didChange(fileId: string, text: string): void {
		const version = this.versions.get(fileId);
		if (!this.peer || !this.root || version === undefined) {
			return;
		}
		this.versions.set(fileId, version + 1);
		this.peer.notify('textDocument/didChange', {
			textDocument: { uri: fileUri(this.root, fileId), version: version + 1 },
			contentChanges: [{ text }],
		});
	}

	didClose(fileId: string): void {
		if (!this.peer || !this.root || !this.versions.delete(fileId)) {
			return;
		}
		this.peer.notify('textDocument/didClose', {
			textDocument: { uri: fileUri(this.root, fileId) },
		});
	}

	// --- Questions ----------------------------------------------------------
	//
	// Each returns an empty answer rather than throwing when the server cannot
	// or will not answer. A capability the server does not have degrades to
	// absent, which is a ticket 34 acceptance criterion, and it is enforced here
	// rather than at each of the four call sites.

	private async ask(method: string, fileId: string, position: EditorPosition, extra?: object) {
		if (!this.peer || !this.root) {
			return undefined;
		}
		try {
			return await this.peer.request(method, {
				textDocument: { uri: fileUri(this.root, fileId) },
				position: toLspPosition(position),
				...extra,
			});
		} catch {
			return undefined;
		}
	}

	async definition(fileId: string, position: EditorPosition): Promise<readonly LspLocation[]> {
		if (!this.can('definition')) {
			return [];
		}
		return locations(await this.ask('textDocument/definition', fileId, position));
	}

	async references(fileId: string, position: EditorPosition): Promise<readonly LspLocation[]> {
		if (!this.can('references')) {
			return [];
		}
		return locations(
			await this.ask('textDocument/references', fileId, position, {
				context: { includeDeclaration: true },
			})
		);
	}

	async hover(
		fileId: string,
		position: EditorPosition
	): Promise<{ value: string; range?: LspRange } | undefined> {
		if (!this.can('hover')) {
			return undefined;
		}
		const result = (await this.ask('textDocument/hover', fileId, position)) as
			| { contents?: unknown; range?: LspRange }
			| null
			| undefined;
		const value = hoverText(result?.contents);
		return value ? { value, range: result?.range } : undefined;
	}

	/**
	 * The edits a rename would make. **Nothing is written by this call** — the
	 * server computes, the preview shows, and ticket 30's apply writes.
	 */
	async rename(
		fileId: string,
		position: EditorPosition,
		newName: string
	): Promise<LspWorkspaceEdit | undefined> {
		if (!this.can('rename')) {
			return undefined;
		}
		if (!this.peer || !this.root) {
			return undefined;
		}
		// Not routed through `ask`, because a rename failure has a reason worth
		// showing — "cannot rename this" is the server telling the user
		// something true about the symbol under the cursor.
		const result = await this.peer.request('textDocument/rename', {
			textDocument: { uri: fileUri(this.root, fileId) },
			position: toLspPosition(position),
			newName,
		});
		return (result ?? undefined) as LspWorkspaceEdit | undefined;
	}
}

/** `Location`, `Location[]` and `LocationLink[]` are all legal replies. */
function locations(result: unknown): readonly LspLocation[] {
	if (!result) {
		return [];
	}
	const list = Array.isArray(result) ? result : [result];
	return list.flatMap((item): LspLocation[] => {
		const candidate = item as Partial<LspLocation> & {
			targetUri?: string;
			targetSelectionRange?: LspRange;
			targetRange?: LspRange;
		};
		if (candidate.uri && candidate.range) {
			return [{ uri: candidate.uri, range: candidate.range }];
		}
		const range = candidate.targetSelectionRange ?? candidate.targetRange;
		return candidate.targetUri && range ? [{ uri: candidate.targetUri, range }] : [];
	});
}

/** Hover contents come in three shapes across protocol versions. */
function hoverText(contents: unknown): string {
	if (typeof contents === 'string') {
		return contents;
	}
	if (Array.isArray(contents)) {
		return contents.map(hoverText).filter(Boolean).join('\n\n');
	}
	if (typeof contents === 'object' && contents !== null) {
		const marked = contents as { value?: unknown; language?: unknown };
		if (typeof marked.value === 'string') {
			return typeof marked.language === 'string' && marked.language
				? `\`\`\`${marked.language}\n${marked.value}\n\`\`\``
				: marked.value;
		}
	}
	return '';
}
