import { Confirm } from '../ui';

export interface ConfirmDiscardProps {
	/** Name of the unsaved file, or undefined when nothing is being closed. */
	readonly name: string | undefined;
	readonly onSave: () => void;
	readonly onDiscard: () => void;
	readonly onCancel: () => void;
}

/**
 * Asked before closing a dirty editor. Cancel is the default focus target.
 *
 * The three-way consumer, and the one ticket 25 designed `Confirm` against:
 * neither of the two actions here is the cancel, so a primitive with a single
 * `onConfirm` could not have expressed it.
 *
 * **"Don't save" is not marked `danger`.** It discards, but the dialog exists
 * precisely to make that a considered choice, and colouring one of two ordinary
 * outcomes red would say the app has an opinion about which the user wants.
 */
export function ConfirmDiscard({ name, onSave, onDiscard, onCancel }: ConfirmDiscardProps) {
	return (
		<Confirm
			open={name !== undefined}
			title="Unsaved changes"
			message={`Save your changes to ${name} before closing it?`}
			onCancel={onCancel}
			actions={[
				{ label: "Don't save", run: onDiscard },
				{ label: 'Save', run: onSave },
			]}
		/>
	);
}
