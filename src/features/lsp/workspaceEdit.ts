// Turning a server's `WorkspaceEdit` into something this app can preview — ticket 35.
//
// **Rename is the first LSP capability that writes**, and this is the file that
// does the writing arithmetic, so it is pure and it is checked. Everything here
// runs under bare `node` in `workspaceEdit.check.ts`.
//
// ## Why Monaco's rename provider is not used
//
// The obvious implementation is `registerRenameProvider`, returning the edit and
// letting Monaco apply it. It was rejected. Monaco's standalone bulk-edit
// service applies edits to **models that already exist** and drops the rest on
// the floor without a word — so renaming a symbol used in forty files, with two
// of them open, would edit two files and silently discard thirty-eight. That is
// precisely the acceptance criterion about not leaving the workspace
// half-renamed, failed by the default path.
//
// So the edit is converted here into `Replacement`, the shape ticket 30's
// preview already carries, and applied by ticket 30's apply — which re-reads
// every file, refuses one that moved underneath the preview, refuses one with
// unsaved changes, and writes through the same Rust path under the same
// containment. Sharing that surface was an acceptance criterion; reusing its
// *type* is what makes the sharing real rather than nominal.

import { basename } from '../../ids.ts';
import type { Replacement } from '../search/replace.ts';
import { fileIdFromUri, type LspRange, type LspTextEdit } from './protocol.ts';

/** As much of `WorkspaceEdit` as this app reads. */
export interface LspWorkspaceEdit {
	readonly changes?: Record<string, readonly LspTextEdit[]>;
	readonly documentChanges?: readonly unknown[];
}

/** Every edit a server asked for in one file. */
export interface FileEdits {
	readonly id: string;
	readonly edits: readonly LspTextEdit[];
}

export type EditPlan =
	| { readonly ok: true; readonly files: readonly FileEdits[] }
	| { readonly ok: false; readonly reason: string };

function isTextDocumentEdit(
	change: unknown
): change is { textDocument: { uri: string }; edits: readonly LspTextEdit[] } {
	return (
		typeof change === 'object' &&
		change !== null &&
		'textDocument' in change &&
		'edits' in change
	);
}

/**
 * Which files a `WorkspaceEdit` touches, or why it cannot be carried.
 *
 * **Refusing is a real outcome here, not an error path.** A `WorkspaceEdit` may
 * contain `create`, `rename` and `delete` operations on files as well as text
 * edits — rust-analyzer emits a file rename when a module's name changes — and
 * the ticket-30 preview carries file *contents*, not file operations. Saying
 * "this rename moves files and the preview cannot show that" is the recorded
 * answer; quietly applying the text half and skipping the moves would leave the
 * workspace in exactly the state the ticket forbids.
 */
export function planWorkspaceEdit(edit: LspWorkspaceEdit, root: string): EditPlan {
	const byId = new Map<string, LspTextEdit[]>();
	const outside: string[] = [];

	const collect = (uri: string, edits: readonly LspTextEdit[]): void => {
		const id = fileIdFromUri(root, uri);
		if (!id) {
			outside.push(uri);
			return;
		}
		const existing = byId.get(id);
		if (existing) {
			existing.push(...edits);
		} else {
			byId.set(id, [...edits]);
		}
	};

	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if (!isTextDocumentEdit(change)) {
				// A create, rename or delete. Named rather than counted, because
				// "it also renames a file" is the sentence that tells someone why
				// they should do this in their own editor instead.
				return {
					ok: false,
					reason:
						'This rename also creates, moves or deletes files. The preview can only ' +
						'show content changes, so nothing has been done.',
				};
			}
			collect(change.textDocument.uri, change.edits);
		}
	} else if (edit.changes) {
		for (const [uri, edits] of Object.entries(edit.changes)) {
			collect(uri, edits);
		}
	}

	if (outside.length > 0) {
		// Refused whole rather than partially applied. An edit outside the root
		// is one `workspace.rs` would refuse anyway; applying the rest would
		// rename the symbol everywhere except where it is defined.
		return {
			ok: false,
			reason: `This rename edits ${outside.length} file${
				outside.length === 1 ? '' : 's'
			} outside the workspace, which is not allowed. Nothing has been done.`,
		};
	}

	const files = [...byId.entries()]
		.map(([id, edits]) => ({ id, edits }))
		.sort((a, b) => a.id.localeCompare(b.id));
	return files.length === 0
		? { ok: false, reason: 'The server returned no edits.' }
		: { ok: true, files };
}

