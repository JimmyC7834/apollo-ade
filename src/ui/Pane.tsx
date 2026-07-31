import type { ReactNode } from 'react';

export interface PaneProps {
	readonly title: string;
	/** Feature actions for the pane header, typically IconButtons. */
	readonly actions?: ReactNode;
	readonly children?: ReactNode;
}

/** Consistent region heading/body composition for sidebars and panels. */
export function Pane({ title, actions, children }: PaneProps) {
	return (
		<section className="ide-pane" aria-label={title}>
			<header className="ide-pane-header">
				<h2 className="ide-pane-title">{title}</h2>
				{actions ? <div className="ide-pane-actions">{actions}</div> : null}
			</header>
			<div className="ide-pane-body">{children}</div>
		</section>
	);
}
