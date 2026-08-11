// The workbench topology: where the regions are and what happens to focus when
// one disappears. It receives finished content as slots and knows nothing about
// what is inside them.
//
// Slice 40 replaced three regions with one. `primarySidebar`, `secondarySidebar`
// and `panel` are gone — the Shell Guide's model has no permanent panels, only
// chat and a dock of artifacts. The four features that lived in those regions
// were not deleted with them; they moved into the dock as artifacts. See
// `artifacts.ts`.

import { useEffect, useRef, type ReactNode } from 'react';

import type { DockSide } from '../artifacts';

export interface WorkbenchLayoutSlots {
	readonly titlebar: ReactNode;
	/** The Chat Workbench. Primary, and the only region that is always present. */
	readonly main: ReactNode;
	/** The Pinned Workbench, or nothing when no artifact is pinned. */
	readonly dock?: ReactNode;
	readonly overlays?: ReactNode;
	readonly announcement?: ReactNode;
}

export interface WorkbenchLayoutProps extends WorkbenchLayoutSlots {
	/** Which way chat and the dock split. The dock draws its own edge. */
	readonly side: DockSide;
}

export function WorkbenchLayout({
	titlebar,
	main,
	dock,
	overlays,
	announcement,
	side,
}: WorkbenchLayoutProps) {
	const mainRef = useRef<HTMLDivElement>(null);

	/*
	 * Focus-safe collapsing. Removing the dock unmounts whatever was inside it,
	 * and predicting whether focus was in there gets fiddly. Instead repair it
	 * afterwards: if the update left focus on nothing, the user is stranded, so
	 * hand it to main.
	 */
	useEffect(() => {
		const active = document.activeElement;
		if (!active || active === document.body) {
			mainRef.current?.focus();
		}
	}, [dock]);

	return (
		<div className="ide-workbench">
			{titlebar}

			<div className={`ide-body ide-body-${side}`}>
				{/*
				 * `position: relative` on this element is what the Session Navigator
				 * absolutely positions against — the navigator spans the Chat
				 * Workbench's height and no more.
				 */}
				<div
					className="ide-region ide-region-main"
					data-region="main"
					ref={mainRef}
					tabIndex={-1}
					role="main"
					aria-label="Main"
				>
					{main}
				</div>
				{dock}
			</div>

			{/*
			 * The live region is always mounted, empty or not: a screen reader
			 * only announces changes to a region it was already observing, so
			 * mounting it together with its first message announces nothing.
			 */}
			<div className="ide-visually-hidden" role="status" aria-live="polite">
				{announcement}
			</div>

			{overlays}
		</div>
	);
}
