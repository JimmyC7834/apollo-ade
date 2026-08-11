import { useCallback, useEffect, useRef, type ReactNode } from 'react';

import { clampDock, type ArtifactRef, type DockSide } from '../artifacts';
import { Icon, IconButton } from '../ui';

export interface PinnedWorkbenchProps {
	readonly side: DockSide;
	/** Fraction of the workbench the dock takes. Already clamped by the caller. */
	readonly fraction: number;
	readonly onFraction: (next: number) => void;
	readonly collapsed: boolean;
	readonly onCollapsed: (next: boolean) => void;
	readonly artifacts: readonly ArtifactRef[];
	readonly activeId: string | undefined;
	readonly onSelect: (id: string) => void;
	readonly onUnpin: (id: string) => void;
	readonly children: ReactNode;
}

/**
 * The artifact dock: right of chat in landscape, below it in portrait.
 *
 * Three things here are requirements rather than styling, and each is easy to
 * lose in a refactor:
 *
 * - **The resize target is invisible and 8px.** No handle, no grabber — the
 *   edge itself. It is a real element rather than a CSS border because a border
 *   cannot receive a pointer capture.
 * - **The collapse control is anchored to the far end** of the strip or bar —
 *   bottom on the right, right on the bottom — and content-sized tabs must
 *   never push it away. That is `margin-*: auto` on the control, not a spacer,
 *   because a spacer collapses once the tabs overflow.
 * - **Clicking a collapsed tab or empty bar space expands the dock.** The bar
 *   itself is the expand affordance, not only the control on the end.
 */
export function PinnedWorkbench({
	side,
	fraction,
	onFraction,
	collapsed,
	onCollapsed,
	artifacts,
	activeId,
	onSelect,
	onUnpin,
	children,
}: PinnedWorkbenchProps) {
	const hostRef = useRef<HTMLDivElement>(null);

	/*
	 * Resize by pointer capture on the invisible edge. Measured against the
	 * dock's *parent* rather than the window, because in portrait the dock
	 * shares its box with chat and the titlebar is outside both — using
	 * `innerHeight` would make the drag drift by exactly the titlebar.
	 */
	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const parent = hostRef.current?.parentElement;
			if (!parent) {
				return;
			}
			event.currentTarget.setPointerCapture(event.pointerId);
			const box = parent.getBoundingClientRect();
			const move = (moveEvent: PointerEvent) => {
				const next =
					side === 'right'
						? (box.right - moveEvent.clientX) / box.width
						: (box.bottom - moveEvent.clientY) / box.height;
				onFraction(clampDock(next));
			};
			const stop = () => {
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', stop);
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', stop);
		},
		[onFraction, side]
	);

	// Monaco and xterm both measure their host, and neither notices a parent
	// that changed size without a window resize. Collapsing is exactly that.
	useEffect(() => {
		window.dispatchEvent(new Event('resize'));
	}, [collapsed, fraction, side]);

	if (collapsed) {
		return (
			<div
				className={`ide-dock ide-dock-${side} ide-dock-collapsed`}
				ref={hostRef}
				// Empty bar space expands too, so this is on the container and the
				// tabs stop propagation only when they mean something else.
				onClick={() => onCollapsed(false)}
			>
				{artifacts.map((artifact) => (
					<button
						key={artifact.id}
						type="button"
						className="ide-dock-strip-tab"
						title={artifact.title}
						aria-label={`Show ${artifact.title}`}
						onClick={(event) => {
							event.stopPropagation();
							onSelect(artifact.id);
							onCollapsed(false);
						}}
					>
						<Icon name={artifact.icon} />
					</button>
				))}
				<div className="ide-dock-collapse">
					<IconButton
						icon={side === 'right' ? 'chevron-left' : 'chevron-up'}
						label="Expand the artifact dock"
						onClick={() => onCollapsed(false)}
					/>
				</div>
			</div>
		);
	}

	return (
		<div
			className={`ide-dock ide-dock-${side}`}
			ref={hostRef}
			style={side === 'right' ? { width: `${fraction * 100}%` } : { height: `${fraction * 100}%` }}
		>
			<div
				className="ide-dock-resize"
				role="separator"
				aria-label="Resize the artifact dock"
				aria-orientation={side === 'right' ? 'vertical' : 'horizontal'}
				tabIndex={0}
				onPointerDown={onPointerDown}
				onKeyDown={(event) => {
					// The Guide asks for no visible handle, which must not also mean
					// no keyboard resize. 2% a press, ends at the bounds.
					const step =
						event.key === 'ArrowLeft' || event.key === 'ArrowUp'
							? 0.02
							: event.key === 'ArrowRight' || event.key === 'ArrowDown'
								? -0.02
								: 0;
					if (step !== 0) {
						event.preventDefault();
						onFraction(clampDock(fraction + step));
					}
				}}
			/>
			<div className="ide-dock-tabs" role="tablist" aria-label="Pinned artifacts">
				{artifacts.map((artifact) => (
					<div
						key={artifact.id}
						className={`ide-dock-tab${artifact.id === activeId ? ' ide-dock-tab-active' : ''}`}
					>
						<button
							type="button"
							role="tab"
							aria-selected={artifact.id === activeId}
							className="ide-dock-tab-label"
							title={artifact.title}
							onClick={() => onSelect(artifact.id)}
						>
							<Icon name={artifact.icon} />
							<span className="ide-dock-tab-text">{artifact.title}</span>
						</button>
						{/*
						 * Overlaid on the label, not beside it: showing it must not
						 * resize the tab. Same non-shifting rule as the titlebar
						 * breadcrumb and the profile edit icon.
						 */}
						<button
							type="button"
							className="ide-dock-tab-close"
							aria-label={`Unpin ${artifact.title}`}
							title={`Unpin ${artifact.title}`}
							onClick={() => onUnpin(artifact.id)}
						>
							<Icon name="close" />
						</button>
					</div>
				))}
				<div className="ide-dock-collapse">
					<IconButton
						icon={side === 'right' ? 'chevron-right' : 'chevron-down'}
						label="Collapse the artifact dock"
						onClick={() => onCollapsed(true)}
					/>
				</div>
			</div>
			<div className="ide-dock-body">{children}</div>
		</div>
	);
}
