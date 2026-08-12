import { useEffect, useId, useState } from 'react';

import { Overlay } from './Overlay';

export interface PromptProps {
	readonly open: boolean;
	/** The dialog's accessible name, and its heading. */
	readonly title: string;
	/** Label for the field. Says what to type, not what the dialog is. */
	readonly label: string;
	readonly initialValue?: string;
	readonly confirmLabel?: string;
	/** Why the current value cannot be used, or undefined when it can. */
	readonly validate?: (value: string) => string | undefined;
	readonly onCancel: () => void;
	readonly onSubmit: (value: string) => void;
}

/**
 * Ask for one line of text.
 *
 * The sibling of `Confirm`, and built the same way: `Overlay` owns modal
 * semantics, Escape, focus containment and focus restoration, so this owns only
 * the field and the two buttons.
 *
 * **The field is rendered first, and that is the focus rule** — the same
 * mechanism as `Confirm`, pointed at a different control. `Overlay` focuses the
 * first thing it finds that can take focus, and for a prompt that has to be the
 * input, because a dialog that opens with the cursor anywhere else asks the
 * user to click before they can answer it.
 *
 * A `<form>` rather than a click handler, so Enter submits without a keydown
 * listener and an invalid value is refused in one place rather than two.
 */
export function Prompt({
	open,
	title,
	label,
	initialValue = '',
	confirmLabel = 'Create',
	validate,
	onCancel,
	onSubmit,
}: PromptProps) {
	const [value, setValue] = useState(initialValue);
	// Whether the user has tried yet. A field that is red before it has been
	// touched is telling someone off for not having typed.
	const [tried, setTried] = useState(false);
	const fieldId = useId();
	const errorId = useId();

	// Each opening is a fresh question, and it may be about a different entry.
	useEffect(() => {
		if (open) {
			setValue(initialValue);
			setTried(false);
		}
	}, [open, initialValue]);

	const problem = validate?.(value);

	return (
		<Overlay open={open} title={title} onClose={onCancel}>
			<form
				className="ide-prompt"
				onSubmit={(event) => {
					event.preventDefault();
					setTried(true);
					if (!problem) {
						onSubmit(value.trim());
					}
				}}
			>
				<label className="ide-prompt-label" htmlFor={fieldId}>
					{label}
				</label>
				<input
					id={fieldId}
					className="ide-input"
					value={value}
					onChange={(event) => setValue(event.target.value)}
					aria-invalid={tried && problem !== undefined}
					aria-describedby={tried && problem ? errorId : undefined}
				/>
				{/*
				 * A live region rather than plain text: the message appears while
				 * focus is still in the field, so nothing else would announce it.
				 */}
				<p id={errorId} className="ide-prompt-problem" role="alert">
					{tried ? problem : undefined}
				</p>
				<div className="ide-dialog-actions">
					<button type="button" className="ide-button" onClick={onCancel}>
						Cancel
					</button>
					<button type="submit" className="ide-button">
						{confirmLabel}
					</button>
				</div>
			</form>
		</Overlay>
	);
}
