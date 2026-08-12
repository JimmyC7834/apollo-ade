// Where the language server meets the editor — tickets 33, 34 and 35.
//
// The only file in `features/lsp` that imports Monaco, which is why the three
// files under it import neither Monaco nor Tauri and can be checked under bare
// `node`. Everything here is glue: markers, providers, actions, and the one
// piece of routing that makes cross-file navigation work at all.
//
// ## Cross-file navigation is an *opener* problem, not a provider problem
//
// Monaco's standalone editor can find a definition in another file and then has
// nowhere to put it: its default opener resolves a target by looking for a
// model that already exists, and a file nobody has opened has no model. That is
// also why references do not use Monaco's peek widget — peek resolves its
// targets the same way and throws on a file the workbench has not opened.
//
// `registerEditorOpener` is the seam for this, and it is registered once for
// *every* language rather than per server. It is what makes go-to-definition in
// TypeScript — which Monaco's own worker has always answered correctly —
// actually land somewhere, and it is what makes the two languages behave the
// same way from the user's side, which ticket 34 asked for.

import * as monaco from 'monaco-editor';

import { fileIdForModel } from '../../editor/modelRegistry';
import type { LanguageClient } from './client';
import {
	fileIdFromUri,
	toEditorPosition,
	toEditorRange,
	toMarkerSeverity,
	type LspDiagnostic,
	type LspLocation,
} from './protocol';
import type { Reference } from './references';

/** Every Monaco model currently showing a given workspace file. */
function modelsFor(fileId: string): monaco.editor.ITextModel[] {
	return monaco.editor
		.getModels()
		.filter((model) => fileIdForModel(model.uri.toString()) === fileId);
}

/**
 * Diagnostics from a language server, as markers on whatever models exist.
 *
 * **Markers, deliberately, and not a second problems channel.** `ProblemsView`
 * reads `monaco.editor.getModelMarkers` and re-groups on
 * `onDidChangeMarkers`; putting the server's diagnostics there means they
 * appear in the panel alongside the TypeScript ones, distinguishable by source,
 * with no change to ticket 32's code at all. The owner string is the server
 * name, which is what shows in the panel's `description` column.
 *
 * A file with no model open gets nothing, which is the same scope ticket 32
 * states in as many words. The alternative — a parallel problem list for files
 * with no editor — is a bigger change than this ticket, and one the panel's own
 * scope note would then be lying about.
 */
export function applyDiagnostics(
	owner: string,
	fileId: string,
	diagnostics: readonly LspDiagnostic[]
): void {
	const markers = diagnostics.flatMap((diagnostic): monaco.editor.IMarkerData[] => {
		const severity = toMarkerSeverity(diagnostic.severity);
		if (severity === undefined) {
			return [];
		}
		return [
			{
				...toEditorRange(diagnostic.range),
				severity,
				message: diagnostic.message,
				source: diagnostic.source ?? owner,
			},
		];
	});
	for (const model of modelsFor(fileId)) {
		monaco.editor.setModelMarkers(model, owner, markers);
	}
}

/** Forget a server's markers everywhere. Called when it stops or crashes. */
export function clearDiagnostics(owner: string): void {
	for (const model of monaco.editor.getModels()) {
		monaco.editor.setModelMarkers(model, owner, []);
	}
}

export interface LspEditorHost {
	/** The absolute workspace root, or undefined when there is none. */
	root(): string | undefined;
	/** Open a workspace file at a 1-based line. The same call search makes. */
	openFile(id: string, line?: number): void;
	/** Hand a result set to the References artifact. */
	showReferences(symbol: string, references: readonly Reference[]): void;
	/** Ask for a new name and preview the rename — ticket 35. */
	startRename(fileId: string, position: monaco.IPosition, symbol: string): void;
	/** Say something in the workbench's own voice, for the honest failures. */
	announce(message: string): void;
}

/**
 * Wire an editor to the language servers, and return the undo.
 *
 * Called once, from the workbench. Everything registered here is global to
 * Monaco rather than attached to an editor instance, because the Modal
 * Workbench and the dock each build their own editor and both should behave the
 * same.
 */
