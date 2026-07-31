/*
 * Lightweight subsequence scoring for the command center.
 *
 * Deliberately not a port of VS Code's ranking algorithm, and deliberately not
 * a dependency: a palette lives or dies on "typing `tog` puts Toggle Panel
 * first", which is a tie-break question, not an algorithmic one. Keeping this
 * ~40 lines means the tie-breaks stay ours to tune.
 */

const BONUS_WORD_START = 12;
/*
 * Contiguity outranks word starts. A run of characters the user typed straight
 * through is the strongest signal available — "file" must find "Open File"
 * rather than assembling itself from the initials of "Fix Little Errors".
 */
const BONUS_CONSECUTIVE = 16;
const BONUS_PREFIX = 10;
const PENALTY_GAP = 1;
/*
 * Gaps cost, but the cost is capped. An uncapped penalty scales with how far
 * apart the words are, which drowns out initials matching entirely — "ts"
 * would rank "Tabs" above "Toggle Secondary Sidebar" purely because the words
 * are close together. Skipping ahead to a new word is the point, not a defect.
 */
const PENALTY_GAP_MAX = 3;

function isWordStart(text: string, index: number): boolean {
	if (index === 0) {
		return true;
	}
	const previous = text[index - 1];
	const current = text[index];
	// Either a separator precedes it, or it is a camelCase hump.
	return (
		previous === ' ' ||
		previous === '/' ||
		previous === '.' ||
		previous === '-' ||
		previous === '_' ||
		(previous === previous.toLowerCase() && current === current.toUpperCase() && current !== current.toLowerCase())
	);
}

/**
 * Score `query` against `candidate`, higher is better.
 *
 * Returns undefined when the query is not a subsequence of the candidate, so
 * callers can filter and rank in one pass. An empty query matches everything
 * with score 0, which keeps the palette's initial listing stable.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
	if (query.length === 0) {
		return 0;
	}
	const haystack = candidate.toLowerCase();
	const needle = query.toLowerCase();

	let score = 0;
	let cursor = 0;
	let previousMatch = -1;

	for (const char of needle) {
		const found = haystack.indexOf(char, cursor);
		if (found === -1) {
			return undefined;
		}
		if (isWordStart(candidate, found)) {
			score += BONUS_WORD_START;
		}
		if (found === previousMatch + 1) {
			score += BONUS_CONSECUTIVE;
		}
		// Skipped characters cost, so tighter matches win — up to the cap.
		score -= Math.min((found - cursor) * PENALTY_GAP, PENALTY_GAP_MAX);
		previousMatch = found;
		cursor = found + 1;
	}

	if (haystack.startsWith(needle)) {
		score += BONUS_PREFIX;
	}
	// Among equal matches, prefer the shorter candidate.
	return score - candidate.length * 0.1;
}

export interface Scored<T> {
	readonly item: T;
	readonly score: number;
}

/** Filter to matches and sort best-first. Ties keep their original order. */
export function fuzzyFilter<T>(
	query: string,
	items: readonly T[],
	textOf: (item: T) => string
): Scored<T>[] {
	return items
		.map((item, index) => ({ item, index, score: fuzzyScore(query, textOf(item)) }))
		.filter((entry): entry is { item: T; index: number; score: number } => entry.score !== undefined)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ item, score }) => ({ item, score }));
}
