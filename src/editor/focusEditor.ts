/**
 * Focus a Monaco editor and keep it focused while the editor settles.
 *
 * Focusing Monaco once is not enough, and this was measured in the real Tauri
 * window rather than reasoned about. Three distinct failures showed up:
 *
 *  - the editor has not laid out yet and has no input element to focus;
 *  - it has laid out, and the first `focus()` still does not stick;
 *  - focus lands correctly and is then destroyed, because Monaco replaces its
 *    input node when a model is set — up to a few hundred milliseconds later
 *    when a file is opened for the first time. Focus falls to `body`, which
 *    looks to the user exactly like the dialog opening onto nothing.
 *
 * So this watches for a short window instead of stopping at the first success,
 * re-focusing whenever the editor has lost focus to nobody. It gives up
 * immediately once anything else holds focus, so it never fights the user.
 *
 * Ticks are macrotasks, not animation frames, so this also works in a window
 * that is not rendering — a background tab serves no frames at all.
 *
 * Returns a canceller. Call it before starting another request and when the
 * editor goes away, so a pending watch never outlives it.
 */
export interface FocusableEditor {
	focus(): void;
	hasTextFocus(): boolean;
	getDomNode(): HTMLElement | null;
}

/*
 * Long enough to outlast Monaco rebuilding its input for a newly opened file,
 * which was observed between 35ms and 400ms after the dialog opened. Cheap:
 * once focus is stable these ticks are a `hasTextFocus()` call and nothing else.
 */
const WINDOW_MS = 800;
const INTERVAL_MS = 25;

export function focusEditor(editor: FocusableEditor): () => void {
	// Where focus was when the request was made — typically whatever the dialog
	// fell back to while the editor was still coming up.
	const settled = document.activeElement;
	const deadline = Date.now() + WINDOW_MS;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let everFocused = false;

	/** Is focus still unclaimed, and therefore ours to place? */
	const ours = (): boolean => {
		const active = document.activeElement;
		if (active === null || active === document.body) {
			return true;
		}
		if (editor.getDomNode()?.contains(active) === true) {
			return true;
		}
		/*
		 * The fallback the dialog focused counts as unclaimed only until the
		 * editor has had focus once. After that, focus being there again means
		 * the user went there — tabbing to the close button, say — and taking it
		 * back would be a fight they cannot win.
		 */
		return !everFocused && active === settled;
	};

	const attempt = (): void => {
		timer = null;
		if (!ours()) {
			return;
		}
		if (editor.hasTextFocus()) {
			everFocused = true;
		} else {
			editor.focus();
			if (!editor.hasTextFocus()) {
				/*
				 * `focus()` goes quiet while Monaco is rebuilding its input, so
				 * fall back to the element. It is re-queried every tick on
				 * purpose: the node that existed a moment ago may be the one
				 * that was just thrown away. `.ime-text-area` is deliberately
				 * not matched — it is a hidden helper that accepts focus and
				 * then swallows every keystroke.
				 */
				editor
					.getDomNode()
					?.querySelector<HTMLElement>('.native-edit-context, textarea.inputarea')
					?.focus();
			}
			everFocused = everFocused || editor.hasTextFocus();
		}
		if (Date.now() >= deadline) {
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
