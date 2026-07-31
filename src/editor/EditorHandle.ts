/**
 * The imperative surface an editor exposes to whatever contains it.
 *
 * Focus is the one thing a container cannot do for Monaco from the outside.
 * Monaco builds and rebuilds its real input during layout — a contenteditable
 * div where the EditContext API exists, a textarea otherwise — so focusing that
 * node by selector is a race against the editor's own initialisation. Monaco's
 * `focus()` is authoritative whenever it runs.
 */
export interface EditorHandle {
	focus(): void;
}
