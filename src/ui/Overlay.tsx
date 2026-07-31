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

		if (!open) {
			if (dialog.open) {
				dialog.close();
				const opener = openerRef.current;
				openerRef.current = null;
				// Only restore if the opener is still in the document.
				if (opener?.isConnected) {
					opener.focus();
				}
			}
			return;
		}
		/*
		 * Everything below has to be safe to run twice: React re-runs an effect
		 * after its cleanup, and an early `return dialog.open` here would drop
		 * the observer set up on the first pass and never replace it. So the
		 * one-time parts are guarded and the focus work simply repeats.
		 */
		if (!dialog.open) {
			// Capture the opener before focus moves into the dialog. Skipped on a
			// repeat pass, where the active element is already inside the dialog.
			openerRef.current = document.activeElement as HTMLElement | null;
			dialog.showModal();
		}

		/*
		 * Focus the first field or control, else the dialog itself — never
		 * nothing, which would strand the keyboard inside a modal it cannot tab
		 * out of. A dialog whose real subject is not its first control focuses
		 * that subject itself, from an effect of its own that runs after this
		 * one; see `EditorDialog`.
		 */
		const target = dialog.querySelector<HTMLElement>(
			'input, textarea, select, button, [tabindex]:not([tabindex="-1"])'
		);
		(target ?? dialog).focus();
	}, [open]);

	return (
		<dialog
			ref={ref}
			className={`ide-overlay${className ? ` ${className}` : ''}`}
			/*
			 * `<dialog>` + `showModal()` implies both of these, but they are
			 * stated anyway: the implicit mapping is what varies between older
			 * assistive technology and engines, and this is the one place that
			 * settles it for every overlay in the workbench.
			 */
			role="dialog"
			aria-modal="true"
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
