// Where a symbol is used — ticket 34's one result set.
//
// ## Why this is not `SearchView`, written down because the ticket asked
//
// The ticket's warning is right: a second results view that looks almost like
// search is drift. But the thing search and references *share* is not the view
// — it is `WorkbenchTree` and the `onOpen(id, line)` contract, and both are
// already shared by the Explorer, the Problems panel and the Changes list.
// `SearchView` on top of that carries a query box, a replace box, a
// preview-and-apply pair and the staleness rule that protects them. References
// has none of those, so reusing it would mean rendering four dead controls or
// forking its body — and a search panel with a disabled search box is a worse
// lie than a list that says what it is.
//
// So the shared surface is the tree, and this file is only the grouping — the
// same split `problems.ts` makes, for the same reason: it is the part with
// arithmetic in it, and it runs under bare `node`.

import { basename } from '../../ids.ts';

export interface Reference {
	/** Root-relative id of the file it is in. */
	readonly fileId: string;
	/** 1-based, so the editor can reveal it directly. */
	readonly line: number;
	readonly column: number;
	/** The line's text, when the file was open enough to read it. */
	readonly preview?: string;
}

export interface ReferenceFile {
	readonly id: string;
	readonly name: string;
	readonly references: readonly Reference[];
}

/**
 * Group by file, earliest first, duplicates dropped.
 *
 * Duplicates are real here for two reasons and not one: the same file can be
 * open twice — the Modal Workbench and the dock — as `problems.ts` explains,
 * and a server may report the declaration both as itself and as a reference to
 * itself when `includeDeclaration` is set.
 */
export function groupReferences(references: readonly Reference[]): readonly ReferenceFile[] {
	const seen = new Set<string>();
	const byFile = new Map<string, Reference[]>();
	for (const reference of references) {
		const key = `${reference.fileId}:${reference.line}:${reference.column}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const list = byFile.get(reference.fileId);
		if (list) {
			list.push(reference);
		} else {
			byFile.set(reference.fileId, [reference]);
		}
	}

	return [...byFile.entries()]
		.map(([id, list]) => ({
			id,
			name: basename(id),
			references: [...list].sort((a, b) => a.line - b.line || a.column - b.column),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** `7 references in 3 files` — the count the panel header carries. */
export function referenceSummary(files: readonly ReferenceFile[]): string {
	const total = files.reduce((sum, file) => sum + file.references.length, 0);
	if (total === 0) {
		return 'No references';
	}
	return (
		`${total} reference${total === 1 ? '' : 's'} in ` +
		`${files.length} file${files.length === 1 ? '' : 's'}`
	);
}

/** How one hit reads in the list: its text if there is any, else its position. */
export function referenceLabel(reference: Reference): string {
	const preview = reference.preview?.trim();
	return preview ? `${preview}` : `Line ${reference.line}`;
}
