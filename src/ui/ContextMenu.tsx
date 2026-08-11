import * as Menu from '@radix-ui/react-dropdown-menu';

export interface ContextMenuItem {
	readonly id: string;
	readonly label: string;
	/** Renders destructively; does not by itself confirm anything. */
	readonly danger?: boolean;
	readonly run: () => void;
}

export interface ContextMenuProps {
	/** Viewport coordinates to anchor at, or undefined when closed. */
	readonly anchor: { readonly x: number; readonly y: number } | undefined;
	readonly label: string;
	readonly items: readonly ContextMenuItem[];
	readonly onClose: () => void;
}

/**
 * Anchored feature actions.
 *
 * Radix owns the parts that were hand-rolled here until slice 37: roving
 * focus, typeahead, outside-press dismissal, Escape, and focus return to the
 * opener. A context menu is invoked from a tree row, and losing that row would
 * strand a keyboard user in the document — Radix restores it, and it also
 * restores it in the cases the hand-rolled version got wrong.
 *
 * The trigger is a zero-size element positioned at the pointer, because Radix
 * positions against an element and this menu is anchored to a point. The props
 * are unchanged from the hand-rolled version, so no consumer moved.
 */
export function ContextMenu({ anchor, label, items, onClose }: ContextMenuProps) {
	return (
		<Menu.Root open={anchor !== undefined} onOpenChange={(open) => !open && onClose()} modal={false}>
			<Menu.Trigger
				aria-hidden
				tabIndex={-1}
				style={{
					position: 'fixed',
					left: anchor?.x ?? 0,
					top: anchor?.y ?? 0,
					width: 0,
					height: 0,
					pointerEvents: 'none',
				}}
			/>
			<Menu.Portal>
				<Menu.Content className="ide-context-menu" aria-label={label} align="start" sideOffset={0}>
					{items.map((item) => (
						<Menu.Item
							key={item.id}
							className={`ide-context-menu-item${item.danger ? ' ide-context-menu-item-danger' : ''}`}
							onSelect={item.run}
						>
							{item.label}
						</Menu.Item>
					))}
				</Menu.Content>
			</Menu.Portal>
		</Menu.Root>
	);
}
