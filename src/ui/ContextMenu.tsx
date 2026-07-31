import { useEffect, useRef } from 'react';

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
 * Focus enters the menu on open and returns to whatever opened it on close —
 * a context menu is invoked from a tree row, and losing that row would strand
 * a keyboard user in the document.
 */
export function ContextMenu({ anchor, label, items, onClose }: ContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const openerRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!anchor) {
			// Only reclaim focus if it is still inside the menu being removed;
			// a click elsewhere has already put focus where the user wanted it.
			const opener = openerRef.current;
			openerRef.current = null;
			if (opener?.isConnected && !document.activeElement?.closest('.ide-context-menu')) {
				opener.focus();
			}
			return;
		}
		openerRef.current = document.activeElement as HTMLElement | null;
		menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
	}, [anchor]);

	useEffect(() => {
		if (!anchor) {
			return;
		}
		// Any press outside dismisses. pointerdown rather than click, so the
		// menu is gone before the press lands on whatever is underneath.
		function onPointerDown(event: PointerEvent): void {
			if (!menuRef.current?.contains(event.target as Node)) {
				onClose();
			}
		}
		window.addEventListener('pointerdown', onPointerDown);
		return () => window.removeEventListener('pointerdown', onPointerDown);
	}, [anchor, onClose]);

	if (!anchor) {
		return null;
	}

	function focusItem(index: number): void {
		const buttons = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
		if (!buttons?.length) {
			return;
		}
		buttons[(index + buttons.length) % buttons.length].focus();
	}

	function onKeyDown(event: React.KeyboardEvent, index: number): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			focusItem(index + 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			focusItem(index - 1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			focusItem(0);
		} else if (event.key === 'End') {
			event.preventDefault();
			focusItem(items.length - 1);
		}
	}

	return (
		<div
			className="ide-context-menu"
			role="menu"
			aria-label={label}
			ref={menuRef}
			style={{ left: anchor.x, top: anchor.y }}
		>
			{items.map((item, index) => (
				<button
					key={item.id}
					type="button"
					role="menuitem"
					className={`ide-context-menu-item${item.danger ? ' ide-context-menu-item-danger' : ''}`}
					onClick={() => {
						// Close first, so focus restoration happens before the
						// action moves focus somewhere of its own.
						onClose();
						item.run();
					}}
					onKeyDown={(event) => onKeyDown(event, index)}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}
