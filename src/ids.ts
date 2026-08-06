// Rules over the string ids the workbench identifies things by.
//
// Everything here existed already, two or three times each, which is the whole
// reason the file does: `parentOf` in the explorer and `directoryOf` in the
// changes view were the same six characters under two names, `basename` was a
// private function in `workspace.ts` and an inlined `slice` twice in
// `changes.ts`, and closing a tab picked its neighbour in two places that had
// to be read side by side to see they agreed.
//
// A file id is a workspace-relative path with forward slashes — the shape Rust
// hands back, on every platform. Nothing here parses a Windows path, and
// nothing here should be reached for when a real path is in hand.

/** Directory part of `src/a/b.ts` → `"src/a"`; undefined at the root. */
export function dirname(id: string): string | undefined {
	const cut = id.lastIndexOf('/');
	return cut < 0 ? undefined : id.slice(0, cut);
}

/** File part of `src/a/b.ts` → `"b.ts"`; the whole id at the root. */
export function basename(id: string): string {
	return id.slice(id.lastIndexOf('/') + 1);
}

/**
 * Which item to select once `id` closes: the one that takes its place, or the
 * one before it at the end of the list.
 *
 * Undefined when nothing is left, which is the answer both callers want — an
 * empty tab strip selects nothing rather than keeping a dead id.
 */
export function neighbourId<T extends { readonly id: string }>(
	items: readonly T[],
	id: string
): string | undefined {
	const index = items.findIndex((item) => item.id === id);
	const rest = items.filter((item) => item.id !== id);
	return (rest[index] ?? rest[index - 1])?.id;
}
