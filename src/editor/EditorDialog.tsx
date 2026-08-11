// The Modal Workbench: a transient, dismissible surface over the workbench, so
// Agent Chat stays the primary experience underneath.
//
// This composes the existing `EditorWorkbench` rather than reimplementing it:
// tabs, dirty tracking, source and diff all behave exactly as they did when the
// editor owned the main region. The dialog adds presentation, dismissal,
// splitting and pinning, and owns no editor state at all — which is what lets
// unsaved content survive being dismissed, since the state lives in the
// controller above.

import { useCallback, useEffect, useRef, useState } from 'react';

import { IconButton, Overlay } from '../ui';
import type { EditorHandle } from './EditorHandle';
import { EditorWorkbench, type EditorInput } from './EditorWorkbench';

/** No split, side by side, or one above the other. */
export type EditorSplit = 'none' | 'vertical' | 'horizontal';

export interface EditorDialogProps {
	readonly open: boolean;
	readonly inputs: readonly EditorInput[];
	readonly activeId: string | undefined;
	readonly onSelect: (id: string) => void;
	/** Close one tab. Distinct from dismissing the dialog. */
	readonly onCloseEditor: (id: string) => void;
	readonly onChange: (id: string, content: string) => void;
	/** Dismiss the dialog, leaving every tab, split and unsaved edit intact. */
	readonly onDismiss: () => void;
	/** Move the active tab out of here and into the Pinned Workbench. */
	readonly onPin: (id: string) => void;
}

export function EditorDialog({
	open,
	inputs,
	activeId,
	onSelect,
	onCloseEditor,
	onChange,
	onDismiss,
	onPin,
}: EditorDialogProps) {
	const editorRef = useRef<EditorHandle>(null);
	/*
	 * Split state lives here, not in the controller, for the same reason tab
	 * state lives there: the dialog is dismissible and this must survive being
	 * dismissed. It is *not* persisted — a session reopens on chat with the
	 * modal closed, and a split with no modal around it is not a thing.
	 */
	const [split, setSplit] = useState<EditorSplit>('none');
	// The second pane's own selection. Undefined means "whatever is active".
	const [secondaryId, setSecondaryId] = useState<string | undefined>(undefined);

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

	// Monaco measures its host and does not notice a parent that resized
	// without a window resize — which is what splitting and `resize: both` are.
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const body = bodyRef.current;
		if (!body) {
			return;
		}
		const observer = new ResizeObserver(() => window.dispatchEvent(new Event('resize')));
		observer.observe(body);
		return () => observer.disconnect();
	}, [open]);

	const active = inputs.find((input) => input.id === activeId);
	// A split pane showing the same file twice is a split that does nothing, so
	// the second pane defaults to the next tab along.
	const secondary =
		inputs.find((input) => input.id === secondaryId) ??
		inputs.find((input) => input.id !== activeId) ??
		active;

	return (
		<Overlay
			open={open}
			title={active ? active.name : 'Editor'}
			className="ide-overlay-editor"
			onClose={onDismiss}
		>
			<div className="ide-editor-dialog-actions">
				<IconButton
					icon="split-horizontal"
					label={split === 'vertical' ? 'Remove the split' : 'Split side by side'}
					pressed={split === 'vertical'}
					onClick={() => setSplit((current) => (current === 'vertical' ? 'none' : 'vertical'))}
					disabled={inputs.length === 0}
				/>
				<IconButton
					icon="split-vertical"
					label={split === 'horizontal' ? 'Remove the split' : 'Split above and below'}
					pressed={split === 'horizontal'}
					onClick={() =>
						setSplit((current) => (current === 'horizontal' ? 'none' : 'horizontal'))
					}
					disabled={inputs.length === 0}
				/>
				<IconButton
					icon="pin"
					label={active ? `Pin ${active.name} to the dock` : 'Pin to the dock'}
					disabled={!active}
					onClick={() => active && onPin(active.id)}
				/>
				<IconButton icon="close" label="Close editor" onClick={onDismiss} />
			</div>
			<div className={`ide-editor-dialog-body ide-editor-split-${split}`} ref={bodyRef}>
				<EditorWorkbench
					editorRef={attachEditor}
					inputs={inputs}
					activeId={activeId}
					onSelect={onSelect}
					onClose={onCloseEditor}
					onChange={onChange}
				/>
				{split === 'none' ? null : (
					<EditorWorkbench
						inputs={inputs}
						activeId={secondary?.id}
						onSelect={setSecondaryId}
						onClose={onCloseEditor}
						onChange={onChange}
					/>
				)}
			</div>
		</Overlay>
	);
}
