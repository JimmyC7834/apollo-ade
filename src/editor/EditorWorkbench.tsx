import { Tabs } from '../ui';
import { MonacoEditor } from './MonacoEditor';

export interface EditorInput {
	readonly id: string;
	readonly name: string;
	readonly content: string;
	readonly revealLine?: number;
}

export interface EditorWorkbenchProps {
	readonly inputs: readonly EditorInput[];
	readonly activeId: string | undefined;
	readonly onSelect: (id: string) => void;
	readonly onClose: (id: string) => void;
}

/** Tab strip plus the editor for the active input. */
export function EditorWorkbench({ inputs, activeId, onSelect, onClose }: EditorWorkbenchProps) {
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
				items={inputs.map((input) => ({ id: input.id, label: input.name, title: input.id }))}
				activeId={activeId}
				onSelect={onSelect}
				onClose={onClose}
			/>
			{active ? (
				<MonacoEditor id={active.id} content={active.content} revealLine={active.revealLine} />
			) : null}
		</div>
	);
}
