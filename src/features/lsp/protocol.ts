// What LSP says, in the shapes this app needs — ticket 33, extended by 34 and 35.
//
// Three translations live here, and every one of them is arithmetic that is
// silently wrong rather than loudly wrong when it is off by one. That is the
// whole reason they are in a file with no Monaco import and no Tauri import:
// `protocol.check.ts` runs them under bare `node`.
//
// - **Positions.** LSP counts lines and characters from zero; Monaco counts
//   both from one. Every boundary between the two crosses this file.
// - **URIs.** A server addresses files by `file://` URI. This app addresses
//   them by root-relative id, and *only* by root-relative id, because that is
//   what `contained()` in `workspace.rs` will accept. A URI that does not
//   resolve to an id is a file outside the workspace, and saying so is how
//   ticket 34's containment question is answered rather than dodged.
// - **Severities.** LSP's 1-4 and Monaco's marker constants are both small
//   integers and they do not agree.

import { MARKER_SEVERITY, type Severity } from '../problems/problems.ts';

/** Zero-based, both fields. */
export interface LspPosition {
	readonly line: number;
	readonly character: number;
}

export interface LspRange {
	readonly start: LspPosition;
	readonly end: LspPosition;
}

export interface LspLocation {
	readonly uri: string;
	readonly range: LspRange;
}

export interface LspDiagnostic {
	readonly range: LspRange;
	/** 1 error, 2 warning, 3 information, 4 hint. Absent means error. */
	readonly severity?: number;
	readonly message: string;
	readonly source?: string;
}

export interface LspTextEdit {
	readonly range: LspRange;
	readonly newText: string;
}

/** One-based, both fields — what Monaco and this app's `revealLine` want. */
export interface EditorPosition {
	readonly lineNumber: number;
	readonly column: number;
}

export function toEditorPosition(position: LspPosition): EditorPosition {
	return { lineNumber: position.line + 1, column: position.character + 1 };
}

export function toLspPosition(position: EditorPosition): LspPosition {
	return { line: position.lineNumber - 1, character: position.column - 1 };
}

export interface EditorRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export function toEditorRange(range: LspRange): EditorRange {
	const start = toEditorPosition(range.start);
	const end = toEditorPosition(range.end);
	return {
		startLineNumber: start.lineNumber,
		startColumn: start.column,
		endLineNumber: end.lineNumber,
		endColumn: end.column,
	};
}

/**
 * LSP severity as a Monaco marker severity, or undefined for the quiet ones.
 *
 * Information and hint are dropped for exactly the reason `problems.ts` drops
 * Monaco's: a problems list is a list of things to fix, and rust-analyzer emits
 * hints — "consider adding a type annotation" — freely enough to bury the
 * errors. Absent severity means error, per the specification.
 */
export function toMarkerSeverity(severity: number | undefined): number | undefined {
	if (severity === undefined || severity === 1) {
		return MARKER_SEVERITY.error;
	}
	return severity === 2 ? MARKER_SEVERITY.warning : undefined;
}

/** The same, as this app's own two-valued severity. */
export function toProblemSeverity(severity: number | undefined): Severity | undefined {
	const marker = toMarkerSeverity(severity);
	if (marker === MARKER_SEVERITY.error) {
		return 'error';
	}
	return marker === MARKER_SEVERITY.warning ? 'warning' : undefined;
}

/**
 * A root-relative id as the `file://` URI a server addresses it by.
 *
 * Windows is the whole difficulty. `C:\a\b` has to become `file:///c:/a/b` —
 * three slashes for the empty authority, forward separators, and a drive letter
 * servers are inconsistent about the case of. Each segment is percent-encoded
 * because a path is not a URL and `#` in a filename would otherwise start a
 * fragment.
 */
export function fileUri(root: string, id: string): string {
	const path = `${root.replace(/[\\/]+$/, '')}${id ? `/${id}` : ''}`.replace(/\\/g, '/');
	const [first, ...rest] = path.split('/');
	// A drive letter is not a path segment and must not be encoded: `C%3A` is a
	// segment named "C:", which is not a drive.
	const head = /^[a-zA-Z]:$/.test(first ?? '') ? `/${(first ?? '').toLowerCase()}` : (first ?? '');
	return `file://${[head, ...rest.map(encodeURIComponent)].join('/')}`;
}

/**
 * Which workspace file a URI names, or undefined when it names none.
 *
 * **Undefined is the containment answer, not a failure to parse.** A definition
 * inside `~/.cargo/registry` or `%USERPROFILE%\.rustup` resolves to a real file
 * that `workspace.rs` will refuse to read, and it refuses on purpose. Returning
 * undefined here is what lets the caller say so plainly instead of widening the
 * root to make a click work.
 */
export function fileIdFromUri(root: string, uri: string): string | undefined {
	if (!uri.startsWith('file://')) {
		return undefined;
	}
	const decode = (value: string) => {
		try {
			return decodeURIComponent(value);
		} catch {
			return value; // A stray `%` is not worth throwing over.
		}
	};
	const normalise = (value: string) =>
		decode(value)
			.replace(/\\/g, '/')
			.replace(/^\/+(?=[a-zA-Z]:)/, '') // `/C:/a` and `C:/a` are the same place.
			.replace(/\/+$/, '');

	const path = normalise(uri.slice('file://'.length));
	const base = normalise(root);
	// Windows paths are case-insensitive and servers disagree with the OS about
	// the drive letter's case; comparing case-insensitively is what stops
	// `file:///c:/…` failing to match a root spelled `C:\…`. The id itself keeps
	// the server's spelling of the segments below the root, which is where case
	// does matter on the platforms that care.
	if (path.toLowerCase() !== base.toLowerCase() && !path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
		return undefined;
	}
	const id = path.slice(base.length).replace(/^\/+/, '');
	// `..` cannot appear in an id `contained()` will accept, and a URI is not a
	// trusted source of one.
	return id !== '' && !id.split('/').includes('..') ? id : undefined;
}
