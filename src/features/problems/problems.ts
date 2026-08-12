// Problems — ticket 32. Errors and warnings, grouped by file.
//
// **This file does not import Monaco**, and that is deliberate on two counts.
// It keeps the grouping runnable under bare `node` for its check, and it keeps
// the shape of a problem independent of where problems come from — ticket 33
// brings an LSP and a second source, and nothing here would have to change for
// it.
//
// ## The scope, decided and stated
//
// Monaco's TypeScript worker only knows about models that **exist**, and models
// are created when a file is opened in an editor. So this reports on **open
// files only**, and the panel says so in as many words rather than presenting a
// subset as though it were the workspace.
//
// The alternative — creating a model for every file in the tree so the worker
// sees them all — was rejected rather than skipped. It would parse and typecheck
// the entire project inside the WebView on every workspace open, hold every file
// in memory for as long as the window is up, and produce errors for files whose
// imports the worker cannot resolve anyway. That is ticket 33's problem, solved
// by a real language server outside the renderer, and doing a worse version of
// it here would make the honest version harder to arrive at.

import { basename } from '../../ids.ts';

export type Severity = 'error' | 'warning';

export interface Problem {
	/** Root-relative id of the file it is in. */
	readonly fileId: string;
	readonly severity: Severity;
	readonly message: string;
	/** 1-based, so the editor can reveal it directly. */
	readonly line: number;
	readonly column: number;
	/** Who reported it — `typescript`, `json`, and later a language server. */
	readonly source?: string;
}

/** One file's problems, in the order they should be shown. */
export interface ProblemFile {
	readonly id: string;
	readonly name: string;
	readonly problems: readonly Problem[];
	readonly errors: number;
	readonly warnings: number;
}

/**
 * Monaco's `MarkerSeverity`, by value rather than by import.
 *
 * The numbers are part of Monaco's public API and are what arrive in a marker.
 * Naming them here is what lets the grouping be checked without loading six
 * megabytes of editor into `node`.
 */
export const MARKER_SEVERITY = { hint: 1, info: 2, warning: 4, error: 8 } as const;

/**
 * Which of the two a marker is, or undefined for anything quieter.
 *
 * Hints and infos are dropped. A problems panel is a list of things to fix, and
 * TypeScript's hints are mostly style suggestions the editor already underlines
 * where they happen — putting them in a shared list is how the list stops being
 * read.
 */
export function severityOf(marker: number): Severity | undefined {
	if (marker === MARKER_SEVERITY.error) {
		return 'error';
	}
	return marker === MARKER_SEVERITY.warning ? 'warning' : undefined;
}

/**
 * Group problems by file, errors before warnings, earliest first.
 *
 * Duplicates are dropped. The same file can be open in the Modal Workbench and
 * pinned in the dock at the same time, which means two Monaco models over one
 * path and two identical markers for one mistake.
 */
export function groupProblems(problems: readonly Problem[]): readonly ProblemFile[] {
	const seen = new Set<string>();
	const byFile = new Map<string, Problem[]>();
	for (const problem of problems) {
		const key = `${problem.fileId}:${problem.line}:${problem.column}:${problem.severity}:${problem.message}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const list = byFile.get(problem.fileId);
		if (list) {
			list.push(problem);
		} else {
			byFile.set(problem.fileId, [problem]);
		}
	}

	return [...byFile.entries()]
		.map(([id, list]) => {
			const sorted = [...list].sort(
				(a, b) =>
					// Errors first: a warning above the error that caused it is a
					// list that has to be read twice.
					Number(b.severity === 'error') - Number(a.severity === 'error') ||
					a.line - b.line ||
					a.column - b.column
			);
			return {
				id,
				name: basename(id),
				problems: sorted,
				errors: sorted.filter((problem) => problem.severity === 'error').length,
				warnings: sorted.filter((problem) => problem.severity === 'warning').length,
			};
		})
		.sort((a, b) => b.errors - a.errors || a.id.localeCompare(b.id));
}

/** `3 errors, 1 warning` — the count the panel header carries. */
export function problemSummary(files: readonly ProblemFile[]): string {
	const errors = files.reduce((total, file) => total + file.errors, 0);
	const warnings = files.reduce((total, file) => total + file.warnings, 0);
	if (errors === 0 && warnings === 0) {
		return 'No problems';
	}
	const parts: string[] = [];
	if (errors > 0) {
		parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
	}
	if (warnings > 0) {
		parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
	}
	return parts.join(', ');
}

/** How a single problem reads in the list. */
export function problemLabel(problem: Problem): string {
	return `${problem.message} (${problem.line}:${problem.column})`;
}
