import { useRef } from 'react';

import { Icon } from './Icon';

export interface TabItem {
	readonly id: string;
	readonly label: string;
	/** Shown on hover; typically the full path. */
	readonly title?: string;
	/** Renders an unsaved marker and announces "unsaved" to screen readers. */
	readonly dirty?: boolean;
}

export interface TabsProps {
	readonly label: string;
	readonly items: readonly TabItem[];
	readonly activeId: string | undefined;
	readonly onSelect: (id: string) => void;
	readonly onClose?: (id: string) => void;
}

/**
 * Accessible tab strip with roving focus.
 *
 * Only the active tab is tabbable, so Tab moves past the strip rather than
 * through every open file; arrow keys move between tabs, which is what the
 * tablist pattern expects.
 */
export function Tabs({ label, items, activeId, onSelect, onClose }: TabsProps) {
	const stripRef = useRef<HTMLDivElement>(null);

	function focusTab(index: number): void {
		const tabs = stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
		tabs?.[index]?.focus();
	}

	function onKeyDown(event: React.KeyboardEvent, index: number): void {
		let next: number | undefined;
		if (event.key === 'ArrowRight') {
			next = (index + 1) % items.length;
		} else if (event.key === 'ArrowLeft') {
			next = (index - 1 + items.length) % items.length;
		} else if (event.key === 'Home') {
			next = 0;
		} else if (event.key === 'End') {
			next = items.length - 1;
		}
		if (next !== undefined) {
			event.preventDefault();
			onSelect(items[next].id);
			focusTab(next);
			return;
		}
		// Delete closes the focused tab, matching the close button's action.
		if (onClose && (event.key === 'Delete' || event.key === 'Backspace')) {
			event.preventDefault();
			onClose(items[index].id);
		}
	}

	return (
		<div className="ide-tabs" role="tablist" aria-label={label} ref={stripRef}>
			{items.map((item, index) => {
				const selected = item.id === activeId;
				return (
					<div
						key={item.id}
						className={`ide-tab${selected ? ' ide-tab-active' : ''}`}
						role="tab"
						tabIndex={selected ? 0 : -1}
						aria-selected={selected}
						title={item.title ?? item.label}
						onClick={() => onSelect(item.id)}
						onKeyDown={(event) => onKeyDown(event, index)}
					>
						<span className="ide-tab-label">{item.label}</span>
						{item.dirty ? (
							<>
								<span className="ide-tab-dirty" aria-hidden="true" />
								<span className="ide-visually-hidden">unsaved</span>
							</>
						) : null}
						{onClose ? (
							<button
								type="button"
								className="ide-tab-close"
								aria-label={`Close ${item.label}`}
								// Keep the click from also selecting the tab being closed.
								onClick={(event) => {
									event.stopPropagation();
									onClose(item.id);
								}}
								tabIndex={-1}
							>
								<Icon name="close" />
							</button>
						) : null}
					</div>
				);
			})}
		</div>
	);
}
