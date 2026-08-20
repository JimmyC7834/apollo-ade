// Run with `npm run check`.
//
// The uneven half of `relay`. A payload leaving a panel is cut into URL-sized
// pieces by the init script in `browser.rs`; this is the side that puts it back
// together, and the point of the ticket is that neither half of the plugin can
// tell.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { joinRelay, panelUrl, type Pending } from './panels.ts';

// --- the URL a plugin's page is served from ----------------------------------

const hello = { scope: 'local' as const, dir: 'C:\\work\\repo\\.ade\\plugins\\hello' };
assert.equal(panelUrl(hello, 'panel.html'), 'plugin://local/hello/panel.html');
// A leading `./` is what anyone writes, and it means the same thing.
assert.equal(panelUrl(hello, './panel.html'), 'plugin://local/hello/panel.html');
assert.equal(panelUrl(hello, 'ui/index.html'), 'plugin://local/hello/ui/index.html');
assert.equal(
	panelUrl({ scope: 'global', dir: '/home/me/.local/share/ade/plugins/notes' }, 'p.html'),
	'plugin://global/notes/p.html'
);
// Escaping is refused here as well as in Rust. Two answers to one question would
// be one answer too many, except that this one is only about what a *plugin*
// asked for — Rust's is about what is actually served, and that is the one that
// binds.
for (const bad of ['../secret', 'ui/../../secret', '', '   ']) {
	assert.throws(() => panelUrl(hello, bad), /inside the plugin's own folder/);
}

// --- rejoining ----------------------------------------------------------------

/** Exactly what the init script does, so the two halves are tested together. */
function chunksFor(payload: unknown, seq: number, size: number): string[] {
	const body = encodeURIComponent(JSON.stringify(payload));
	const total = Math.max(1, Math.ceil(body.length / size));
	return Array.from(
		{ length: total },
		(_, index) => `relay:${seq}.${index}.${total}.${body.slice(index * size, (index + 1) * size)}`
	);
}

const pending: Pending = new Map();

// Something that fits in one piece.
const small = chunksFor({ hello: 'world' }, 1, 1200);
assert.equal(small.length, 1);
assert.deepEqual(joinRelay(pending, 'panel-1', small[0]), { payload: { hello: 'world' } });
assert.equal(pending.size, 0, 'a completed payload leaves nothing behind');

/*
 * **The acceptance criterion**: a payload large enough to exceed a URL survives
 * the trip intact. 40 KB is far past what a navigation carries, and it arrives
 * as the object that was sent rather than as a string somebody has to reassemble.
 */
const big = { rows: Array.from({ length: 800 }, (_, at) => ({ at, text: `row number ${at}` })) };
const pieces = chunksFor(big, 2, 1200);
assert.ok(pieces.length > 20, `expected many chunks, got ${pieces.length}`);
let joined: { payload: unknown } | undefined;
for (const piece of pieces) {
	joined = joinRelay(pending, 'panel-1', piece) ?? joined;
}
assert.deepEqual(joined?.payload, big);
assert.equal(pending.size, 0);

// Two panels sending at once do not interleave into each other's payload.
const fromA = chunksFor('from a', 3, 4);
const fromB = chunksFor('from b', 3, 4);
assert.ok(fromA.length > 1 && fromA.length === fromB.length);
let a: { payload: unknown } | undefined;
let b: { payload: unknown } | undefined;
for (let at = 0; at < fromA.length; at += 1) {
	a = joinRelay(pending, 'panel-1', fromA[at]) ?? a;
	b = joinRelay(pending, 'panel-2', fromB[at]) ?? b;
}
assert.deepEqual(a, { payload: 'from a' });
assert.deepEqual(b, { payload: 'from b' });

// Everything else on this channel is somebody else's message — `esc` comes up it.
assert.equal(joinRelay(pending, 'browser-1', 'esc'), undefined);
assert.equal(joinRelay(pending, 'browser-1', 'relayish'), undefined);

// The payload is never parsed by us beyond JSON: a plugin's own protocol lives
// inside it, and `null` and `false` are payloads like any other.
assert.deepEqual(joinRelay(pending, 'panel-1', chunksFor(null, 9, 1200)[0]), { payload: null });
assert.deepEqual(joinRelay(pending, 'panel-1', chunksFor(false, 10, 1200)[0]), { payload: false });

// --- the two halves agree ------------------------------------------------------

/*
 * The sending half lives in a Rust string literal, so nothing type-checks it
 * against the regular expression above. This is what does: the wire format is
 * `relay:<seq>.<index>.<total>.<body>` on both sides, and an edit to either one
 * that forgets the other fails here.
 */
const rust = readFileSync(new URL('../../src-tauri/src/browser.rs', import.meta.url), 'utf8');
assert.match(rust, /'relay:' \+ id \+ '\.' \+ index \+ '\.' \+ total \+ '\.'/);
assert.match(rust, /window\.__adeRelay/, 'the ADE delivers into a panel through this global');
assert.match(rust, /window\.__adeTheme/, 'and tells it which theme is on through this one');

console.log('plugins/panels.check.ts: ok');
