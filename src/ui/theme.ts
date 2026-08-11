/*
 * The one place a token becomes a colour literal.
 *
 * Monaco and xterm both paint outside the DOM — Monaco onto its own stylesheet,
 * xterm onto a canvas — so neither reads `var(--background)`. Both take colour
 * objects instead. Rather than let literals collect at their call sites, the
 * values are read back off the document here, so `tokens.css` stays the single
 * source and switching theme reaches them too.
 */

import * as monaco from 'monaco-editor';
import { useSyncExternalStore } from 'react';

export type ThemeName = 'light' | 'dark';

/*
 * The theme lives here rather than in React state because two of its three
 * consumers are not React: Monaco's theme registry is global, and xterm holds
 * its colours on a canvas. A module store lets the titlebar set it, the
 * terminal subscribe to it, and Monaco be retinted, without any of them
 * knowing about the others.
 */
let current: ThemeName = 'dark';
const listeners = new Set<() => void>();

/** Applied to <html>, which is what `tokens.css` and Tailwind's dark variant key off. */
export function applyTheme(theme: ThemeName): void {
	current = theme;
	document.documentElement.classList.toggle('dark', theme === 'dark');
	// Monaco reads the tokens back off the document, so it must run after the class.
	defineMonacoTheme(theme);
	for (const listener of listeners) {
		listener();
	}
}

export function useTheme(): ThemeName {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current
	);
}

export function readToken(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * xterm's theme for the current document state. Call after `applyTheme` — the
 * values are read at call time, not cached.
 */
export function terminalTheme() {
	const t = readToken;
	return {
		background: t('--card'),
		foreground: t('--terminal-foreground'),
		cursor: t('--terminal-foreground'),
		selectionBackground: t('--terminal-selection'),
		black: t('--ansi-black'),
		red: t('--ansi-red'),
		green: t('--ansi-green'),
		yellow: t('--ansi-yellow'),
		blue: t('--ansi-blue'),
		magenta: t('--ansi-magenta'),
		cyan: t('--ansi-cyan'),
		white: t('--ansi-white'),
		brightBlack: t('--ansi-bright-black'),
		brightRed: t('--ansi-bright-red'),
		brightGreen: t('--ansi-bright-green'),
		brightYellow: t('--ansi-bright-yellow'),
		brightBlue: t('--ansi-bright-blue'),
		brightMagenta: t('--ansi-bright-magenta'),
		brightCyan: t('--ansi-bright-cyan'),
		brightWhite: t('--ansi-bright-white'),
	};
}

/** The name every editor and diff editor in the app is created with. */
export const MONACO_THEME = 'ade';

/*
 * Monaco's theme registry is global and keyed by name, so redefining `ade`
 * retints every live editor at once — no editor needs to be told the theme
 * changed. Syntax colours come from `vs`/`vs-dark`; only the chrome is ours,
 * because a token set of fifteen semantic names cannot express a grammar.
 */
export function defineMonacoTheme(theme: ThemeName): void {
	const t = readToken;
	monaco.editor.defineTheme(MONACO_THEME, {
		base: theme === 'dark' ? 'vs-dark' : 'vs',
		inherit: true,
		rules: [],
		colors: {
			'editor.background': t('--background'),
			'editor.foreground': t('--foreground'),
			'editorLineNumber.foreground': t('--foreground-subtle'),
			'editorLineNumber.activeForeground': t('--muted-foreground'),
			'editorCursor.foreground': t('--foreground'),
			'editor.selectionBackground': t('--terminal-selection'),
			'editorWidget.background': t('--popover'),
			'editorWidget.border': t('--border'),
			'editorGutter.background': t('--background'),
			'editorIndentGuide.background1': t('--border'),
			'editorIndentGuide.activeBackground1': t('--border-strong'),
			'editorOverviewRuler.border': t('--border'),
			'scrollbarSlider.background': t('--scrollbar-slider'),
			'scrollbarSlider.hoverBackground': t('--scrollbar-slider-hover'),
			'scrollbarSlider.activeBackground': t('--scrollbar-slider-active'),
			'diffEditor.insertedTextBackground': t('--status-done') + '22',
			'diffEditor.removedTextBackground': t('--destructive') + '22',
			focusBorder: t('--ring'),
		},
	});
	monaco.editor.setTheme(MONACO_THEME);
}
