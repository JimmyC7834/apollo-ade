// The language server's whole lifetime, as one hook — tickets 33, 34 and 35.
//
// The workbench controller already holds the workspace root, the open files and
// their contents; every one of those is something a server has to be told
// about. Rather than scatter four effects through a 1,200-line component, they
// live here and the controller mounts one hook and renders what it returns.
//
// Nothing here touches the process. `client.ts` owns that, `lsp.rs` owns the
// process itself, and this owns *when* — start on a root, stop on losing one,
// mirror the open documents, and hold the two bits of UI state (the reference
// results and the pending rename) that outlive a single call.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { languageForPath } from '../../editor/monacoEnvironment';
import { isTauri } from '../../native';
import type { Replacement } from '../search/replace';
import { LanguageClient, serverFor, type LspStatus } from './client';
import { applyDiagnostics, clearDiagnostics, installLsp } from './editorLsp';
import type { EditorPosition } from './protocol';
import type { Reference } from './references';
import { planWorkspaceEdit, toReplacement } from './workspaceEdit';

/** The one language ticket 33 starts with. `client.ts` holds the table. */
const LANGUAGE = 'rust';

export interface OpenFile {
	readonly id: string;
	readonly content: string;
}

export interface RenameTarget {
	readonly fileId: string;
	readonly position: EditorPosition;
	/** The word under the cursor, so the prompt opens with it filled in. */
	readonly symbol: string;
}

export type RenamePlan =
	| { readonly ok: true; readonly files: readonly Replacement[] }
	| { readonly ok: false; readonly reason: string };

export interface UseLspOptions {
	readonly root: string | undefined;
	/** Every source file open in an editor, with its current text. */
	readonly openFiles: readonly OpenFile[];
	readonly openFile: (id: string, line?: number) => void;
	readonly readFile: (id: string) => Promise<string | undefined>;
	readonly announce: (message: string) => void;
	/** Bring the References artifact to the front when a result set arrives. */
	readonly revealReferences: () => void;
}

export interface Lsp {
	readonly status: LspStatus | undefined;
	readonly restart: () => void;
	readonly references: readonly Reference[];
	readonly symbol: string | undefined;
	readonly renameTarget: RenameTarget | undefined;
	readonly cancelRename: () => void;
	/** Ask the server what a rename would change. Writes nothing. */
	readonly planRename: (newName: string) => Promise<RenamePlan>;
}

