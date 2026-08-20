// Run with `npm run check`. Only the parts of a browser tab that are decisions
// rather than plumbing: which id a new tab gets, what the dev's typing means,
// and where a hidden tab goes. The allow-list is deliberately absent — it lives
// in Rust and is tested there, and a copy here would be the second answer to
// one question.

import assert from 'node:assert/strict';

import { browserTabId, browserTabLabel, isBrowserTab } from './artifacts.ts';
import { hiddenRect, normalizeUrl, urlHost } from './browser.ts';

// Ids are told apart from the two other kinds in `pinned`.
assert.equal(isBrowserTab('browser:1'), true);
assert.equal(isBrowserTab('artifact:terminal'), false);
assert.equal(isBrowserTab('file:src/App.css'), false);

/*
 * Numbers are never reused, which is a correctness requirement and not a
 * preference: the number is also the child webview's label, and opening a label
 * that was closed a moment ago wedges the call that does it.
 */
assert.equal(browserTabId(1), 'browser:1');
assert.equal(browserTabId(12), 'browser:12');
assert.equal(isBrowserTab(browserTabId(3)), true);

// The webview label, which may not carry a colon.
assert.equal(browserTabLabel('browser:2'), 'browser-2');

/*
 * A bare host is what anyone types into an address row. Without this it parses
 * as the scheme `localhost:` and Rust refuses it for having the wrong scheme,
 * which is a confusing answer to a reasonable thing to have typed.
 */
assert.equal(normalizeUrl('localhost:5173'), 'http://localhost:5173');
assert.equal(normalizeUrl('  127.0.0.1:8080/x  '), 'http://127.0.0.1:8080/x');
// An explicit scheme is never rewritten — including one the allow-list refuses,
// because deciding that is Rust's job and not this function's.
assert.equal(normalizeUrl('https://localhost:8443/'), 'https://localhost:8443/');
assert.equal(normalizeUrl('file:///C:/tmp/page.html'), 'file:///C:/tmp/page.html');
assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
assert.equal(normalizeUrl('   '), '');

// The host is what a dock tab and a transcript chip are labelled with.
assert.equal(urlHost('http://localhost:5173/a/b?c=1'), 'localhost:5173');
assert.equal(urlHost('file:///C:/tmp/page.html'), 'file');

/*
 * A hidden tab keeps its size and moves below the window, where the OS clips
 * it. It is not `hide()`n: a webview that has never been shown may report
 * zero-size rects, and the agent would then read a page with no layout. See
 * `hiddenRect` and ADR 0004.
 */
const shown = { x: 700, y: 40, width: 500, height: 600 };
const hidden = hiddenRect(shown, 800);
assert.equal(hidden.width, shown.width);
assert.equal(hidden.height, shown.height);
assert.ok(hidden.y >= 800, 'a hidden tab sits below the window');

console.log('browser.check.ts ok');