export function installLsp(client: LanguageClient, host: LspEditorHost): () => void {
	const disposables: monaco.IDisposable[] = [];
	const language = client.language;

	disposables.push(
		monaco.languages.registerDefinitionProvider(language, {
			provideDefinition: async (model, position) => {
				const fileId = fileIdForModel(model.uri.toString());
				if (!fileId) {
					return null;
				}
				const found = await client.definition(fileId, position);
				return locationsToMonaco(host, found, 'definition');
			},
		})
	);

	disposables.push(
		monaco.languages.registerHoverProvider(language, {
			provideHover: async (model, position) => {
				const fileId = fileIdForModel(model.uri.toString());
				if (!fileId) {
					return null;
				}
				const hover = await client.hover(fileId, position);
				if (!hover) {
					return null;
				}
				return {
					contents: [{ value: hover.value }],
					range: hover.range ? toEditorRange(hover.range) : undefined,
				};
			},
		})
	);

	// No reference provider and no rename provider are registered on purpose,
	// and the reasons are different. References: Monaco's peek widget cannot
	// resolve a file the workbench has not opened, per the header above. Rename:
	// Monaco's standalone bulk-edit service applies edits only to models that
	// exist and drops the rest silently, which is the exact failure ticket 35
	// forbids — see `workspaceEdit.ts`. Both are actions instead, below.
	//
	// The side effect is that Monaco's own `F2` and `Shift+F12` stay disabled
	// for this language — their preconditions are `hasRenameProvider` and
	// `hasReferenceProvider` — so the actions below own those keys outright
	// rather than racing the built-ins for them.

	disposables.push(
		monaco.editor.addEditorAction({
			id: 'ade.lsp.references',
			label: 'Find All References',
			keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
			contextMenuGroupId: 'navigation',
			contextMenuOrder: 1.5,
			run: async (editor) => {
				const model = editor.getModel();
				const position = editor.getPosition();
				if (!model || !position) {
					return;
				}
				const fileId = fileIdForModel(model.uri.toString());
				if (!fileId) {
					return;
				}
				const word = model.getWordAtPosition(position)?.word ?? 'symbol';
				/*
				 * Dispatched by the model's language rather than assuming this
				 * client. The action is global — there is one keybinding, not one
				 * per server — and TypeScript's references come out of the worker
				 * that is already bundled, so both languages land in the same
				 * artifact. That sameness was the ticket's requirement.
				 */
				const references =
					model.getLanguageId() === language
						? toReferences(host, await client.references(fileId, position))
						: await typescriptReferences(model, position);
				host.showReferences(word, references);
			},
		})
	);

	disposables.push(
		monaco.editor.addEditorAction({
			id: 'ade.lsp.rename',
			label: 'Rename Symbol',
			keybindings: [monaco.KeyCode.F2],
			contextMenuGroupId: 'modification',
			contextMenuOrder: 1.1,
			run: (editor) => {
				const model = editor.getModel();
				const position = editor.getPosition();
				if (!model || !position) {
					return;
				}
				const fileId = fileIdForModel(model.uri.toString());
				if (!fileId) {
					return;
				}
				// Rename is the one capability with no fallback. Ticket 35 is a
				// language-server rename; TypeScript's worker can rename too, but
				// wiring a second implementation of the capability that *writes*
				// is not what this ticket is, and offering a key that quietly does
				// nothing is worse than saying why.
				if (model.getLanguageId() !== language) {
					host.announce(`Renaming needs a language server, and there is none for ${model.getLanguageId()} files.`);
					return;
				}
				// The prompt opens with the current name filled in, so the word has
				// to travel with the position — the file id cannot supply it.
				host.startRename(fileId, position, model.getWordAtPosition(position)?.word ?? '');
			},
		})
	);

	/*
	 * The opener. Registered for every language, not just this one — see the
	 * header. `resource` is either one of our own `file://` targets from the
	 * definition provider above, or an existing model's `inmemory://` URI when
	 * Monaco's TypeScript worker answered.
	 */
	disposables.push(
		monaco.editor.registerEditorOpener({
			openCodeEditor: (_source, resource, selectionOrPosition) => {
				const line =
					selectionOrPosition && 'startLineNumber' in selectionOrPosition
						? selectionOrPosition.startLineNumber
						: selectionOrPosition?.lineNumber;

				const known = fileIdForModel(resource.toString());
				if (known) {
					host.openFile(known, line);
					return true;
				}

				const root = host.root();
				const fileId = root ? fileIdFromUri(root, resource.toString()) : undefined;
				if (fileId) {
					host.openFile(fileId, line);
					return true;
				}

				/*
				 * Outside the workspace root. `workspace.rs` will not read it and
				 * this does not ask it to: ticket 34's criterion is that the root
				 * is not silently widened, and failing with the path named is the
				 * recorded alternative to opening it read-only through a mechanism
				 * that does not exist yet.
				 */
				host.announce(
					`That is outside this workspace, so it cannot be opened here: ${resource.path}`
				);
				return true;
			},
		})
	);

	return () => {
		for (const disposable of disposables) {
			disposable.dispose();
		}
		clearDiagnostics(client.server);
	};
}

