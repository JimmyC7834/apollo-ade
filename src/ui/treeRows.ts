// Pure flattening logic for `WorkbenchTree`. It lives in its own module, free
// of JSX, so `npm run check` can run it under Node's type stripping.

export interface TreeNode {
	readonly id: string;
	/** Parent node id. Omitted for roots; a flat list is all roots. */
	readonly parentId?: string;
	readonly label: string;
	/** Muted trailing text, e.g. the containing directory. */
	readonly description?: string;
	readonly icon?: string;
	/** Swapped in while expanded, e.g. an open folder. */
	readonly iconExpanded?: string;
	readonly expandable?: boolean;
	/** Trailing content such as a Badge. Never focusable: rows own the focus. */
	readonly accessory?: unknown;
}

export interface TreeRow {
	readonly node: TreeNode;
	readonly depth: number;
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
): readonly { node: T; depth: number }[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const rows: { node: T; depth: number }[] = [];
	for (const node of nodes) {
		let depth = 0;
		let visible = true;
		for (
			let parent: TreeNode | undefined = node.parentId ? byId.get(node.parentId) : undefined;
			parent;
			parent = parent.parentId ? byId.get(parent.parentId) : undefined
		) {
			depth += 1;
			visible &&= expanded.has(parent.id);
		}
		if (visible) {
			rows.push({ node, depth });
		}
	}
	return rows;
}
