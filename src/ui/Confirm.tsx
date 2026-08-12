import type { ReactNode } from 'react';

import { Overlay } from './Overlay';

/**
 * One thing the dialog offers besides cancelling.
 *
 * A list rather than the obvious `onConfirm`, decided by writing both call
 * sites as [ticket 25](docs/wayfinder/pi-harness/tickets/25-confirm-primitive.md)
 * asked: `ConfirmDiscard` offers *two* — save and discard — and a two-button
 * primitive would have left the awkward consumer outside, which is the one that
 * proves the shape.
 */
export interface ConfirmAction {
	readonly label: string;
	readonly run: () => void;
	/** Styled as destructive. Says what the action does; it does not move focus. */
	readonly danger?: boolean;
}

export interface ConfirmProps {
	readonly open: boolean;
	/** The dialog's accessible name, and its heading. */
	readonly title: string;
	/** What is being confirmed. Prose, not a decision. */
	readonly message: ReactNode;
	readonly cancelLabel?: string;
	readonly onCancel: () => void;
	readonly actions: readonly ConfirmAction[];
}

/**
 * Ask before doing something that cannot be taken back.
 *
 * Owns the overlay, modal semantics, Escape, focus containment and focus
 * restoration — all of it inherited from `Overlay`, which is the point: three
 * hand-rolled dialogs would have been three chances to get one of those wrong,
 * and the two that existed already differed in nothing else.
 *
 * **Cancel is rendered first, and that is the focus rule.** `Overlay` focuses
 * the first control it finds, so ordering the safe action first is what puts
 * initial focus on it. No `autoFocus`, no ref, nothing to keep in sync — the
 * mechanism that makes it true is the same one that lays it out.
 *
 * Actions do not close the dialog themselves. The caller owns `open`, and a
 * primitive that closed itself would be a second source of truth for a piece of
 * state the caller has to hold anyway.
 */
export function Confirm({
	open,
	title,
	message,
	cancelLabel = 'Cancel',
	onCancel,
	actions,
}: ConfirmProps) {
	return (
		<Overlay open={open} title={title} onClose={onCancel}>
			<p className="ide-help-note">{message}</p>
			<div className="ide-dialog-actions">
				<button type="button" className="ide-button" onClick={onCancel}>
					{cancelLabel}
				</button>
				{actions.map((action) => (
					<button
						key={action.label}
						type="button"
						className={`ide-button${action.danger ? ' ide-button-danger' : ''}`}
						onClick={action.run}
					>
						{action.label}
					</button>
				))}
			</div>
		</Overlay>
	);
}
