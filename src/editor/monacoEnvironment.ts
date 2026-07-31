/*
 * Explicit Monaco worker mapping.
 *
 * Monaco resolves workers through the global MonacoEnvironment rather than
 * bundler imports, so the mapping has to be declared by hand. Getting this
 * wrong is the classic failure that works in dev and breaks in a production
 * build, which is why the workers are imported with Vite's `?worker` suffix —
 * they are then real build inputs and get hashed and emitted like any chunk.
 *
 * Import this module for its side effect before creating any editor.
 */

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

declare global {
	interface Window {
		MonacoEnvironment?: {
			getWorker(workerId: string, label: string): Worker;
		};
	}
}

window.MonacoEnvironment = {
	getWorker(_workerId, label) {
		switch (label) {
			case 'json':
				return new jsonWorker();
			case 'css':
			case 'scss':
			case 'less':
				return new cssWorker();
			case 'typescript':
			case 'javascript':
				return new tsWorker();
			default:
				return new editorWorker();
		}
	},
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	css: 'css',
	html: 'html',
	js: 'javascript',
	json: 'json',
	jsx: 'javascript',
	md: 'markdown',
	rs: 'rust',
	ts: 'typescript',
	tsx: 'typescript',
};

export function languageForPath(path: string): string {
	const extension = path.split('.').pop()?.toLowerCase() ?? '';
	return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}
