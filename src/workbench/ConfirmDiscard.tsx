import { Overlay } from '../ui';

export interface ConfirmDiscardProps {
	/** Name of the unsaved file, or undefined when nothing is being closed. */
	readonly name: string | undefined;
	readonly onSave: () => void;
	readonly onDiscard: () => void;
	readonly onCancel: () => void;
}

/** Asked before closing a dirty editor. Cancel is the default focus target. */
export function ConfirmDiscard({ name, onSave, onDiscard, onCancel }: ConfirmDiscardProps) {
	return (
		<Overlay open={name !== undefined} title="Unsaved changes" onClose={onCancel}>
			<p className="ide-help-note">Save your changes to {name} before closing it?</p>
			<div className="ide-dialog-actions">
				<button type="button" className="ide-button" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="ide-button" onClick={onDiscard}>
					Don&apos;t save
				</button>
				<button type="button" className="ide-button" onClick={onSave}>
					Save
				</button>
			</div>
		</Overlay>
	);
}
