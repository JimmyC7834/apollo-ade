/*
 * Icons are characters.
 *
 * A codicon is a webfont rendered at 16px into a 13px line: it never sits on
 * the grid, and beside monospace text it is the one thing that still says "web
 * app". So every icon in this application is a glyph in the same face as the
 * label beside it, and this table is the whole of it.
 *
 * The rule for choosing one: ASCII wherever ASCII is obvious, and a single-cell
 * character where it is not. `✓`, `⏎` and `■` were the three the restyle picked
 * by looking at the alternatives — `[x]` for a tick and `->` for send are
 * cryptic in a way `+` and `x` are not — and the handful below them are the
 * same judgement applied to cases the ticket did not enumerate: a window's
 * maximise box and a theme's half-lit disc are things ASCII can only gesture
 * at. Every one of them is one cell wide, which is the constraint that actually
 * matters.
 */
const GLYPHS = {
	add: '+',
	/* A letter, not a picture. `≡` read as a menu next to a session row. */
	archive: 'A',
	'arrow-left': '←',
	/*
	 * A browser tab. A globe is a picture and needs two cells; this is a page
	 * with something on it, which is what a browser tab is here — the app under
	 * development, not the web.
	 */
	browser: '⊕',
	check: '✓',
	/*
	 * Triangles rather than `v ^ < >`. A letterform sits on the baseline and a
	 * bracket sits at x-height, so beside a label either one reads as slightly
	 * fallen; these are drawn centred on the line by the font, which is the one
	 * thing the ASCII versions cannot be. `>` is still `>` where it is a
	 * *cursor* rather than a disclosure — see the row markers in `App.css`.
	 */
	'chevron-down': '▾',
	'chevron-left': '◂',
	'chevron-right': '▸',
	'chevron-up': '▴',
	'chrome-close': '✕',
	'chrome-maximize': '□',
	'chrome-minimize': '─',
	'chrome-restore': '❐',
	close: '✕',
	'color-mode': '◐',
	'comment-discussion': '@',
	diff: '±',
	discard: '↺',
	edit: '✎',
	error: '✖',
	file: '·',
	files: '/',
	/*
	 * Open and closed are the same glyph on purpose. The tree draws its own
	 * chevron beside this one, so a second way to say "expanded" would be a
	 * second thing to keep in agreement.
	 */
	folder: '/',
	'folder-opened': '/',
	/* vi's ex prompt. Not '>', which read as a row cursor beside a palette row. */
	gear: ':',
	layout: '#',
	lightbulb: '?',
	loading: '~',
	pin: '■',
	'primitive-square': '■',
	quote: '"',
	references: '&',
	remove: '-',
	'replace-all': '⇄',
	'root-folder': '/',
	send: '⏎',
	'source-control': 'Δ',
	/* Panes stacked, and panes side by side. */
	'split-horizontal': '─',
	'split-vertical': '│',
	'symbol-keyword': '§',
	terminal: '$',
	tools: '*',
	trash: 'x',
	warning: '!',
} as const;

/**
 * Every icon this application has. A name with no glyph is a type error rather
 * than a blank space — which is why the props below take this union and not
 * `string`, and why `TreeNode`, `IconButton` and the artifact table take it too.
 */
export type IconName = keyof typeof GLYPHS;

export interface IconProps {
	readonly name: IconName;
}

/**
 * Decorative by definition: the labelled control around an icon carries the
 * meaning, so every icon is hidden from assistive technology. The optional
 * `label` that used to make one an `img` had no caller in two years of slices
 * — an icon that needs a name means the control around it is missing one.
 */
export function Icon({ name }: IconProps) {
	return (
		<span className={`ide-icon ide-icon-${name}`} aria-hidden={true}>
			{GLYPHS[name]}
		</span>
	);
}
