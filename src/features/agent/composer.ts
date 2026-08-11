// The composer's pure half — ticket 42.
//
// Everything here is a string-to-string function so it can be checked by plain
// `node`, and so the parts of the composer that are easy to get subtly wrong —
// which folder a path drills into, whether an attachment is already mentioned —
// are reviewable without a browser.

import type { Profile } from '../../agent/profile';
import { contextWindowFor } from '../../agent/models.ts';

/** One row of the Context Explorer's flat listing. */
export interface ExplorerEntry {
	readonly name: string;
	/** Root-relative, no leading slash. The id a file is opened by. */
	readonly path: string;
	readonly kind: 'dir' | 'file';
}

/**
 * The immediate children of `path`, folders first.
 *
 * Derived from the flat file list the chat already holds for `@` rather than
 * from a second tree: the explorer is a view of the same workspace, and giving
 * it its own provider would put a filesystem seam inside the chat that ticket 27
 * deliberately kept out.
 *
 * **A folder with no files in it anywhere below is invisible here**, because a
 * list of files cannot know about one. That is the cost of not adding the seam,
 * and it is a directory nobody can attach anything from.
 */
export function children(files: readonly string[], path: string): readonly ExplorerEntry[] {
	const prefix = path ? `${path}/` : '';
	const dirs = new Set<string>();
	const found: ExplorerEntry[] = [];
	for (const file of files) {
		if (!file.startsWith(prefix)) {
			continue;
		}
		const rest = file.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash === -1) {
			found.push({ name: rest, path: file, kind: 'file' });
			continue;
		}
		const name = rest.slice(0, slash);
		if (!dirs.has(name)) {
			dirs.add(name);
			found.push({ name, path: `${prefix}${name}`, kind: 'dir' });
		}
	}
	return found.sort((left, right) =>
		left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'dir' ? -1 : 1
	);
}

/** What the path bar shows. The root has a name, because "" is not a place. */
export function pathLabel(path: string): string {
	return path || 'Workspace';
}

/**
 * A context window as the bottom bar says it: `128k`, `1M`, or nothing known.
 *
 * Not `toLocaleString`: the bar is 32px and this is one of four things on it, so
 * `128,000` spends six characters saying what three say. It is also the only
 * number here that is the same in every locale.
 */
export function formatContext(window: number | undefined): string {
	if (window === undefined) {
		return 'context unknown';
	}
	return window >= 1_000_000
		? `${Math.round(window / 100_000) / 10}M`
		: `${Math.round(window / 1000)}k`;
}

/**
 * `model · effort · maximum context` — read-only, per the Shell Guide.
 *
 * Read-only because each of the three is changed somewhere else: the model and
 * the effort in the profile, and the window by the model. A control here would
 * be a fourth place to set two of them.
 */
export function profileSummary(profile: Profile): string {
	return [
		profile.model.id || 'no model',
		profile.thinkingLevel,
		formatContext(contextWindowFor(profile.model.id)),
	].join(' · ');
}

/**
 * The prompt as it is sent, with the draft attachments folded in.
 *
 * An attachment is an `@` mention, not a second payload channel. Ticket 27
 * landed `@src/agent/env.ts` reaching the model as a path, and the model already
 * knows what to do with one — inventing an attachment envelope would mean a
 * second thing to teach it that says exactly the same thing.
 *
 * Already-mentioned paths are dropped rather than repeated: dragging a file in
 * and then typing its name is one file, and saying it twice invites the model to
 * read it twice.
 */
export function withAttachments(prompt: string, attachments: readonly string[]): string {
	const wanted = attachments.filter(
		(path, index) => attachments.indexOf(path) === index && !prompt.includes(`@${path}`)
	);
	return wanted.length === 0 ? prompt : `${wanted.map((path) => `@${path}`).join(' ')}\n${prompt}`;
}

/**
 * The ring's stroke dash pair for a percentage, on a circle of radius `r`.
 *
 * Here rather than inline in the SVG because it is the one part of the ring that
 * can be wrong without looking wrong — a full ring and an empty one are both
 * plausible pictures of "no usage yet".
 */
export function ringDash(percent: number, radius: number): string {
	const circumference = 2 * Math.PI * radius;
	const filled = (Math.min(100, Math.max(0, percent)) / 100) * circumference;
	return `${filled.toFixed(2)} ${(circumference - filled).toFixed(2)}`;
}
