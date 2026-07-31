import { useCallback, useRef } from 'react';

export interface ResizableSeparatorProps {
	readonly label: string;
	/** "vertical" separates left/right regions; "horizontal" separates top/bottom. */
	readonly orientation: 'vertical' | 'horizontal';
	readonly value: number;
	readonly min: number;
	readonly max: number;
	/**
	 * Whether dragging toward the origin (left/up) grows the region. True for a
	 * secondary sidebar or a bottom panel, which extend away from the origin.
	 */
	readonly inverted?: boolean;
	readonly onChange: (value: number) => void;
}

const KEYBOARD_STEP = 20;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * A sash with real separator semantics: pointer drag plus arrow-key resizing,
 * so a keyboard user can reach any layout a mouse user can.
 */
export function ResizableSeparator({
	label,
	orientation,
	value,
	min,
	max,
	inverted,
	onChange,
}: ResizableSeparatorProps) {
	const start = useRef({ pointer: 0, value: 0 });

	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			event.currentTarget.setPointerCapture(event.pointerId);
			start.current = {
				pointer: orientation === 'vertical' ? event.clientX : event.clientY,
				value,
			};
		},
		[orientation, value]
	);

	const onPointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
				return;
			}
			const current = orientation === 'vertical' ? event.clientX : event.clientY;
			const delta = (current - start.current.pointer) * (inverted ? -1 : 1);
			onChange(clamp(start.current.value + delta, min, max));
		},
		[orientation, inverted, min, max, onChange]
	);

	const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.currentTarget.releasePointerCapture(event.pointerId);
	}, []);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
			const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
			let next: number | undefined;
			if (event.key === decrease) {
				next = value + (inverted ? KEYBOARD_STEP : -KEYBOARD_STEP);
			} else if (event.key === increase) {
				next = value + (inverted ? -KEYBOARD_STEP : KEYBOARD_STEP);
			} else if (event.key === 'Home') {
				next = min;
			} else if (event.key === 'End') {
				next = max;
			}
			if (next !== undefined) {
				event.preventDefault();
				onChange(clamp(next, min, max));
			}
		},
		[orientation, inverted, value, min, max, onChange]
	);

	return (
		<div
			className={`ide-sash ide-sash-${orientation}`}
			role="separator"
			tabIndex={0}
			aria-label={label}
			aria-orientation={orientation}
			aria-valuenow={Math.round(value)}
			aria-valuemin={min}
			aria-valuemax={max}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onKeyDown={onKeyDown}
		/>
	);
}
