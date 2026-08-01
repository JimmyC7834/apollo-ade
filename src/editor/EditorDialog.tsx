// The editor as a transient, dismissible surface over the workbench, so Agent
// Chat stays the primary experience underneath.
//
// This composes the existing `EditorWorkbench` rather than reimplementing it:
// tabs, dirty tracking, source and diff all behave exactly as they did when the
// editor owned the main region. The dialog adds presentation and dismissal, and
// owns no editor state at all — which is what lets unsaved content survive
// being dismissed, since the state lives in the controller above.

import { useCallback, useEffect, useRef } from 'react';

import { IconButton, Overlay } from '../ui';
import type { EditorHandle } from './EditorHandle';
import { EditorWorkbench, type EditorInput } from './EditorWorkbench';

export interface EditorDialogProps {
	readonly open: boolean;
	readonly inputs: readonly EditorInput[];
	readonly activeId: string | undefined;
	readonly onSelect: (id: string) => void;
	/** Close one tab. Distinct from dismissing the dialog. */
	readonly onCloseEditor: (id: string) => void;
	readonly onChange: (id: string, content: string) => void;
	/** Dismiss the dialog, leaving every tab and every unsaved edit intact. */
	readonly onDismiss: () => void;
}

export function EditorDialog({
	open,
	inputs,
	activeId,
	onSelect,
	onCloseEditor,
	onChange,
	onDismiss,
}: EditorDialogProps) {
	const active = inputs.find((input) => input.id === activeId);
	const editorRef = useRef<EditorHandle>(null);

	/*
	 * Open into Monaco, not onto the tab strip: the file is the reason the
	 * dialog exists.
	 *
	 * This runs after `Overlay` has shown the dialog and placed focus, because
	 * an effect here runs after its descendants'. Asking the editor to focus
	 * itself is what makes it reliable — Monaco builds its real input during
	 * layout and can replace that node again moments later, so focusing the
	 * element by selector is a race against the editor's own initialisation.
	 */
	useEffect(() => {
		if (open) {
			editorRef.current?.focus();
		}
	}, [open, activeId]);

	/*
	 * Focus again whenever an editor instance actually attaches. The effect
	 * above covers opening the dialog, but not the cases where Monaco is torn
	 * down and rebuilt underneath it: switching between a file and a diff swaps
	 * one component for the other, and React remounts children a second time in
	 * development. Both produce a brand-new editor that nothing has focused,
	 * and a callback ref is the one hook that runs exactly then.
	 */
	const openRef = useRef(open);
	openRef.current = open;
	const attachEditor = useCallback((handle: EditorHandle | null) => {
		editorRef.current = handle;
		if (handle && openRef.current) {
			handle.focus();
		}
	}, []);

	return (
		<Overlay
			open={open}
			title={active ? active.name : 'Editor'}
			className="ide-overlay-editor"
			onClose={onDismiss}
		>
			<div className="ide-editor-dialog-close">
				<IconButton icon="close" label="Close editor" onClick={onDismiss} />
			</div>
			<EditorWorkbench
				editorRef={attachEditor}
				inputs={inputs}
				activeId={activeId}
				onSelect={onSelect}
				onClose={onCloseEditor}
				onChange={onChange}
			/>
		</Overlay>
	);
}
