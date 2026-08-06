// Run with `npm run check`. `neighbourId` is the one worth a check: it was two
// copies of an off-by-one that only shows itself at the end of the list.

import assert from 'node:assert/strict';
import { basename, dirname, neighbourId } from './ids.ts';

assert.equal(dirname('src/a/b.ts'), 'src/a');
assert.equal(dirname('README.md'), undefined);
assert.equal(basename('src/a/b.ts'), 'b.ts');
assert.equal(basename('README.md'), 'README.md');

const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
// The one that takes its place…
assert.equal(neighbourId(tabs, 'a'), 'b');
assert.equal(neighbourId(tabs, 'b'), 'c');
// …and the one before it, when nothing takes its place.
assert.equal(neighbourId(tabs, 'c'), 'b');
assert.equal(neighbourId([{ id: 'a' }], 'a'), undefined);
// An id that is not there closes nothing, so nothing changes hands.
assert.equal(neighbourId(tabs, 'gone'), undefined);

console.log('ids.check.ts: ok');
