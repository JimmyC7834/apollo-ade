import * as Menu from '@radix-ui/react-dropdown-menu';

import { Icon, IconButton } from '../ui';
import type { ThemeName } from '../ui/theme';
import type { WindowControls } from './useWindowControls';

export interface AdeMenuAction {
	readonly id: string;
	readonly label: string;
	/** Present when the item exists but cannot act yet; shown, not hidden. */
	readonly disabled?: string;
	readonly run: () => void;
}

export interface TitlebarProps {
	/** `workspace/branch`. The left half of the breadcrumb, always present. */
	readonly workspace: string;
	/** The right half. Absent until a session has a name — see slice 39. */
	readonly session?: string;
	readonly controls: WindowControls;
	readonly theme: ThemeName;
	readonly onToggleTheme: () => void;
	readonly menu: readonly AdeMenuAction[];
	/** Region visibility toggles, rendered before the window buttons. */
	readonly actions?: React.ReactNode;
}

/**
 * The 42px titlebar: ADE menu, breadcrumb, window controls.
 *
 * The three regions are fixed. The breadcrumb takes the space that is left and
 * **truncates rather than pushing** — the window controls sit at the same x
 * whatever the workspace is called. That is Shell Guide principle 6, and it is
 * bought here with `min-width: 0` on the drag region plus `text-overflow` on
 * the label, not with a width the caller has to know.
 *
 * The ADE menu is the only application menu. Its keyboard behaviour is Radix's:
 * Escape closes, focus returns to the button, and arrow keys move between items
 * without this file handling a single key.
 */
export function Titlebar({
	workspace,
	session,
	controls,
	theme,
	onToggleTheme,
	menu,
	actions,
}: TitlebarProps) {
	return (
		<header className="ide-titlebar">
			<Menu.Root>
				<Menu.Trigger className="ide-titlebar-menu" aria-label="ADE menu">
					ADE
					<Icon name="chevron-down" />
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Content className="ide-context-menu" align="start" sideOffset={0}>
						{menu.map((item) => (
							<Menu.Item
								key={item.id}
								className="ide-context-menu-item"
								disabled={item.disabled !== undefined}
								onSelect={item.run}
							>
								{item.label}
								{item.disabled ? (
									<span className="ide-context-menu-item-note">{item.disabled}</span>
								) : null}
							</Menu.Item>
						))}
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>

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
				<span className="ide-titlebar-title">
					{workspace}
					{session ? <span className="ide-titlebar-session"> / {session}</span> : null}
				</span>
			</div>

			{actions ? <div className="ide-titlebar-actions">{actions}</div> : null}

			<div className="ide-window-controls">
				<IconButton
					icon="color-mode"
					label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
					onClick={onToggleTheme}
				/>
				{controls.available ? (
					<>
						<IconButton icon="chrome-minimize" label="Minimize" onClick={controls.minimize} />
						<IconButton
							icon={controls.maximized ? 'chrome-restore' : 'chrome-maximize'}
							label={controls.maximized ? 'Restore' : 'Maximize'}
							onClick={controls.toggleMaximize}
						/>
						<IconButton icon="chrome-close" label="Close" onClick={controls.close} danger />
					</>
				) : null}
			</div>
		</header>
	);
}
