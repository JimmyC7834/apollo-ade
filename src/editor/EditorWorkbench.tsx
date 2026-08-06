import type { Ref } from 'react';

import { Tabs } from '../ui';
import type { EditorHandle } from './EditorHandle';
import { MonacoDiffEditor } from './MonacoDiffEditor';
import { MonacoEditor } from './MonacoEditor';

export interface SourceInput {
	readonly kind: 'source';
	readonly id: string;
	readonly name: string;
	readonly content: string;
	/** Content as last read or written. `content !== saved` means dirty. */
	readonly saved: string;
	/** 1-based line to reveal when the file opens. */
	readonly revealLine?: number;
}

export interface DiffInput {
	readonly kind: 'diff';
	/** Namespaced (`diff:<path>`) so a file and its diff can both be open. */
	readonly id: string;
	readonly name: string;
	readonly original: string;
	readonly modified: string;
}

/*
 * A diff input is not an editable source input: it has two sides, no dirty
 * state, and nothing to save. Keeping the union typed is what stops save and
 * close paths from quietly assuming `content` exists.
 */
export type EditorInput = SourceInput | DiffInput;

export function isDirty(input: EditorInput): boolean {
	return input.kind === 'source' && input.content !== input.saved;
}

export interface EditorWorkbenchProps {
	readonly inputs: readonly EditorInput[];
	readonly activeId: string | undefined;
	readonly onSelect: (id: string) => void;
	readonly onClose: (id: string) => void;
	readonly onChange: (id: string, content: string) => void;
	/** Handle to whichever editor is active, so a container can focus it. */
	readonly editorRef?: Ref<EditorHandle>;
}

/** Tab strip plus the editor for the active input, source or diff. */
export function EditorWorkbench({
	inputs,
	activeId,
	onSelect,
	onClose,
	onChange,
	editorRef,
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
					label: input.kind === 'diff' ? `${input.name} (diff)` : input.name,
					title: input.id,
					dirty: isDirty(input),
				}))}
				activeId={activeId}
				onSelect={onSelect}
				onClose={onClose}
			/>
			{active?.kind === 'diff' ? (
				<MonacoDiffEditor
					ref={editorRef}
					name={active.name}
					original={active.original}
					modified={active.modified}
				/>
			) : null}
			{active?.kind === 'source' ? (
				<MonacoEditor
					ref={editorRef}
					id={active.id}
					content={active.content}
					revealLine={active.revealLine}
					onChange={onChange}
				/>
			) : null}
		</div>
	);
}
