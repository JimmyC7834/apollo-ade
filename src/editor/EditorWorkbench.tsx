import { Tabs } from '../ui';
import { MonacoEditor } from './MonacoEditor';

export interface EditorInput {
	readonly id: string;
	readonly name: string;
	readonly content: string;
	/** Content as last read or written. `content !== saved` means dirty. */
	readonly saved: string;
	readonly revealLine?: number;
}

export function isDirty(input: EditorInput): boolean {
	return input.content !== input.saved;
}

export interface EditorWorkbenchProps {
	readonly inputs: readonly EditorInput[];
	readonly activeId: string | undefined;
	readonly onSelect: (id: string) => void;
	readonly onClose: (id: string) => void;
	readonly onChange: (id: string, content: string) => void;
}

/** Tab strip plus the editor for the active input. */
export function EditorWorkbench({
	inputs,
	activeId,
	onSelect,
	onClose,
	onChange,
}: EditorWorkbenchProps) {
	const active = inputs.find((input) => input.id === activeId);

	if (inputs.length === 0) {
		return (
			<div className="ide-editor-empty">
				<p>Select a file to open it.</p>
			</div>
		);
	}

	return (
		<div className="ide-editor-workbench">
			<Tabs
				label="Open editors"
				items={inputs.map((input) => ({
					id: input.id,
					label: input.name,
					title: input.id,
					dirty: isDirty(input),
				}))}
				activeId={activeId}
				onSelect={onSelect}
				onClose={onClose}
			/>
			{active ? (
				<MonacoEditor
					id={active.id}
					content={active.content}
					revealLine={active.revealLine}
					onChange={onChange}
				/>
			) : null}
		</div>
	);
}
