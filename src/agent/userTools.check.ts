// Run with `npm run check`.
//
// The properties worth asserting are the ones a security argument rests on
// (docs/wayfinder/pi-harness/tickets/13-user-authored-tools.md): a parameter
// fills exactly one argv element and is never re-parsed, a manifest cannot
// choose its own program, and profile membership rather than file presence is
// what arms a tool.

import assert from 'node:assert/strict';
import { installUserTools, resolveArgv, userTools, type UserTool } from './userTools.ts';
import { destructive } from './gate.ts';
import {
	activateProfile,
	activeToolNames,
	installProfiles,
	listProfiles,
	setCapabilities,
	type Profile,
} from './profile.ts';

const GREP = {
	name: 'grep',
	description: 'search',
	argv: ['rg', '--json', '{pattern}', '{path}'],
	parameters: { pattern: 'what to find', path: 'where to look' },
};

const only = (): UserTool => {
	assert.equal(userTools().length, 1, 'expected exactly one tool');
	return userTools()[0];
};

const profileNamed = (name: string): Profile => {
	const found = listProfiles().find((profile) => profile.name === name);
	assert.ok(found, `no profile named ${name}`);
	return found;
};

// The injection the argv decision exists to prevent. A shell metacharacter in a
// parameter is one argument, not a new command — and this is the assertion that
// would fail the day someone "simplifies" argv back into a command string.
{
	installUserTools([GREP]);
	const argv = resolveArgv(only(), { pattern: '; rm -rf ~', path: '.' });
	assert.deepEqual(argv, ['rg', '--json', '; rm -rf ~', '.']);
	assert.equal(argv.length, 4, 'a value with spaces is still one element');

	// A parameter as a fragment of an element is allowed; it still cannot split.
	installUserTools([
		{ name: 'tsc', description: 'typecheck', argv: ['tsc', '--project={dir}'], parameters: { dir: 'where' } },
	]);
	assert.deepEqual(resolveArgv(only(), { dir: 'a b' }), ['tsc', '--project=a b']);
}

// The floor reaches user tools through the resolved argv, which is decision 4:
// the gate examines the command, not the tool's identity, and being trusted
// enough to be in a profile does not lift it.
{
	installUserTools([
		{ name: 'nuke', description: 'clean up', argv: ['rm', '-rf', '{dir}'], parameters: { dir: 'what' } },
	]);
	assert.ok(destructive(resolveArgv(only(), { dir: 'build' }).join(' ')));
}

// What a manifest may not be. Every one of these is rejected whole rather than
// repaired, because half a manifest is a tool that runs something other than
// what its author wrote.
{
	const bad: unknown[] = [
		{ ...GREP, name: 'bash' },
		{ ...GREP, name: 'has space' },
		{ ...GREP, argv: ['{program}', 'x'], parameters: { program: 'anything' } },
		{ ...GREP, argv: [] },
		{ ...GREP, description: '' },
		{ ...GREP, runtime: 'worker' },
		{ ...GREP, argv: ['rg', '{nope}'] },
		// Off `Object.prototype`, which `key in parameters` would have accepted.
		{ ...GREP, argv: ['rg', '{toString}'] },
		{ ...GREP, argv: ['rg', '{pattern}'] },
		'not an object',
	];

	for (const definition of bad) {
		const problems = installUserTools([definition]);
		assert.deepEqual(userTools(), [], `should have refused: ${JSON.stringify(definition)}`);
		assert.equal(problems.length, 1, `said why: ${problems.join(' | ')}`);
	}

	// A good one beside a bad one still loads. One typo should not cost the file.
	const problems = installUserTools([GREP, { ...GREP, name: 'read' }]);
	assert.deepEqual(
		userTools().map((tool) => tool.name),
		['grep']
	);
	assert.equal(problems.length, 1);
	assert.ok(problems[0].includes('built-in'), problems[0]);
}

// Project wins, by arriving later — the same precedence the profiles use.
{
	installUserTools([GREP, { ...GREP, description: 'the project one' }]);
	assert.equal(only().description, 'the project one', 'the same name is one tool');
}

// The reconciliation between the two tickets: a user tool is off until a
// profile names it, where a built-in is on until one disables it.
{
	installUserTools([GREP]);
	setCapabilities({
		tools: ['read', 'write', 'edit', 'bash', 'grep'],
		skills: [],
		optIn: ['grep'],
	});
	installProfiles([
		{ name: 'plain' },
		{ name: 'armed', tools: { grep: true } },
		{ name: 'quiet', tools: { grep: false, bash: false } },
	]);

	assert.ok(!activeToolNames(profileNamed('plain')).includes('grep'), 'a file is not consent');
	assert.ok(activeToolNames(profileNamed('plain')).includes('bash'), 'built-ins keep default-on');
	assert.ok(activeToolNames(profileNamed('armed')).includes('grep'), 'naming it is what arms it');
	assert.deepEqual(activeToolNames(profileNamed('quiet')), ['read', 'write', 'edit']);

	assert.equal(activateProfile('armed').ok, true, 'a declared tool activates');
}

// A profile naming a tool no manifest declares still refuses to activate — the
// dangling-reference rule reaching user tools without being told about them.
{
	installUserTools([]);
	setCapabilities({ tools: ['read', 'write', 'edit', 'bash'], skills: [], optIn: [] });
	installProfiles([{ name: 'armed', tools: { grep: true } }]);

	const refused = activateProfile('armed');
	assert.equal(refused.ok, false);
	assert.match(refused.ok === false ? refused.reason : '', /tool "grep"/);
}

console.log('agent/userTools.check.ts: ok');
