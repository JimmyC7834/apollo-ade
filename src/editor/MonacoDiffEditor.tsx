import * as monaco from 'monaco-editor';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';

import type { EditorHandle } from './EditorHandle';
import { focusEditor } from './focusEditor';
import { languageForPath } from './monacoEnvironment';

export interface MonacoDiffEditorProps {
	readonly ref?: Ref<EditorHandle>;
	/** Namespaced diff id, used only as a React key hint. */
	readonly id: string;
	/** Workspace path, used to pick the language. */
	readonly name: string;
	readonly original: string;
	readonly modified: string;
}

/**
 * Read-only side-by-side diff.
 *
 * Unlike `MonacoEditor` this creates its models per input rather than caching
 * them: a diff has no edits or undo history worth preserving across tab
 * switches. Both models and the editor are disposed explicitly — Monaco does
 * not garbage collect them.
 */
export function MonacoDiffEditor({ ref, name, original, modified }: MonacoDiffEditorProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<monaco.editor.IStandaloneDiffEditor>(null);

	const cancelFocusRef = useRef<() => void>(null);

	// The modified side is the one the reader came for; the original is context.
	useImperativeHandle(
		ref,
		() => ({
			focus() {
				const modified = editorRef.current?.getModifiedEditor();
				if (!modified) {
					return;
				}
				cancelFocusRef.current?.();
				cancelFocusRef.current = focusEditor(modified);
			},
		}),
		[]
	);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		const editor = monaco.editor.createDiffEditor(host, {
			theme: 'vs-dark',
			automaticLayout: true,
			readOnly: true,
			renderSideBySide: true,
			fontSize: 12,
		});
		editorRef.current = editor;
		const language = languageForPath(name);
		const originalModel = monaco.editor.createModel(original, language);
		const modifiedModel = monaco.editor.createModel(modified, language);
		editor.setModel({ original: originalModel, modified: modifiedModel });

		return () => {
			// A focus request still retrying must not outlive the editor.
			cancelFocusRef.current?.();
			cancelFocusRef.current = null;
			editor.dispose();
			originalModel.dispose();
			modifiedModel.dispose();
		};
	}, [name, original, modified]);

	return <div className="ide-editor" ref={hostRef} aria-label={`Diff of ${name}`} />;
}
