import { useEffect, useRef } from 'react';

export interface AccessibilityHelpProps {
	readonly open: boolean;
	readonly onClose: () => void;
}

/*
 * ponytail: native <dialog> gives modal semantics, focus containment, and a
 * backdrop for free. Replace with the `Overlay` primitive in Slice 3, when the
 * command center needs the same mechanics and proves the shared contract.
 *
 * React state is the single source of truth for whether this is open. The
 * element is never allowed to close itself: `cancel` is prevented and the
 * close button is a plain button, so every close routes through `onClose` and
 * back down through `open`. Relying on the dialog's own `close` event to sync
 * state desyncs it wherever that event is unreliable — the WebView used for
 * testing never fires it at all, which leaves the dialog permanently "open"
 * and impossible to reopen.
 */
export function AccessibilityHelp({ open, onClose }: AccessibilityHelpProps) {
	const ref = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) {
			return;
		}
		if (open && !dialog.open) {
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	}, [open]);

	return (
		<dialog
			ref={ref}
			className="ide-dialog"
			aria-labelledby="a11y-help-title"
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					onClose();
				}
			}}
		>
			<h2 id="a11y-help-title">Keyboard help</h2>
			<dl className="ide-help-list">
				<dt>Tab / Shift+Tab</dt>
				<dd>Move between the titlebar, regions, and separators.</dd>
				<dt>Arrow keys on a separator</dt>
				<dd>Resize the adjacent region in 20px steps.</dd>
				<dt>Home / End on a separator</dt>
				<dd>Resize to the smallest or largest allowed size.</dd>
				<dt>Escape</dt>
				<dd>Close this dialog.</dd>
			</dl>
			<p className="ide-help-note">
				Hiding a region that contains the keyboard focus moves focus to the main region.
			</p>
			<button type="button" className="ide-button" onClick={onClose}>
				Close
			</button>
		</dialog>
	);
}
