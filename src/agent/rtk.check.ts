// Checks for the rtk rewrite.
//
// The acquisition is Rust's and is not testable from here — this is the policy
// half, which is pure string work. What matters is not that the prefix lands;
// it is every case where it must *not*, because a wrong rewrite runs something
// the user never approved.
//
// `resolveRtk` is exercised only through its browser answer: outside the Tauri
// window there is no native shell, so the honest result is unavailable, and
// that path is reachable under bare node.

import assert from 'node:assert';

import { resolveRtk, rtkArgv, rtkArgvFor, rtkCommand, rtkNotice, RTK_VERSION } from './rtk.ts';

const RTK = 'rtk';
const CACHED = 'C:\\Users\\dev\\AppData\\Roaming\\ade\\rtk\\v0.45.0\\rtk.exe';

// --- the simple case --------------------------------------------------------

assert.equal(rtkCommand('cargo build', RTK), 'rtk cargo build');
assert.equal(rtkCommand('  git status  ', RTK), 'rtk git status', 'and it is trimmed');

// --- chains are split, and each side decided on its own ---------------------

{
	// The shape a model writes constantly. `cd` must stay bare: it is a builtin,
	// and `rtk cd src` asks rtk to spawn a binary that does not exist — which on
	// a chain would take `npm run build` down with it.
	assert.equal(
		rtkCommand('cd src && npm run build', RTK),
		'cd src && rtk npm run build',
		'the builtin is left, the program is wrapped'
	);
	assert.equal(rtkCommand('cd src', RTK), undefined, 'and a builtin alone is not wrapped');
	assert.equal(rtkCommand('a; b', RTK), 'rtk a; rtk b', 'a sequence is two commands');
	assert.equal(rtkCommand('cargo build || cargo clean', RTK), 'rtk cargo build || rtk cargo clean');
	assert.equal(
		rtkCommand('cargo fmt && ls | head', RTK),
		'rtk cargo fmt && ls | head',
		'a pipeline segment is copied through rather than sinking the line'
	);
	assert.equal(
		rtkCommand('cd src&&npm run build', RTK),
		'cd src && rtk npm run build',
		'spacing around the separator is normalised'
	);
}

// --- what is still left entirely alone --------------------------------------

{
	// Not a parsing limit: rtk reformats what it captures, so `head` would read
	// rtk's rendering instead of the command's output.
	assert.equal(rtkCommand('ls | head', RTK), undefined, 'a pipeline is left alone');
	assert.equal(rtkCommand('echo hi > out.txt', RTK), undefined, 'a redirection is left alone');
	assert.equal(rtkCommand('cargo build &', RTK), undefined, 'a background job is left alone');
	// These nest or span lines, which is where a scanner this size stops being
	// honest about what it is reading.
	assert.equal(rtkCommand('echo $(date)', RTK), undefined, 'a substitution is left alone');
	assert.equal(rtkCommand('echo `date`', RTK), undefined, 'the old substitution too');
	assert.equal(rtkCommand('(cd src && ls)', RTK), undefined, 'a subshell is left alone');
	assert.equal(rtkCommand('one\ntwo', RTK), undefined, 'a two-line script is left alone');
}

// --- quoting, which is what makes the split safe ----------------------------

{
	assert.equal(
		rtkCommand('git commit -m "a && b"', RTK),
		'rtk git commit -m "a && b"',
		'a separator inside quotes is not a separator'
	);
	assert.equal(
		rtkCommand("grep ';' file && ls", RTK),
		"rtk grep ';' file && rtk ls",
		'and the real one after it still is'
	);
	assert.equal(rtkCommand('echo "unbalanced', RTK), undefined, 'an unbalanced quote is not guessed at');
}

{
	// A shell assignment is not a program, and rtk would try to run it as one.
	assert.equal(rtkCommand('NO_COLOR=1 cargo build', RTK), undefined);
	// But an `=` anywhere else is just an argument.
	assert.equal(rtkCommand('cargo build --features=foo', RTK), 'rtk cargo build --features=foo');
}

{
	assert.equal(rtkCommand('', RTK), undefined, 'nothing to run');
	assert.equal(rtkCommand('   ', RTK), undefined);
	assert.equal(rtkCommand('cargo build;', RTK), undefined, 'an empty side is not guessed at');
	assert.equal(rtkCommand('&& cargo build', RTK), undefined);
}

// --- never twice ------------------------------------------------------------

{
	assert.equal(rtkCommand('rtk cargo build', RTK), undefined, 'already wrapped');
	assert.equal(rtkCommand('rtk.exe cargo build', RTK), undefined);
	assert.equal(rtkCommand("'C:/x/rtk.exe' cargo build", CACHED), undefined, 'the cached one too');
	assert.equal(
		rtkCommand('rtk cargo fmt && cargo build', RTK),
		'rtk cargo fmt && rtk cargo build',
		'per segment, so a half-wrapped chain is completed rather than doubled'
	);
}

// --- quoting the cached path ------------------------------------------------

{
	// Windows path, Git Bash shell: every backslash there is an escape. Forward
	// slashes are what survives the trip, and Windows accepts them.
	assert.equal(
		rtkCommand('cargo build', CACHED),
		`'C:/Users/dev/AppData/Roaming/ade/rtk/v0.45.0/rtk.exe' cargo build`
	);
	assert.equal(
		rtkCommand('cargo build', "/home/o'brien/rtk"),
		undefined,
		'a quote in the path is refused rather than escaped'
	);
	assert.ok(!rtkCommand('cargo build', RTK)?.includes("'"), 'a bare PATH lookup is not quoted');
}

// --- argv, for user tools ---------------------------------------------------

{
	assert.deepEqual(rtkArgv(['python3', 'clean.py'], RTK), ['rtk', 'python3', 'clean.py']);
	assert.deepEqual(
		rtkArgv(['echo', 'a b'], RTK),
		['rtk', 'echo', 'a b'],
		'nothing is joined, so nothing needs quoting'
	);
	assert.equal(rtkArgv(['rtk', 'cargo', 'build'], RTK), undefined, 'already wrapped');
	assert.equal(rtkArgv([], RTK), undefined);
}

// --- the deny list still reads it -------------------------------------------

{
	// The reason the rewrite runs *before* the deny list rather than after: what
	// the gate screens has to be what runs, and it still matches once prefixed.
	const { destructive } = await import('./gate.ts');
	assert.ok(destructive(rtkCommand('rm -rf build', RTK) ?? ''), 'still caught through rtk');
	assert.ok(destructive(rtkArgv(['rm', '-rf', 'build'], RTK)?.join(' ') ?? ''), 'and as argv');
}

// --- unavailable is said once -----------------------------------------------

{
	// And an unavailable rtk hands the argv back untouched rather than refusing
	// — the user's tool still runs, it just runs unfiltered.
	assert.deepEqual(await rtkArgvFor(['python3', 'clean.py']), ['python3', 'clean.py']);

	const status = await resolveRtk();
	assert.equal(status.source, 'unavailable', 'there is no native shell under node');
	const first = rtkNotice(status);
	assert.ok(first?.includes('unfiltered'), 'the first one says what happens instead');
	assert.equal(rtkNotice(status), undefined, 'and it is not repeated');
	assert.equal(rtkNotice({ source: 'path', path: 'rtk' }), undefined, 'a working rtk says nothing');
}

assert.match(RTK_VERSION, /^v\d+\.\d+\.\d+$/, 'the pin is a version, not a tag like latest');

console.log('agent/rtk.check.ts: ok');
