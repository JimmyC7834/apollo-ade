// Run with `npm run check`.
//
// Two rules here are worth a check and the rest is string handling. A reference
// to something that does not exist must resolve to `undefined` — that is what
// makes a dead link render as a dead link instead of opening an empty surface.
// And `toolReferences` must not offer a reference for work that did not happen,
// which is the whole argument for the harness writing these rather than the
// model.

import assert from 'node:assert/strict';

import {
	ARTIFACT_SCHEME,
	artifactHref,
	compactResult,
	normalisePath,
	referencesMarkdown,
	resolveArtifact,
	toolReferences,
} from './references.ts';
import type { ToolPart } from './transcript.ts';

const files = ['src/App.tsx', 'docs/context.md'];

// The four tool artifacts resolve to their ids, which already carry the scheme —
// so the href is `artifact:terminal` and the id is `artifact:terminal`, and
// those are two different strings serving two different purposes.
assert.equal(resolveArtifact('artifact:terminal', files), 'artifact:terminal');
assert.equal(resolveArtifact('artifact:changes', files), 'artifact:changes');
assert.equal(resolveArtifact('artifact:replace', files), 'artifact:replace');
assert.equal(resolveArtifact('artifact:explorer', files), 'artifact:explorer');

// A file artifact is the file's own id, and only if the workspace holds it.
assert.equal(resolveArtifact('artifact:src/App.tsx', files), 'src/App.tsx');
assert.equal(resolveArtifact('artifact:src/Gone.tsx', files), undefined);
// The Guide's own example target. Nothing is named `app`, so it is dead — which
// is the case the visible-failure rule exists for.
assert.equal(resolveArtifact('artifact:app', files), undefined);

// Anything that is not the scheme is not ours. An ordinary link must fall
// through to the ordinary anchor rather than becoming a broken artifact.
assert.equal(resolveArtifact('https://example.com', files), undefined);
assert.equal(resolveArtifact('artifact', files), undefined);
assert.equal(resolveArtifact('', files), undefined);
// Empty target: `artifact:` alone names nothing.
assert.equal(resolveArtifact(ARTIFACT_SCHEME, files), undefined);
// Not reachable through the prototype chain: a target of "constructor" or
// "toString" must not be mistaken for a tool artifact.
assert.equal(resolveArtifact('artifact:toString', files), undefined);
assert.equal(resolveArtifact('artifact:constructor', files), undefined);

assert.equal(artifactHref('terminal'), 'artifact:terminal');
assert.equal(resolveArtifact(artifactHref('src/App.tsx'), files), 'src/App.tsx');

// Paths as the model may write them.
assert.equal(normalisePath('./src/App.tsx'), 'src/App.tsx');
assert.equal(normalisePath('/src/App.tsx'), 'src/App.tsx');
assert.equal(normalisePath('src\\App.tsx'), 'src/App.tsx');
assert.equal(normalisePath('src/App.tsx'), 'src/App.tsx');

const tool = (patch: Partial<ToolPart>): ToolPart => ({
	kind: 'tool',
	id: 't1',
	name: 'bash',
	input: {},
	state: 'done',
	...patch,
});

assert.deepEqual(toolReferences(tool({ name: 'bash', input: { command: 'ls' } })), [
	{ label: 'terminal', target: 'terminal' },
]);

// A write earns both the file it wrote and the diff that now contains it.
assert.deepEqual(toolReferences(tool({ name: 'write', input: { path: './src/App.tsx' } })), [
	{ label: 'src/App.tsx', target: 'src/App.tsx' },
	{ label: 'working diff', target: 'changes' },
]);
// An edit with no readable path still earns the diff — the change happened.
assert.deepEqual(toolReferences(tool({ name: 'edit', input: {} })), [
	{ label: 'working diff', target: 'changes' },
]);
assert.deepEqual(toolReferences(tool({ name: 'read', input: { path: 'docs/context.md' } })), [
	{ label: 'docs/context.md', target: 'docs/context.md' },
]);
// A tool nobody has taught this about earns nothing rather than a guess.
assert.deepEqual(toolReferences(tool({ name: 'glob', input: { path: 'src' } })), []);

// Work that did not happen earns no reference. Both of these would be dead
// clicks: one at a change never made, one at output still arriving.
assert.deepEqual(toolReferences(tool({ name: 'write', input: { path: 'src/App.tsx' }, state: 'failed' })), []);
assert.deepEqual(toolReferences(tool({ name: 'bash', state: 'running' })), []);

assert.equal(
	referencesMarkdown(toolReferences(tool({ name: 'write', input: { path: 'src/App.tsx' } }))),
	'[src/App.tsx](artifact:src/App.tsx) · [working diff](artifact:changes)'
);

// The last line that says anything, not the first — a command's outcome is at
// the bottom and its banner is at the top.
assert.equal(compactResult('building…\n\ndone in 1.2s\n'), 'done in 1.2s');
assert.equal(compactResult(undefined), undefined);
assert.equal(compactResult('   \n\n'), undefined);
// One long line cannot change the chip's width.
const long = compactResult('x'.repeat(200));
assert.ok(long && long.length <= 72, 'a chip result is bounded');
assert.ok(long?.endsWith('…'));

console.log('references.check.ts: ok');
