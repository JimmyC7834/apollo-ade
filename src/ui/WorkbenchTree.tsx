import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Icon } from './Icon';
import { visibleRows, type TreeNode as BaseTreeNode } from './treeRows';

export interface TreeNode extends BaseTreeNode {
	/** Trailing content such as a Badge. Never focusable: rows own the focus. */
	readonly accessory?: ReactNode;
}

export interface WorkbenchTreeProps {
	readonly label: string;
	readonly nodes: readonly TreeNode[];
	readonly activeId?: string;
	/** Enter, Space, or click on a non-expandable node. */
	readonly onActivate: (id: string) => void;
	readonly onContextMenu?: (id: string, x: number, y: number) => void;
	readonly emptyMessage?: string;
	/**
	 * Ids that start expanded. Applied once per id, as it first appears — so
	 * groups that arrive later (search results) open, while anything the user
	 * has since collapsed stays collapsed.
	 */
	readonly defaultExpandedIds?: readonly string[];
}

/**
 * Accessible hierarchical navigation shared by Explorer, Changes, and Search.
 *
 * Nodes arrive as a flat, pre-ordered list linked by `parentId`: features
 * already know their own ordering, and a flat array keeps expansion filtering
 * to one pass. Expansion is internal state — no consumer has needed to drive
 * it from outside, and a controlled version can be added without changing this
 * signature.
 */
export function WorkbenchTree({
	label,
	nodes,
	activeId,
	onActivate,
	onContextMenu,
	emptyMessage = 'Nothing to show',
	defaultExpandedIds,
}: WorkbenchTreeProps) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(defaultExpandedIds));
	const appliedDefaults = useRef(new Set(defaultExpandedIds));

	useEffect(() => {
		const fresh = defaultExpandedIds?.filter((id) => !appliedDefaults.current.has(id)) ?? [];
		if (fresh.length === 0) {
			return;
		}
		for (const id of fresh) {
			appliedDefaults.current.add(id);
		}
		setExpanded((current) => new Set([...current, ...fresh]));
	}, [defaultExpandedIds]);
	const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
	const listRef = useRef<HTMLDivElement>(null);

	const rows = useMemo(() => visibleRows(nodes, expanded), [nodes, expanded]);

	function toggle(id: string, open: boolean): void {
		setExpanded((current) => {
			const next = new Set(current);
			if (open) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	}

	function focusRow(index: number): void {
		const target = rows[index]?.node;
		if (!target) {
			return;
		}
		setFocusedId(target.id);
		listRef.current
			?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(target.id)}"]`)
			?.focus();
	}

	function onKeyDown(event: React.KeyboardEvent, node: TreeNode, index: number): void {
		const isOpen = expanded.has(node.id);
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusRow(Math.min(index + 1, rows.length - 1));
				break;
			case 'ArrowUp':
				event.preventDefault();
				focusRow(Math.max(index - 1, 0));
				break;
			case 'ArrowRight':
				event.preventDefault();
				// Expand a closed node, else step into its first child.
				if (node.expandable && !isOpen) {
					toggle(node.id, true);
				} else if (node.expandable) {
					focusRow(index + 1);
				}
				break;
			case 'ArrowLeft': {
				event.preventDefault();
				// Collapse an open node, else jump out to the parent row.
				if (node.expandable && isOpen) {
					toggle(node.id, false);
					break;
				}
				const parentIndex = rows.findIndex((row) => row.node.id === node.parentId);
				if (parentIndex >= 0) {
					focusRow(parentIndex);
				}
				break;
			}
			case 'Home':
				event.preventDefault();
				focusRow(0);
				break;
			case 'End':
				event.preventDefault();
				focusRow(rows.length - 1);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				if (node.expandable) {
					toggle(node.id, !isOpen);
				} else {
					onActivate(node.id);
				}
				break;
			case 'ContextMenu': {
				// The keyboard has no pointer position, so anchor to the row.
				event.preventDefault();
				const rect = (event.target as HTMLElement).getBoundingClientRect();
				onContextMenu?.(node.id, rect.left, rect.bottom);
				break;
			}
		}
	}

	if (rows.length === 0) {
		return <p className="ide-tree-empty">{emptyMessage}</p>;
	}

	// Roving tabindex: exactly one row is reachable with Tab.
	const tabbableId =
		focusedId && rows.some((row) => row.node.id === focusedId) ? focusedId : rows[0]?.node.id;

	return (
		<div className="ide-tree" role="tree" aria-label={label} ref={listRef}>
			{rows.map(({ node, depth }, index) => {
				const isOpen = expanded.has(node.id);
				return (
					<div
						key={node.id}
						className={`ide-tree-row${node.id === activeId ? ' ide-tree-row-active' : ''}`}
						style={{ paddingLeft: `${depth * 12 + 6}px` }}
						role="treeitem"
						tabIndex={node.id === tabbableId ? 0 : -1}
						aria-level={depth + 1}
						aria-selected={node.id === activeId}
						aria-expanded={node.expandable ? isOpen : undefined}
						title={node.description ? `${node.label} — ${node.description}` : node.label}
						data-node-id={node.id}
						onFocus={() => setFocusedId(node.id)}
						onClick={() => (node.expandable ? toggle(node.id, !isOpen) : onActivate(node.id))}
						onKeyDown={(event) => onKeyDown(event, node, index)}
						onContextMenu={(event) => {
							if (!onContextMenu) {
								return;
							}
							event.preventDefault();
							setFocusedId(node.id);
							onContextMenu(node.id, event.clientX, event.clientY);
						}}
					>
						<span className="ide-tree-twistie">
							{node.expandable ? (
								<Icon name={isOpen ? 'chevron-down' : 'chevron-right'} />
							) : null}
						</span>
						{node.icon ? <Icon name={(isOpen && node.iconExpanded) || node.icon} /> : null}
						<span className="ide-tree-label">{node.label}</span>
						{node.description ? (
							<span className="ide-tree-description">{node.description}</span>
						) : null}
						{node.accessory ? <span className="ide-tree-accessory">{node.accessory}</span> : null}
					</div>
				);
			})}
		</div>
	);
}
