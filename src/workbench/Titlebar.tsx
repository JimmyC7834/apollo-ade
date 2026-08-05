import { IconButton } from '../ui';
import type { WindowControls } from './useWindowControls';

export interface TitlebarProps {
	readonly title: string;
	readonly controls: WindowControls;
	/** Region visibility toggles, rendered before the window buttons. */
	readonly actions?: React.ReactNode;
}

export function Titlebar({ title, controls, actions }: TitlebarProps) {
	return (
		<header className="ide-titlebar">
			{/* The drag region also handles double-click to maximize, which a
			    frameless window must reimplement itself.

			    `onMouseDown`, not `onPointerDown`: `detail` is the click count on a
			    mouse event and **0 on every pointer event**, which the spec requires
			    and Chromium honours. So the guard below was never true and the window
			    never dragged — from slice 1 until it was measured. The guard itself is
			    worth keeping: without it the second press of a double-click starts a
			    drag, which swallows the maximize. */}
			<div
				className="ide-titlebar-drag"
				onMouseDown={(event) => {
					if (event.button === 0 && event.detail === 1) {
						controls.startDragging();
					}
				}}
				onDoubleClick={controls.toggleMaximize}
			>
				<span className="ide-titlebar-title">{title}</span>
			</div>

			{actions ? <div className="ide-titlebar-actions">{actions}</div> : null}

			{controls.available ? (
				<div className="ide-window-controls">
					<IconButton icon="chrome-minimize" label="Minimize" onClick={controls.minimize} />
					<IconButton
						icon={controls.maximized ? 'chrome-restore' : 'chrome-maximize'}
						label={controls.maximized ? 'Restore' : 'Maximize'}
						onClick={controls.toggleMaximize}
					/>
					<IconButton icon="chrome-close" label="Close" onClick={controls.close} danger />
				</div>
			) : null}
		</header>
	);
}
