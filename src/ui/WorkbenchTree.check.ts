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

// The shape the guides exist for: a last child that is itself a parent. `z` ends
// `lib`'s children, so the column `z`'s own children hang beside must stop at
// `z` — which is a fact about `z`, discovered while drawing `z/one.ts`.
const NESTED: TreeNode[] = [
	{ id: 'lib', label: 'lib', expandable: true },
	{ id: 'lib/y', parentId: 'lib', label: 'y', expandable: true },
	{ id: 'lib/y/one.ts', parentId: 'lib/y', label: 'one.ts' },
	{ id: 'lib/z', parentId: 'lib', label: 'z', expandable: true },
	{ id: 'lib/z/one.ts', parentId: 'lib/z', label: 'one.ts' },
	{ id: 'lib/z/two.ts', parentId: 'lib/z', label: 'two.ts' },
];

const ids = (expanded: string[]) =>
	visibleRows(TREE, new Set(expanded)).map((row) => `${row.node.id}@${row.depth}`);

const guides = (nodes: TreeNode[], expanded: string[]) =>
	visibleRows(nodes, new Set(expanded)).map(
		(row) => `${row.node.id}:${row.guides.map((on) => (on ? '|' : '.')).join('')}`
	);

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

// A root has no column at all, and one guide per level below it. `src/a` has a
// later sibling so its column carries on; `src/main.ts` does not, so it stops.
assert.deepEqual(guides(TREE, ['src', 'src/a']), [
	'src:',
	'src/a:|',
	'src/a/deep.ts:|.',
	'src/main.ts:.',
	'README.md:',
]);

// The case a single `last` flag gets wrong. `lib/z` is `lib`'s last child, so
// the outer column beside *its children* must already have stopped — both of
// them read `.` in column 0, where `lib/y/one.ts` reads `|`.
assert.deepEqual(guides(NESTED, ['lib', 'lib/y', 'lib/z']), [
	'lib:',
	'lib/y:|',
	'lib/y/one.ts:|.',
	'lib/z:.',
	'lib/z/one.ts:.|',
	'lib/z/two.ts:..',
]);

// Collapsing changes what is visible and never changes what a visible row draws.
assert.deepEqual(guides(TREE, []), ['src:', 'README.md:']);

// `guides.length === depth`, at every depth, for every shape above.
for (const nodes of [TREE, NESTED]) {
	for (const row of visibleRows(nodes, new Set(nodes.map((node) => node.id)))) {
		assert.equal(row.guides.length, row.depth, row.node.id);
	}
}

// A flat list (Changes with no grouping) is all roots and always visible.
const flat: TreeNode[] = [
	{ id: 'x.ts', label: 'x.ts' },
	{ id: 'y.ts', label: 'y.ts' },
];
assert.deepEqual(
	visibleRows(flat, new Set()).map((row) => row.node.id),
	['x.ts', 'y.ts']
);

// …and draws no guides, because every row of it is a root.
assert.deepEqual(
	visibleRows(flat, new Set()).map((row) => row.guides.length),
	[0, 0]
);

// A dangling parentId must not hide the node or crash the walk.
assert.deepEqual(
	visibleRows([{ id: 'orphan', parentId: 'gone', label: 'orphan' }], new Set()).map(
		(row) => row.node.id
	),
	['orphan']
);

console.log('WorkbenchTree.check.ts: ok');
