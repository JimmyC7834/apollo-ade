/**
 * Focus a Monaco editor, retrying briefly until it takes.
 *
 * Monaco does not reliably accept focus at the instant a dialog containing it
 * opens. Two distinct failures were measured: the editor has not laid out yet
 * and has no input element, or it has laid out and the first `focus()` still
 * does not stick. Both leave focus on whatever the dialog fell back to, which
 * is not the editor the user asked to see.
 *
 * Retries run on macrotasks rather than animation frames, so this also works in
 * a window that is not rendering — a background tab serves no frames at all.
 *
 * Returns a canceller. Call it before starting another request and when the
 * editor goes away, so a pending retry never outlives it.
 */
export interface FocusableEditor {
	focus(): void;
	hasTextFocus(): boolean;
	getDomNode(): HTMLElement | null;
}

const ATTEMPTS = 8;
const INTERVAL_MS = 16;

export function focusEditor(editor: FocusableEditor): () => void {
	/*
	 * Where focus was when the request was made. Retrying is only legitimate
	 * while nobody else has claimed focus, so this keeps going while it is
	 * still there, on `body`, or already somewhere inside the editor — Monaco
	 * moves focus through its own nodes on the way to its input, and treating
	 * that as "the user moved" is what made this give up one step early.
	 * Anything else is a deliberate choice, so stop competing with it.
	 */
	const settled = document.activeElement;
	let remaining = ATTEMPTS;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const ours = (): boolean => {
		const active = document.activeElement;
		return (
			active === settled ||
			active === document.body ||
			active === null ||
			editor.getDomNode()?.contains(active) === true
		);
	};

	const attempt = (): void => {
		timer = null;
		if (!ours()) {
			return;
		}
		editor.focus();
		remaining -= 1;
		if (editor.hasTextFocus() || remaining <= 0) {
			return;
		}
		timer = setTimeout(attempt, INTERVAL_MS);
	};

	attempt();

	return () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
}
