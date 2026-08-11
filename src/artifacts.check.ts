// Run with `npm run check`. The dock's two rules that are arithmetic rather
// than markup: which edge it docks to, and the size bounds that keep it usable.

import assert from 'node:assert/strict';
import {
	DOCK_MAX_FRACTION,
	DOCK_MIN_FRACTION,
	PORTRAIT_BREAKPOINT,
	TOOL_ARTIFACTS,
	clampDock,
	dockSide,
	isToolArtifact,
	toolArtifactKind,
} from './artifacts.ts';

// Landscape docks right; portrait docks below.
assert.equal(dockSide(1440, 900), 'right');
assert.equal(dockSide(900, 1440), 'bottom');
// A narrow *landscape* window still docks below: a dock beside a 300px chat
// column is not a dock. This is the rule that is easy to drop.
assert.equal(dockSide(PORTRAIT_BREAKPOINT - 1, 400), 'bottom');
assert.equal(dockSide(PORTRAIT_BREAKPOINT, 400), 'right');
// Exactly square is landscape. Not a rule anyone stated — pinned here only so
// the boundary has one answer rather than whichever the comparison happened to
// give the day someone looked.
assert.equal(dockSide(1000, 1000), 'right');

assert.equal(clampDock(0.4), 0.4);
assert.equal(clampDock(0), DOCK_MIN_FRACTION);
assert.equal(clampDock(1), DOCK_MAX_FRACTION);
assert.equal(clampDock(DOCK_MIN_FRACTION), DOCK_MIN_FRACTION);
assert.equal(clampDock(DOCK_MAX_FRACTION), DOCK_MAX_FRACTION);

// Tool artifact ids round-trip, and a file id is not mistaken for one.
for (const [kind, artifact] of Object.entries(TOOL_ARTIFACTS)) {
	assert.ok(isToolArtifact(artifact.id), artifact.id);
	assert.equal(toolArtifactKind(artifact.id), kind);
}
assert.equal(isToolArtifact('src/App.tsx'), false);
assert.equal(toolArtifactKind('src/App.tsx'), undefined);
// `diff:` and `replace:` editor ids are files, not tool artifacts — they share
// the tab strip but not the id space.
assert.equal(isToolArtifact('diff:src/App.tsx'), false);
assert.equal(isToolArtifact('replace:src/App.tsx'), false);

console.log('artifacts.check.ts: ok');
