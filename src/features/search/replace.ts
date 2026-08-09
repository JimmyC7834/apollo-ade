// Replace across the workspace — ticket 30. The substitution and the staleness
// rule, with no React and no provider, so `replace.check.ts` can run the part
// that loses work if it is wrong.
//
// **Literal, and case-insensitive to match the search.** Regex was the other
// option and it is the one people ask for; it is also how a replace eats a
// codebase, and it would have to arrive with pattern validation, capture-group
// syntax in the replacement, and a preview nobody may skip. Literal is what the
// search box already does — `search_workspace` lowercases both sides — so
// matching its behaviour means the preview shows exactly the matches the list
// above it showed. A regex replace whose matches disagreed with the visible
// result list would be worse than no replace at all.
//
// **Per file, not per match.** Simpler, and it is what the result tree already
// groups by, so "apply this file" needs no new selection model. Per-match
// granularity is the thing to add if anyone reaches for it; nothing here is
// arranged against it.

export interface Replacement {
	/** Root-relative path. */
	readonly id: string;
	readonly name: string;
	/**
	 * The file as it was read when the preview was built.
	 *
	 * Kept so the apply can refuse a file that moved underneath it. Without this
	 * the preview is a picture of a file that may no longer exist in that form,
	 * and applying `modified` would silently discard whatever changed it.
	 */
	readonly original: string;
	readonly modified: string;
	/** How many occurrences `modified` differs from `original` by. */
	readonly count: number;
}

/**
 * Replace every case-insensitive occurrence of `query`, and say how many.
 *
 * Written as a scan rather than `String.replaceAll`, because the match is
 * case-insensitive and the replacement is not a pattern: building a `RegExp`
 * would mean escaping the query, and an escaping bug in a replace is the kind
 * of defect that is discovered by a user losing a file.
 *
 * An empty query matches nothing rather than everything. `''.indexOf` succeeds
 * at every position, so the naive loop would splice the replacement between
 * every pair of characters in the file.
 */
export function replaceAll(
	text: string,
	query: string,
	replacement: string
): { readonly text: string; readonly count: number } {
	if (query === '') {
		return { text, count: 0 };
	}
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();

	let out = '';
	let cursor = 0;
	let count = 0;
	for (;;) {
		const found = haystack.indexOf(needle, cursor);
		if (found === -1) {
			break;
		}
		out += text.slice(cursor, found) + replacement;
		cursor = found + needle.length;
		count += 1;
	}
	return count === 0 ? { text, count: 0 } : { text: out + text.slice(cursor), count };
}

/**
 * Build the replacement for one file, or nothing when it would change nothing.
 *
 * Returning `undefined` rather than a zero-count entry is what keeps the
 * preview list honest: a file listed with no changes reads as a file the apply
 * is about to touch.
 */
export function planFile(
	id: string,
	name: string,
	original: string,
	query: string,
	replacement: string
): Replacement | undefined {
	const { text, count } = replaceAll(original, query, replacement);
	return count === 0 ? undefined : { id, name, original, modified: text, count };
}

/** How the plan reads before anything has been written. */
export function planSummary(plans: readonly Replacement[]): string {
	if (plans.length === 0) {
		return 'Nothing to replace.';
	}
	const matches = plans.reduce((total, plan) => total + plan.count, 0);
	return (
		`${matches} replacement${matches === 1 ? '' : 's'} in ` +
		`${plans.length} file${plans.length === 1 ? '' : 's'}. Nothing is written until you apply.`
	);
}

/**
 * Why a planned file was not written, or undefined when it may be.
 *
 * The whole of the safety rule, in one place and out of the JSX, because both
 * halves are things that lose work silently if they are wrong.
 *
 * `current` is the file re-read at apply time, and `undefined` means it could
 * not be read at all — gone, renamed, or now too large. Comparing whole
 * contents rather than a timestamp is deliberate: a file that was edited and
 * edited back is not stale, and a clock is not evidence about bytes.
 */
export function refuseReason(
	plan: Replacement,
	current: string | undefined,
	dirty: boolean
): string | undefined {
	if (dirty) {
		// Not a confirmation prompt. The user has unsaved work in that editor, and
		// the only answers are "lose it" or "lose the replacement" — so the file is
		// left alone and named, which lets them save and apply again.
		return `${plan.id}: open with unsaved changes. Save it first.`;
	}
	if (current === undefined) {
		return `${plan.id}: could not be read.`;
	}
	if (current !== plan.original) {
		return `${plan.id}: changed on disk since the search. Search again.`;
	}
	return undefined;
}
