// Checks for the output crop seam.
//
// Pure string work, so this needs no harness, no environment and no model. The
// interesting cases are the three safety rules rather than the npm rule itself:
// an unmatched command must come back byte for byte, a crop that grew must be
// discarded, and every crop must be announced.

import assert from 'node:assert';

import { crop, cropNote, ruleFor, RULES, stripControl } from './crop.ts';

// --- matching is opt-in -----------------------------------------------------

assert.equal(ruleFor('cat src/main.ts'), undefined, 'an unknown command has no rule');
assert.equal(ruleFor('npm'), undefined, 'bare npm lists scripts and is not noise');
assert.equal(ruleFor('npm install'), undefined, 'only the script-running subcommands match');
assert.ok(ruleFor('npm run build'), 'npm run matches');
assert.ok(ruleFor('  npm exec vite'), 'leading whitespace does not defeat the match');
assert.ok(ruleFor('npm x tsc'), 'the short aliases rtk lists match too');

{
	// The rule that matters most: anything without a rule keeps every line. With
	// no control codes in the input there is nothing for the strip to do either,
	// so this case is still byte for byte.
	const raw = 'line one\n\nline two\n   \n';
	const out = crop('cat notes.txt', raw);
	assert.equal(out.text, raw, 'an unmatched command passes through byte for byte');
	assert.equal(out.dropped, 0);
	assert.equal(cropNote(raw, out), undefined, 'and says nothing');
}

// --- the escape strip, which is the part that pays ---------------------------

{
	// SGR colour: the 38% of a real `npm run build`. Content identical, bytes
	// down, and it happens for a command with no rule at all.
	const raw = '[36mvite v6.4.3 [32mbuilding[39m\n';
	const out = crop('cat build.log', raw);
	assert.equal(out.text, 'vite v6.4.3 building\n', 'colour goes, the words stay');
	assert.equal(out.dropped, 0, 'stripping is not dropping — no line was lost');
	assert.equal(
		cropNote(raw, out),
		`[stripped terminal control codes, ${raw.length} to ${out.text.length} bytes]`,
		'and it still announces itself, with the other wording'
	);
}

{
	// Not only colour. Cursor movement and line erase are how a progress bar
	// overdraws, and piped output keeps every frame.
	assert.equal(stripControl('[2K[1Abuilding'), 'building', 'erase and cursor-up go');
	assert.equal(stripControl('plain text'), 'plain text', 'text with no escapes is identical');
	assert.equal(stripControl(''), '');
	assert.equal(
		stripControl('a\rb'),
		'a\rb',
		'bare carriage return is deliberately kept — see CONTROL'
	);
}

{
	// Order matters: the strip runs first, so a line that was *only* escapes is
	// blank by the time the npm rule's blank-line pattern sees it. Reversing the
	// two stages would leave it in.
	const raw = ['> app@1.0.0 build', '[39m', 'real output'].join('\n');
	const out = crop('npm run build', raw);
	assert.equal(out.text, 'real output', 'an escapes-only line becomes blank and is then dropped');
}

// --- the npm rule, transcribed from rtk -------------------------------------

{
	const raw = [
		'',
		'> tauri-ade-prototype@0.1.0 build',
		'> tsc && vite build',
		'',
		'npm WARN config production Use `--omit=dev` instead.',
		'npm notice New major version of npm available!',
		'vite v6.0.3 building for production...',
		'✓ 412 modules transformed.',
		'',
	].join('\n');
	const out = crop('npm run build', raw);

	assert.deepEqual(
		out.text.split('\n'),
		[
			// Kept, and rtk keeps it too: its condition is `starts_with('>') &&
			// contains('@')`, so the version banner goes and the echoed command
			// line stays. That is the right way round — the model wants to know
			// what `npm run build` actually ran.
			'> tsc && vite build',
			'vite v6.0.3 building for production...',
			'✓ 412 modules transformed.',
		],
		'the banner, the warnings and the blank lines go; the real output stays'
	);
	assert.equal(out.total, 9);
	assert.equal(out.dropped, 6);
	assert.ok(out.text.length < raw.length, 'and it is shorter, which is the point');
}

{
	// `...` only counts as a progress remnant on a short line. rtk's bound is
	// `len < 10`, and it exists so that prose ending in an ellipsis survives.
	const raw = ['....', 'building for production...', 'done'].join('\n');
	const out = crop('npm run build', raw);
	assert.deepEqual(
		out.text.split('\n'),
		['building for production...', 'done'],
		'a long line containing ... is not a progress remnant'
	);
}

{
	// Every line is noise, so the command that printed nothing useful says so
	// rather than handing the model an empty string to interpret.
	const raw = 'npm WARN one\nnpm WARN two\nnpm WARN three\nnpm WARN four\n';
	const out = crop('npm run lint', raw);
	assert.equal(out.text, 'ok', 'onEmpty stands in for nothing at all');
	assert.equal(out.dropped, 5);
}

// --- never worse ------------------------------------------------------------

{
	// `on_empty` is three bytes of "ok"; the input here is two. Substituting
	// would *grow* the output, so the guard hands back the original. This is
	// rtk's `core/guard.rs:6-12`, and it is the reason that file exists.
	const raw = '\n';
	const out = crop('npm run build', raw);
	assert.equal(out.text, raw, 'a crop that grew the output is discarded');
	assert.equal(out.dropped, 0, 'and it reports nothing dropped, because nothing was');
	assert.equal(cropNote(raw, out), undefined);
}

{
	const out = crop('npm run build', '');
	assert.equal(out.text, '', 'empty output stays empty rather than becoming "ok"');
	assert.equal(out.dropped, 0);
}

// --- it always says what it did ---------------------------------------------

{
	const raw = '> app@1.0.0 build\nreal output\n';
	const out = crop('npm run build', raw);
	assert.equal(
		cropNote(raw, out),
		`[cropped 2 of 3 lines, ${raw.length} to ${out.text.length} bytes]`,
		'the note carries lines and bytes — bytes because bytes are what is spent'
	);
}

// --- the table itself -------------------------------------------------------

{
	// A rule that can never match is dead weight, and a rule with no patterns
	// is a no-op that still costs a scan. Cheap to assert, and it will catch a
	// half-finished entry the moment the table grows.
	for (const rule of RULES) {
		assert.ok(rule.drop.length > 0, 'every rule drops something');
		assert.ok(rule.match.source.length > 0);
	}
}

console.log('agent/crop.check.ts: ok');
