import * as monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

import { languageForPath } from './monacoEnvironment';

export interface MonacoEditorProps {
	/** Stable id for the open file; also the model key. */
	readonly id: string;
	readonly content: string;
	/** 1-based line to reveal and select when the file opens. */
	readonly revealLine?: number;
	readonly onChange?: (id: string, content: string) => void;
}

/**
 * A single editor instance whose model is swapped as the active file changes.
 *
 * Models are cached per file id and disposed together with the component, so
 * switching tabs keeps undo history and scroll position rather than rebuilding
 * the document. Monaco is not garbage collected for you: every model and the
 * editor itself must be disposed explicitly or the WebView leaks them.
 */
export function MonacoEditor({ id, content, revealLine, onChange }: MonacoEditorProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>(null);
	const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
	const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
	const previousIdRef = useRef<string>(null);

	/*
	 * The change listener is attached once, to the editor rather than to each
	 * model, so it survives tab switches. It therefore has to read the current
	 * id and callback from refs instead of closing over the render's values.
	 */
	const latest = useRef({ id, onChange });
	latest.current = { id, onChange };

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}
		const editor = monaco.editor.create(host, {
			theme: 'vs-dark',
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontSize: 12,
			renderLineHighlight: 'all',
		});
		editorRef.current = editor;

		const subscription = editor.onDidChangeModelContent(() => {
			const { id: currentId, onChange: notify } = latest.current;
			notify?.(currentId, editor.getValue());
		});

		const models = modelsRef.current;
		return () => {
			subscription.dispose();
			editor.dispose();
			for (const model of models.values()) {
				model.dispose();
			}
			models.clear();
		};
	}, []);

	useEffect(() => {
		const editor = editorRef.current;
		if (!editor) {
			return;
		}

		// Stash the outgoing file's cursor and scroll position before swapping.
		const previousId = previousIdRef.current;
		if (previousId && previousId !== id) {
			viewStatesRef.current.set(previousId, editor.saveViewState());
		}
		previousIdRef.current = id;

		let model = modelsRef.current.get(id);
		if (!model) {
			model = monaco.editor.createModel(content, languageForPath(id));
			modelsRef.current.set(id, model);
		} else if (model.getValue() !== content) {
			model.setValue(content);
		}

		editor.setModel(model);
		const viewState = viewStatesRef.current.get(id);
		if (viewState) {
			editor.restoreViewState(viewState);
		}

		if (revealLine !== undefined) {
			editor.revealLineInCenter(revealLine);
			editor.setPosition({ lineNumber: revealLine, column: 1 });
		}
	}, [id, content, revealLine]);

	return <div className="ide-editor" ref={hostRef} />;
}
