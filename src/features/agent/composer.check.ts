// Run with `npm run check`.
//
// Two things here can be wrong without looking wrong, which is why they are
// checked: which folder a path drills into, and whether an attachment that is
// already mentioned gets mentioned again. Both produce a plausible screen.

import assert from 'node:assert/strict';

import {
	children,
	formatContext,
	pathLabel,
	profileSummary,
	ringDash,
	withAttachments,
} from './composer.ts';
import type { Profile } from '../../agent/profile.ts';

const files = [
	'README.md',
	'src/App.tsx',
	'src/agent/env.ts',
	'src/agent/gate.ts',
	'src/ui/Icon.tsx',
	'package.json',
];

// The root: folders before files, each alphabetical, and a folder appears once
// however many files are under it. `localeCompare` rather than `<`, so
// `package.json` sorts beside `README.md` instead of after every capital —
// which is the order every file explorer shows and the one nobody notices.
assert.deepEqual(
	children(files, '').map((entry) => `${entry.kind}:${entry.path}`),
	['dir:src', 'file:package.json', 'file:README.md']
);

// Drilling in lists immediate children only — `src/agent/env.ts` is not a row
// here, it is behind the `src/agent` row.
assert.deepEqual(
	children(files, 'src').map((entry) => `${entry.kind}:${entry.path}`),
	['dir:src/agent', 'dir:src/ui', 'file:src/App.tsx']
);
assert.deepEqual(
	children(files, 'src/agent').map((entry) => entry.path),
	['src/agent/env.ts', 'src/agent/gate.ts']
);

// A prefix that is not a path boundary must not match: `src` is a folder, `sr`
// is nothing. Without the trailing slash every `src*` file would list under it.
assert.deepEqual(children(files, 'sr'), []);
assert.deepEqual(children(files, 'nope'), []);

// A file's own path is not a folder, so drilling into one lists nothing.
assert.deepEqual(children(files, 'README.md'), []);

assert.equal(pathLabel(''), 'Workspace');
assert.equal(pathLabel('src/agent'), 'src/agent');

assert.equal(formatContext(128_000), '128k');
assert.equal(formatContext(200_000), '200k');
assert.equal(formatContext(1_048_576), '1M');
assert.equal(formatContext(2_000_000), '2M');
assert.equal(formatContext(undefined), 'context unknown');

const profile = {
	name: 'Default',
	model: { provider: 'deepseek', id: 'deepseek-chat' },
	thinkingLevel: 'off',
} as Profile;
assert.equal(profileSummary(profile), 'deepseek-chat · off · 128k');
// A profile with no model still renders a summary rather than a blank bar.
assert.equal(
	profileSummary({ ...profile, model: { provider: 'deepseek', id: '' } } as Profile),
	'no model · off · context unknown'
);

// Attachments become `@` mentions on their own line, in the order they were
// added, deduped — and one the prompt already names is not repeated.
assert.equal(withAttachments('look at this', []), 'look at this');
assert.equal(
	withAttachments('look at this', ['src/App.tsx', 'src/agent/env.ts']),
	'@src/App.tsx @src/agent/env.ts\nlook at this'
);
assert.equal(
	withAttachments('what does @src/App.tsx do', ['src/App.tsx']),
	'what does @src/App.tsx do'
);
assert.equal(
	withAttachments('hello', ['src/App.tsx', 'src/App.tsx']),
	'@src/App.tsx\nhello'
);

// The ring: nothing at 0, everything at 100, and clamped either side rather
// than drawing a negative arc.
const circumference = 2 * Math.PI * 7;
assert.equal(ringDash(0, 7), `0.00 ${circumference.toFixed(2)}`);
assert.equal(ringDash(100, 7), `${circumference.toFixed(2)} 0.00`);
assert.equal(ringDash(150, 7), ringDash(100, 7));
assert.equal(ringDash(-5, 7), ringDash(0, 7));

console.log('composer.check.ts: ok');