/**
 * The character offsets each line of `text` starts at.
 *
 * Split on `\n` only. A `\r\n` file keeps its `\r` at the end of the line's
 * content, which is right: LSP counts characters within a line and the line
 * terminator is not part of the line, so a `\r` sits past every position a
 * server will name.
 */
function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
		starts.push(index + 1);
	}
	return starts;
}

/**
 * A position as an offset into `text`, clamped to somewhere real.
 *
 * Clamping rather than throwing: a server whose idea of the file is one
 * keystroke stale would otherwise abort the whole rename, and the staleness
 * check that actually protects the file is ticket 30's — it compares the entire
 * contents at apply time and refuses if they moved.
 */
function offsetAt(text: string, starts: readonly number[], line: number, character: number): number {
	const clampedLine = Math.min(Math.max(line, 0), starts.length - 1);
	const start = starts[clampedLine] ?? 0;
	const end = clampedLine + 1 < starts.length ? (starts[clampedLine + 1] ?? text.length) - 1 : text.length;
	return Math.min(start + Math.max(character, 0), end);
}

/**
 * Apply one file's edits, or undefined if they overlap.
 *
 * **Applied last-first.** Every edit's range is stated against the original
 * document, so applying one from the top shifts every offset below it; going
 * backwards means no edit ever moves another. This is the bug that makes a
 * rename look right in the first file and corrupt the twentieth.
 *
 * Overlapping edits are refused rather than resolved. The specification says a
 * server must not produce them, so an overlap means the server and this client
 * disagree about the document — and guessing at that disagreement is how a
 * rename eats a file.
 */
export function applyEdits(
	text: string,
	edits: readonly LspTextEdit[]
): { readonly text: string; readonly count: number } | undefined {
	const starts = lineStarts(text);
	const spans = edits
		.map((edit) => ({
			start: offsetAt(text, starts, edit.range.start.line, edit.range.start.character),
			end: offsetAt(text, starts, edit.range.end.line, edit.range.end.character),
			newText: edit.newText,
		}))
		.sort((a, b) => b.start - a.start || b.end - a.end);

	let out = text;
	let previousStart = text.length;
	for (const span of spans) {
		if (span.end > previousStart) {
			return undefined;
		}
		if (span.end < span.start) {
			return undefined; // An inverted range is not a document this can edit.
		}
		out = out.slice(0, span.start) + span.newText + out.slice(span.end);
		previousStart = span.start;
	}
	return { text: out, count: spans.length };
}

/**
 * One file's edits as the `Replacement` ticket 30's preview shows.
 *
 * `undefined` when the edits change nothing, on the same rule `planFile` uses:
 * a file listed in a preview reads as a file about to be written.
 */
export function toReplacement(
	id: string,
	original: string,
	edits: readonly LspTextEdit[]
): Replacement | undefined {
	const applied = applyEdits(original, edits);
	if (!applied || applied.text === original) {
		return undefined;
	}
	return { id, name: basename(id), original, modified: applied.text, count: applied.count };
}

/** Where the first edit is, so the preview can open the file at the symbol. */
export function firstLine(edits: readonly LspTextEdit[]): number {
	const lines = edits.map((edit: { range: LspRange }) => edit.range.start.line);
	return Math.min(...lines) + 1;
}
