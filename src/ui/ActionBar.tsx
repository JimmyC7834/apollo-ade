import type { ReactNode } from 'react';

export interface ActionBarProps {
	readonly label: string;
	readonly children: ReactNode;
}

/**
 * Compact group of feature actions, typically IconButtons.
 *
 * `role="toolbar"` without arrow-key roving: these groups hold two or three
 * buttons, and Tab through them is the behavior users get from every other
 * button group in the workbench. Add roving focus when a bar grows large
 * enough that tabbing through it is a nuisance.
 */
export function ActionBar({ label, children }: ActionBarProps) {
	return (
		<div className="ide-action-bar" role="toolbar" aria-label={label}>
			{children}
		</div>
	);
}
