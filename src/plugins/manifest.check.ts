// Run with `npm run check`. These are the rules that decide whether foreign code
// runs, so they are checked without a window rather than by opening one.

import assert from 'node:assert/strict';

import {
	API_VERSION,
	evaluatePlugin,
	isEnabled,
	parseManifest,
	type DiscoveredPlugin,
} from './manifest.ts';

const good = JSON.stringify({
	name: 'Hello',
	description: 'says hello',
	api: API_VERSION,
	script: 'index.js',
});

// The happy path, and the fields that survive it.
const parsed = parseManifest(good);
assert.ok('manifest' in parsed);
assert.equal(parsed.manifest.name, 'Hello');
assert.equal(parsed.manifest.script, 'index.js');
assert.equal(parsed.manifest.panel, undefined);

// Malformed, in each of the ways a hand-written file goes wrong.
assert.ok('reason' in parseManifest('{'));
assert.ok('reason' in parseManifest('[]'));
assert.ok('reason' in parseManifest('{"api":1,"script":"i.js"}'));
assert.ok('reason' in parseManifest('{"name":"x","api":"1","script":"i.js"}'));
assert.ok('reason' in parseManifest('{"name":"x","api":1.5,"script":"i.js"}'));
// An entry point is what makes a folder a plugin rather than a typo.
assert.ok('reason' in parseManifest('{"name":"x","api":1}'));

/*
 * **The api message names both numbers.** "Not compatible" tells an author
 * nothing they can act on; this tells them what to change and what we speak.
 */
const mismatch = parseManifest('{"name":"Future","api":99,"script":"i.js"}');
assert.ok('reason' in mismatch);
assert.match(mismatch.reason, /99/);
assert.match(mismatch.reason, new RegExp(String(API_VERSION)));

// A theme with no code at all is a whole plugin.
assert.ok('manifest' in parseManifest(`{"name":"Dark","api":${API_VERSION},"theme":"t.json"}`));

const found = (over: Partial<DiscoveredPlugin>): DiscoveredPlugin => ({
	id: 'global:hello',
	scope: 'global',
	folder: 'hello',
	dir: '/tmp/hello',
	manifest: good,
	script: 'export default () => {};',
	...over,
});

assert.equal(evaluatePlugin(found({})).ok, true);

// Rust's own failure wins, because "cannot read plugin.json" is a better
// sentence for a missing file than "not valid JSON".
const unreadable = evaluatePlugin(found({ error: 'cannot read plugin.json: not found' }));
assert.equal(unreadable.ok, false);
assert.ok(!unreadable.ok && unreadable.failure.reason.includes('not found'));

// A named script that is not there fails the plugin and names the file.
const missing = evaluatePlugin(found({ script: null }));
assert.equal(missing.ok, false);
assert.ok(!missing.ok && missing.failure.reason.includes('index.js'));
// And it is named by the manifest's name, not the folder's — that is the name
// the author will recognise in Problems.
assert.ok(!missing.ok && missing.failure.name === 'Hello');

/*
 * **The sharpest edge in the design.** A global plugin runs because putting the
 * folder there was the trust decision. A local one arrived with a repository and
 * runs only after somebody said so for that root — cloning must never be the
 * same act as running the author's code.
 */
assert.equal(isEnabled({ id: 'global:a', scope: 'global' }, []), true);
assert.equal(isEnabled({ id: 'local:a', scope: 'local' }, []), false);
assert.equal(isEnabled({ id: 'local:a', scope: 'local' }, ['local:a']), true);
assert.equal(isEnabled({ id: 'local:a', scope: 'local' }, ['local:b']), false);

console.log('plugins/manifest.check.ts: ok');
