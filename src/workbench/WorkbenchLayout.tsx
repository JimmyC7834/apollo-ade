// The workbench topology: where the regions are, how big they are, and what
// happens to focus when one disappears. It receives finished content as slots
// and knows nothing about what is inside them — replacing this file should not
// require touching Explorer, Search, Changes, Terminal, or Editor.

import { useEffect, useRef, type ReactNode } from 'react';

import { ResizableSeparator } from '../ui';

export type WorkbenchRegion = 'primarySidebar' | 'secondarySidebar' | 'panel';

/** The compact state object: geometry only, no feature state. */
export interface WorkbenchLayoutState {
	readonly visible: Record<WorkbenchRegion, boolean>;
	readonly primaryWidth: number;
	readonly secondaryWidth: number;
	readonly panelHeight: number;
}

export const DEFAULT_LAYOUT: WorkbenchLayoutState = {
	visible: { primarySidebar: true, secondarySidebar: true, panel: true },
	primaryWidth: 260,
	secondaryWidth: 260,
	panelHeight: 220,
};

// Also `--ide-region-min` in `tokens.css`, which is the same floor stated to
// CSS: the sashes enforce it here, and the max-width rules enforce it there.
const MIN = 170;
const MAX_SIDEBAR = 600;
const MAX_PANEL = 600;

export interface WorkbenchLayoutSlots {
	readonly titlebar: ReactNode;
	readonly primarySidebar: ReactNode;
	readonly main: ReactNode;
	readonly secondarySidebar: ReactNode;
	readonly panel: ReactNode;
	readonly overlays?: ReactNode;
	readonly announcement?: ReactNode;
}

export interface WorkbenchLayoutProps extends WorkbenchLayoutSlots {
	readonly state: WorkbenchLayoutState;
	/**
	 * One callback carrying the whole next geometry. Deliberately not a set of
	 * per-region setters: those would leak widths and sash mechanics back out
	 * to the controller and make this interface shallow.
	 */
	readonly onChange: (next: WorkbenchLayoutState) => void;
}

export function WorkbenchLayout({
	titlebar,
	primarySidebar,
	main,
	secondarySidebar,
	panel,
	overlays,
	announcement,
	state,
	onChange,
}: WorkbenchLayoutProps) {
	const mainRef = useRef<HTMLDivElement>(null);
	const { visible, primaryWidth, secondaryWidth, panelHeight } = state;

	/*
	 * Focus-safe hiding. Hiding a region unmounts both the region and its
	 * separator, and the separator lives outside the region element — so
	 * predicting whether focus is about to be destroyed gets fiddly. Instead
	 * repair it afterwards: if the update left focus on nothing, the user is
	 * stranded, so hand it to main.
	 */
	useEffect(() => {
		const active = document.activeElement;
		if (!active || active === document.body) {
			mainRef.current?.focus();
		}
	}, [visible]);

	return (
		<div className="ide-workbench">
			{titlebar}

			<div className="ide-body">
				{visible.primarySidebar ? (
					<>
						<div
							className="ide-region ide-region-sidebar"
							data-region="primarySidebar"
							style={{ width: primaryWidth }}
						>
							{primarySidebar}
						</div>
						<ResizableSeparator
							label="Resize primary sidebar"
							orientation="vertical"
							value={primaryWidth}
							min={MIN}
							max={MAX_SIDEBAR}
							onChange={(value) => onChange({ ...state, primaryWidth: value })}
						/>
					</>
				) : null}

				<div className="ide-center">
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

					{visible.panel ? (
						<>
							<ResizableSeparator
								label="Resize panel"
								orientation="horizontal"
								value={panelHeight}
								min={MIN}
								max={MAX_PANEL}
								inverted
								onChange={(value) => onChange({ ...state, panelHeight: value })}
							/>
							<div
								className="ide-region ide-region-panel"
								data-region="panel"
								style={{ height: panelHeight }}
							>
								{panel}
							</div>
						</>
					) : null}
				</div>

				{visible.secondarySidebar ? (
					<>
						<ResizableSeparator
							label="Resize secondary sidebar"
							orientation="vertical"
							value={secondaryWidth}
							min={MIN}
							max={MAX_SIDEBAR}
							inverted
							onChange={(value) => onChange({ ...state, secondaryWidth: value })}
						/>
						<div
							className="ide-region ide-region-sidebar"
							data-region="secondarySidebar"
							style={{ width: secondaryWidth }}
						>
							{secondarySidebar}
						</div>
					</>
				) : null}
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