export function useLsp(options: UseLspOptions): Lsp {
	const { root, openFiles, openFile, readFile, announce, revealReferences } = options;

	const clientRef = useRef<LanguageClient>(null);
	if (!clientRef.current) {
		clientRef.current = new LanguageClient(LANGUAGE);
	}
	const client = clientRef.current;

	const [status, setStatus] = useState<LspStatus | undefined>(undefined);
	const [references, setReferences] = useState<readonly Reference[]>([]);
	const [symbol, setSymbol] = useState<string | undefined>(undefined);
	const [renameTarget, setRenameTarget] = useState<RenameTarget | undefined>(undefined);

	/*
	 * The callbacks the Monaco glue needs, held in a ref rather than closed over.
	 * `installLsp` registers global editor actions and providers, and
	 * re-registering them every time the controller re-renders would leak a
	 * provider per keystroke — so the registration effect must not depend on
	 * anything that changes, and this is what lets it not.
	 */
	const latest = useRef({ root, openFile, announce, revealReferences });
	latest.current = { root, openFile, announce, revealReferences };

	useEffect(() => {
		const stop = client.onStatus(setStatus);
		return () => {
			stop();
		};
	}, [client]);

	useEffect(
		() =>
			client.onDiagnostics(({ fileId, diagnostics }) =>
				applyDiagnostics(client.server, fileId, diagnostics)
			),
		[client]
	);

	// Start on a root, stop on losing one. A server is initialised against a
	// directory, so a workspace switch is a restart and not a notification —
	// ticket 31's switch changes the root the server was indexing.
	useEffect(() => {
		if (!root || !isTauri()) {
			return;
		}
		void client.start(root);
		return () => {
			clearDiagnostics(client.server);
			void client.stop();
		};
	}, [client, root]);

	// The providers, actions and opener. Registered once, torn down once.
	useEffect(
		() =>
			installLsp(client, {
				root: () => latest.current.root,
				openFile: (id, line) => latest.current.openFile(id, line),
				showReferences: (word, found) => {
					setSymbol(word);
					setReferences(found);
					latest.current.revealReferences();
				},
				startRename: (fileId, position, word) =>
					setRenameTarget({
						fileId,
						position: { lineNumber: position.lineNumber, column: position.column },
						symbol: word,
					}),
				announce: (message) => latest.current.announce(message),
			}),
		[client]
	);

	/*
	 * The open-document mirror. Whole-text on every change, which is the same
	 * trade `client.ts` explains: the ranges come out identical either way, and
	 * an incremental sync that drifts is silently and permanently wrong.
	 *
	 * The dependency is the files themselves, so this runs on every keystroke in
	 * a Rust file and on no keystroke in any other — `didChange` is a
	 * notification, so it costs one write to a pipe.
	 */
	const tracked = useMemo(
		() => openFiles.filter((file) => serverFor(languageForPath(file.id)) === client.server),
		[client.server, openFiles]
	);
	const openedRef = useRef(new Set<string>());
	useEffect(() => {
		if (status?.state !== 'ready') {
			// Nothing to mirror into a server that is not up. When one becomes
			// ready this effect re-runs on the status change and opens them all.
			openedRef.current.clear();
			return;
		}
		const present = new Set(tracked.map((file) => file.id));
		for (const id of [...openedRef.current]) {
			if (!present.has(id)) {
				client.didClose(id);
				openedRef.current.delete(id);
			}
		}
		for (const file of tracked) {
			if (openedRef.current.has(file.id)) {
				client.didChange(file.id, file.content);
			} else {
				client.didOpen(file.id, file.content);
				openedRef.current.add(file.id);
			}
		}
	}, [client, status?.state, tracked]);

	const planRename = useCallback(
		async (newName: string): Promise<RenamePlan> => {
			const target = renameTarget;
			if (!target || !root) {
				return { ok: false, reason: 'There is nothing to rename.' };
			}
			let edit;
			try {
				edit = await client.rename(target.fileId, target.position, newName);
			} catch (error) {
				// The server refusing is a real answer — "cannot rename this" is it
				// telling the user something true about the symbol they are on.
				return { ok: false, reason: String(error) };
			}
			if (!edit) {
				return { ok: false, reason: `${client.server} cannot rename that.` };
			}

			const plan = planWorkspaceEdit(edit, root);
			if (!plan.ok) {
				return plan;
			}

			const files: Replacement[] = [];
			const unreadable: string[] = [];
			for (const file of plan.files) {
				const original = await readFile(file.id);
				if (original === undefined) {
					unreadable.push(file.id);
					continue;
				}
				const replacement = toReplacement(file.id, original, file.edits);
				if (replacement) {
					files.push(replacement);
				}
			}
			if (unreadable.length > 0) {
				// Refused whole. A rename applied to some of its files is the
				// half-renamed workspace ticket 35 forbids, and the file that
				// could not be read is exactly the one nobody would notice.
				return {
					ok: false,
					reason: `Could not read ${unreadable.join(', ')}, so nothing has been done.`,
				};
			}
			return files.length === 0
				? { ok: false, reason: 'That rename would change nothing.' }
				: { ok: true, files };
		},
		[client, readFile, renameTarget, root]
	);

	return {
		status,
		restart: useCallback(() => void client.restart(), [client]),
		references,
		symbol,
		renameTarget,
		cancelRename: useCallback(() => setRenameTarget(undefined), []),
		planRename,
	};
}
