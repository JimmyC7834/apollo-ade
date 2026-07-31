// Run with `npm run check`. No framework: Node strips the types and the
// assertions either hold or the process exits non-zero.

import assert from 'node:assert/strict';

import { visibleRows, type TreeNode } from './treeRows.ts';

const TREE: TreeNode[] = [
	{ id: 'src', label: 'src', expandable: true },
	{ id: 'src/a', parentId: 'src', label: 'a', expandable: true },
	{ id: 'src/a/deep.ts', parentId: 'src/a', label: 'deep.ts' },
	{ id: 'src/main.ts', parentId: 'src', label: 'main.ts' },
	{ id: 'README.md', label: 'README.md' },
];

const ids = (expanded: string[]) =>
	visibleRows(TREE, new Set(expanded)).map((row) => `${row.node.id}@${row.depth}`);

// Collapsed: only roots, all at depth 0.
assert.deepEqual(ids([]), ['src@0', 'README.md@0']);

// Expanding a node reveals its children, one level deeper.
assert.deepEqual(ids(['src']), ['src@0', 'src/a@1', 'src/main.ts@1', 'README.md@0']);

// Depth is structural, not a function of what is expanded.
assert.deepEqual(ids(['src', 'src/a']), [
	'src@0',
	'src/a@1',
	'src/a/deep.ts@2',
	'src/main.ts@1',
	'README.md@0',
]);

// A grandchild stays hidden while any ancestor is collapsed, even when its own
// parent is expanded — the bug a naive one-level check would let through.
assert.deepEqual(ids(['src/a']), ['src@0', 'README.md@0']);

// A flat list (Changes with no grouping) is all roots and always visible.
const flat: TreeNode[] = [
	{ id: 'x.ts', label: 'x.ts' },
	{ id: 'y.ts', label: 'y.ts' },
];
assert.deepEqual(
	visibleRows(flat, new Set()).map((row) => row.node.id),
	['x.ts', 'y.ts']
);

// A dangling parentId must not hide the node or crash the walk.
assert.deepEqual(
	visibleRows([{ id: 'orphan', parentId: 'gone', label: 'orphan' }], new Set()).map(
		(row) => row.node.id
	),
	['orphan']
);

console.log('WorkbenchTree.check.ts: ok');
