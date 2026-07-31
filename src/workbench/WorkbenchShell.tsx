import { useCallback, useEffect, useRef, useState } from 'react';

import { IconButton, Pane, ResizableSeparator } from '../ui';
import { AccessibilityHelp } from './AccessibilityHelp';
import { Titlebar } from './Titlebar';
import { useWindowControls } from './useWindowControls';

const MIN = 170;
const MAX_SIDEBAR = 600;
const MAX_PANEL = 600;

type Region = 'primarySidebar' | 'secondarySidebar' | 'panel';

export function WorkbenchShell() {
	const controls = useWindowControls();
	const mainRef = useRef<HTMLDivElement>(null);

	const [visible, setVisible] = useState<Record<Region, boolean>>({
		primarySidebar: true,
		secondarySidebar: true,
		panel: true,
	});
	const [primaryWidth, setPrimaryWidth] = useState(260);
	const [secondaryWidth, setSecondaryWidth] = useState(260);
	const [panelHeight, setPanelHeight] = useState(220);
	const [helpOpen, setHelpOpen] = useState(false);

	const toggle = useCallback((region: Region) => {
		setVisible((current) => ({ ...current, [region]: !current[region] }));
	}, []);

	// Stable, so the dialog's native `close` listener is not rebound every render.
	const closeHelp = useCallback(() => setHelpOpen(false), []);

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
			<Titlebar
				title="ADE"
				controls={controls}
				actions={
					<>
						<IconButton
							icon="layout-sidebar-left"
							label="Toggle primary sidebar"
							pressed={visible.primarySidebar}
							onClick={() => toggle('primarySidebar')}
						/>
						<IconButton
							icon="layout-panel"
							label="Toggle panel"
							pressed={visible.panel}
							onClick={() => toggle('panel')}
						/>
						<IconButton
							icon="layout-sidebar-right"
							label="Toggle secondary sidebar"
							pressed={visible.secondarySidebar}
							onClick={() => toggle('secondarySidebar')}
						/>
						<IconButton
							icon="question"
							label="Keyboard help"
							onClick={() => setHelpOpen(true)}
						/>
					</>
				}
			/>

			<div className="ide-body">
				{visible.primarySidebar ? (
					<>
						<div
							className="ide-region ide-region-sidebar"
							data-region="primarySidebar"
							style={{ width: primaryWidth }}
						>
							<Pane title="Explorer" />
						</div>
						<ResizableSeparator
							label="Resize primary sidebar"
							orientation="vertical"
							value={primaryWidth}
							min={MIN}
							max={MAX_SIDEBAR}
							onChange={setPrimaryWidth}
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
					/>

					{visible.panel ? (
						<>
							<ResizableSeparator
								label="Resize panel"
								orientation="horizontal"
								value={panelHeight}
								min={MIN}
								max={MAX_PANEL}
								inverted
								onChange={setPanelHeight}
							/>
							<div
								className="ide-region ide-region-panel"
								data-region="panel"
								style={{ height: panelHeight }}
							>
								<Pane title="Panel" />
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
							onChange={setSecondaryWidth}
						/>
						<div
							className="ide-region ide-region-sidebar"
							data-region="secondarySidebar"
							style={{ width: secondaryWidth }}
						>
							<Pane title="Changes" />
						</div>
					</>
				) : null}
			</div>

			<AccessibilityHelp open={helpOpen} onClose={closeHelp} />
		</div>
	);
}