/** LSP locations as Monaco's, dropping anything outside the workspace root. */
function locationsToMonaco(
	host: LspEditorHost,
	found: readonly LspLocation[],
	what: string
): monaco.languages.Location[] {
	const root = host.root();
	if (!root) {
		return [];
	}
	const inside = found.filter((location) => fileIdFromUri(root, location.uri));
	if (inside.length === 0 && found.length > 0) {
		host.announce(`The ${what} is outside this workspace, so it cannot be opened here.`);
	}
	return inside.map((location) => ({
		uri: monaco.Uri.parse(location.uri),
		range: toEditorRange(location.range),
	}));
}

/** LSP locations as reference rows, with a preview line where one is readable. */
function toReferences(host: LspEditorHost, found: readonly LspLocation[]): Reference[] {
	const root = host.root();
	if (!root) {
		return [];
	}
	return found.flatMap((location): Reference[] => {
		const fileId = fileIdFromUri(root, location.uri);
		if (!fileId) {
			return []; // Outside the root: not somewhere this can send anyone.
		}
		const start = toEditorPosition(location.range.start);
		// The preview is best-effort. A file with no model open has no text here
		// to quote, and `referenceLabel` falls back to the line number rather
		// than reading every referenced file off disk to fill a list.
		const preview = modelsFor(fileId)[0]?.getLineContent(start.lineNumber);
		return [{ fileId, line: start.lineNumber, column: start.column, preview }];
	});
}

/**
 * References for TypeScript, out of the worker that is already bundled.
 *
 * Ticket 34 asks the two languages to behave the same way, and for TypeScript
 * that means routing through the same artifact rather than Monaco's peek — so
 * the worker is queried directly. It answers in file names and character
 * offsets, both of which have to come back through the model to be positions.
 */
async function typescriptReferences(
	model: monaco.editor.ITextModel,
	position: monaco.IPosition
): Promise<Reference[]> {
	let worker;
	try {
		const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
		worker = await getWorker(model.uri);
	} catch {
		return []; // No TypeScript worker for this model; not an error.
	}
	const found = (await worker.getReferencesAtPosition(
		model.uri.toString(),
		model.getOffsetAt(position)
	)) as { fileName: string; textSpan: { start: number } }[] | undefined;

	return (found ?? []).flatMap((entry): Reference[] => {
		const target = monaco.editor.getModel(monaco.Uri.parse(entry.fileName));
		const fileId = target && fileIdForModel(target.uri.toString());
		if (!target || !fileId) {
			return [];
		}
		const at = target.getPositionAt(entry.textSpan.start);
		return [
			{
				fileId,
				line: at.lineNumber,
				column: at.column,
				preview: target.getLineContent(at.lineNumber),
			},
		];
	});
}
