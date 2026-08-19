// Run with `npm run check`. One rule, and it is the kind that fails silently:
// every token `theme.ts` hands to Monaco must be a hex literal.
//
// Monaco's colour parser accepts `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`.
// Given anything else it neither throws nor falls back to its own default — it
// returns **red**. So a token written in perfectly good CSS (`rgb(0 0 0 / 22%)`,
// `hsl(...)`, `color-mix(...)`, a bare colour name) reaches the editor as a red
// scrollbar, a red indent guide, a red ruler, with nothing logged anywhere.
//
// This check reads `tokens.css` as text rather than through a browser, so it
// can run in node beside the others. That means it cannot resolve a token
// defined as `var(--other)` — which is itself worth failing on, since Monaco
// would receive the literal string `var(--other)` and paint it red too.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tokensPath = fileURLToPath(new URL('./tokens.css', import.meta.url));
const themePath = fileURLToPath(new URL('./theme.ts', import.meta.url));
const tokens = readFileSync(tokensPath, 'utf8');
const theme = readFileSync(themePath, 'utf8');

/*
 * The list is derived from `theme.ts` rather than restated here, so a token
 * added to the Monaco theme is covered without anybody remembering to come back
 * and add it. `t('--name')` is the only way a token gets in there.
 */
const consumed = [...theme.matchAll(/\bt\('(--[a-z0-9-]+)'\)/g)].map((match) => match[1]);
assert.ok(consumed.length > 20, `expected theme.ts to read many tokens, found ${consumed.length}`);

/** Every value a token is given, across both the light and the dark block. */
function valuesOf(name: string): readonly string[] {
	const pattern = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm');
	return [...tokens.matchAll(pattern)].map((match) => match[1].trim());
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

for (const name of new Set(consumed)) {
	const values = valuesOf(name);
	// A token Monaco reads that `tokens.css` never defines resolves to the empty
	// string, which is the same class of silent failure.
	assert.ok(values.length > 0, `${name} is read by theme.ts but not defined in tokens.css`);
	for (const value of values) {
		assert.ok(HEX.test(value), `${name} is \`${value}\`, which Monaco parses as red — use hex`);
	}
}

// The three that were actually wrong, named so the regression has a home.
for (const name of ['--scrollbar-slider', '--scrollbar-slider-hover', '--scrollbar-slider-active']) {
	const values = valuesOf(name);
	assert.equal(values.length, 2, `${name} should be defined once per theme`);
	for (const value of values) {
		assert.match(value, /^#[0-9a-f]{8}$/i, `${name} is translucent, so it needs the alpha pair`);
	}
}

console.log('theme.check.ts ok');
