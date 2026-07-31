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
			    frameless window must reimplement itself. */}
			<div
				className="ide-titlebar-drag"
				onPointerDown={(event) => {
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
