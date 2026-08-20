// Modeless completion notices, lower right — ticket 44.
//
// **A toast is an interruption**, and the three rules that follow from that are
// the whole design:
//
// - It never takes focus. Nothing here calls `focus()`, and the region is not a
//   dialog — a toast that stole the caret would interrupt the sentence you were
//   typing to tell you something you already caused.
// - It is announced *politely*. `role="status"` queues behind whatever the
//   screen reader is already saying; `alert` would cut it off mid-word, and the
//   thing being cut off is usually the agent's answer.
// - Dismissal is not a race. There is no timer: a toast stays until it is
//   dismissed, so a notice cannot disappear between deciding to read it and
//   reaching it.

import { Icon } from '../ui';
import { useOccluder } from '../ui/occlusion';

export interface Toast {
	readonly id: number;
	readonly message: string;
	/** An optional way in — "Open the session" and nothing more elaborate. */
	readonly action?: { readonly label: string; readonly run: () => void };
}

export interface ToastsProps {
	readonly toasts: readonly Toast[];
	readonly onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps) {
	// A toast sits in the dock's corner, which is where the page is. See
	// `occlusion.ts`.
	useOccluder(toasts.length > 0);

	if (toasts.length === 0) {
		// Nothing rendered at all, so the region cannot sit invisibly over the
		// dock's bottom-right corner catching pointer events.
		return null;
	}
	return (
		<div className="ide-toasts" role="status" aria-live="polite" aria-label="Notifications">
			{toasts.map((toast) => (
				<div key={toast.id} className="ide-toast">
					<span className="ide-toast-message">{toast.message}</span>
					{toast.action ? (
						<button
							type="button"
							className="ide-toast-action"
							onClick={() => {
								toast.action?.run();
								onDismiss(toast.id);
							}}
						>
							{toast.action.label}
						</button>
					) : null}
					<button
						type="button"
						className="ide-toast-dismiss"
						onClick={() => onDismiss(toast.id)}
						aria-label={`Dismiss: ${toast.message}`}
					>
						<Icon name="close" />
					</button>
				</div>
			))}
		</div>
	);
}
