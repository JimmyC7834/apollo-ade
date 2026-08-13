// Checks for the escape strip.
//
// Pure string work, so this needs no harness, no environment and no model.
// Smaller than it was: ticket 11 deleted the rule table this file used to spend
// most of its length on, and what is left is the one stage that survived —
// which has exactly two jobs, remove terminal instructions and lose no content.

import assert from 'node:assert';

import { stripControl, stripNote } from './strip.ts';

// --- what it removes --------------------------------------------------------

{
	// SGR colour: the 38% of a real `npm run build`.
	const raw = '\x1b[36mvite v6.4.3 \x1b[32mbuilding\x1b[39m\n';
	const out = stripControl(raw);
	assert.equal(out, 'vite v6.4.3 building\n', 'colour goes, the words stay');
	assert.equal(
		stripNote(raw, out),
		`[stripped terminal control codes, ${raw.length} to ${out.length} bytes]`,
		'and it announces itself in bytes, because bytes are what is spent'
	);
}

{
	// Not only colour. Cursor movement and line erase are how a progress bar
	// overdraws, and piped output keeps every frame.
	assert.equal(stripControl('\x1b[2K\x1b[1Abuilding'), 'building', 'erase and cursor-up go');
}

// --- what it keeps ----------------------------------------------------------

{
	const raw = 'line one\n\nline two\n   \n';
	assert.equal(stripControl(raw), raw, 'output with no escapes passes through byte for byte');
	assert.equal(stripNote(raw, stripControl(raw)), undefined, 'and says nothing');
}

assert.equal(stripControl(''), '');
assert.equal(
	stripControl('a\rb'),
	'a\rb',
	'bare carriage return is deliberately kept — see CONTROL'
);

{
	// The invariant that makes this safe to run on every command, matched or
	// not: it removes bytes, never lines. Nothing the model was told before is
	// missing afterwards.
	const raw = ['\x1b[31mone', 'two\x1b[0m', '', 'three'].join('\n');
	assert.equal(stripControl(raw).split('\n').length, 4, 'the line count is untouched');
}

console.log('agent/strip.check.ts: ok');
