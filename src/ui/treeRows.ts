// Pure flattening logic for `WorkbenchTree`. It lives in its own module, free
// of JSX, so `npm run check` can run it under Node's type stripping.

import type { IconName } from './Icon';

export interface TreeNode {
	readonly id: string;
	/** Parent node id. Omitted for roots; a flat list is all roots. */
	readonly parentId?: string;
	readonly label: string;
	/** Muted trailing text, e.g. the containing directory. */
	readonly description?: string;
	readonly icon?: IconName;
	/** Swapped in while expanded, e.g. an open folder. */
	readonly iconExpanded?: IconName;
	readonly expandable?: boolean;
	/** Trailing content such as a Badge. Never focusable: rows own the focus. */
	readonly accessory?: unknown;
}

export interface TreeRow {
	readonly node: TreeNode;
	readonly depth: number;
	/**
	 * One entry per column between the left edge and this row's own content,
	 * outermost first: does the branch drawn in that column carry on *below*
	 * this row?
	 *
	 * The tree's guides are rules rather than box-drawing characters, and this
	 * is the one thing they cannot work out for themselves. The last entry is
	 * about the row itself — false means it is its parent's last child, so its
	 * own line stops here — and every earlier one is about an ancestor, which is
	 * what stops a grandparent's line running on past its final branch.
	 *
	 * Structural, like `depth`: a fact about the node list, not about what
	 * happens to be expanded. `guides.length === depth`.
	 */
	readonly guides: readonly boolean[];
}

/**
 * Flatten to the rows that are actually on screen.
 *
 * A node is visible only when every ancestor is expanded, and its depth is how
 * far up that chain goes. Both answers come from the same walk.
 */
export function visibleRows<T extends TreeNode>(
	nodes: readonly T[],
	expanded: ReadonlySet<string>
): readonly { node: T; depth: number; guides: readonly boolean[] }[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	// The last node declaring each parent. Roots share the `undefined` key, so a
	// flat list gets the same answer as a branch does.
	const lastChild = new Map<string | undefined, string>();
	for (const node of nodes) {
		lastChild.set(node.parentId, node.id);
	}
	const continues = (node: TreeNode) => lastChild.get(node.parentId) !== node.id;
	const rows: { node: T; depth: number; guides: readonly boolean[] }[] = [];
	for (const node of nodes) {
		let depth = 0;
		let visible = true;
		// Built innermost-first by the walk and reversed once at the end, which
		// is cheaper than searching downwards for each column in turn. The root
		// ancestor contributes no column — its children hang from the left edge
		// — so it is the one link in the chain that is skipped.
		const inner = [continues(node)];
		for (
			let parent: TreeNode | undefined = node.parentId ? byId.get(node.parentId) : undefined;
			parent;
			parent = parent.parentId ? byId.get(parent.parentId) : undefined
		) {
			depth += 1;
			visible &&= expanded.has(parent.id);
			if (parent.parentId && byId.has(parent.parentId)) {
				inner.push(continues(parent));
			}
		}
		if (visible) {
			rows.push({ node, depth, guides: inner.slice(0, depth).reverse() });
		}
	}
	return rows;
}
