import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface OverlayProps {
	readonly open: boolean;
	/** Accessible name for the dialog. */
	readonly title: string;
	/** Hide the title visually when the content speaks for itself (e.g. a quick pick). */
	readonly titleHidden?: boolean;
	readonly onClose: () => void;
	readonly className?: string;
	readonly children: ReactNode;
}

/**
 * Dialog and overlay mechanics: modal semantics, focus entry, focus
 * containment, Escape dismissal, and focus restoration to whatever opened it.
 *
 * Focus restoration is not polish. Without it a keyboard user loses their
 * place in a dense workbench every time an overlay closes, so the opener is
 * captured as part of the open transition rather than looked up afterwards.
 *
 * React state is the single source of truth for `open`: the element is never
 * allowed to close itself. `cancel` is prevented and Escape is handled here,
 * because the dialog's own `close` event is not delivered in every WebView —
 * syncing state from it strands the overlay permanently open.
 */
export function Overlay({
	open,
	title,
	titleHidden,
	onClose,
	className,
	children,
}: OverlayProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const openerRef = useRef<HTMLElement | null>(null);
	const titleId = useId();

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) {
			return;
		}

		if (open && !dialog.open) {
			// Capture the opener before focus moves into the dialog.
			openerRef.current = document.activeElement as HTMLElement | null;
			dialog.showModal();
			// Prefer the first field or control; fall back to the dialog itself.
			const target = dialog.querySelector<HTMLElement>(
				'input, textarea, select, button, [tabindex]:not([tabindex="-1"])'
			);
			(target ?? dialog).focus();
		} else if (!open && dialog.open) {
			dialog.close();
			const opener = openerRef.current;
			openerRef.current = null;
			// Only restore if the opener is still in the document.
			if (opener?.isConnected) {
				opener.focus();
			}
		}
	}, [open]);

	return (
		<dialog
			ref={ref}
			className={`ide-overlay${className ? ` ${className}` : ''}`}
			aria-labelledby={titleId}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					// Stop Monaco or any embedded control from also acting on it.
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<h2 id={titleId} className={titleHidden ? 'ide-visually-hidden' : 'ide-overlay-title'}>
				{title}
			</h2>
			{children}
		</dialog>
	);
}
