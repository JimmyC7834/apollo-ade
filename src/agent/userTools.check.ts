// Run with `npm run check`.
//
// The properties worth asserting are the ones a security argument rests on
// (docs/wayfinder/pi-harness/tickets/13-user-authored-tools.md): a parameter
// fills exactly one argv element and is never re-parsed, a manifest cannot
// choose its own program, and profile membership rather than file presence is
// what arms a tool.

import assert from 'node:assert/strict';
import {
	installUserTools,
	resolveArgv,
	userToolDefinitions,
	userTools,
	type UserTool,
} from './userTools.ts';
import { createGate, destructive } from './gate.ts';
import type { AgentEvent } from './index.ts';
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

// Parameters beyond required strings. The short form still means what it meant,
// and an omitted optional takes its whole argv element with it — `rg pattern`
// rather than `rg pattern ""`, which is a different command.
{
	installUserTools([
		{
			name: 'search',
			description: 'search',
			argv: ['rg', '--max-count={limit}', '--{mode}', '{pattern}', '{path}'],
			parameters: {
				pattern: 'what to find',
				path: { description: 'where', required: false },
				limit: { description: 'how many', type: 'number', required: false },
				mode: { description: 'output', choices: ['json', 'text'] },
			},
		},
	]);
	const tool = only();

	assert.deepEqual(tool.parameters.pattern, {
		description: 'what to find',
		type: 'string',
		required: true,
	});

	assert.deepEqual(resolveArgv(tool, { pattern: 'x', path: 'src', limit: 3, mode: 'json' }), [
		'rg',
		'--max-count=3',
		'--json',
		'x',
		'src',
	]);
	assert.deepEqual(
		resolveArgv(tool, { pattern: 'x', mode: 'text' }),
		['rg', '--text', 'x'],
		'both omitted elements are gone, not blank'
	);
	// `false` is a value, not an omission — the trap in writing this with `??`.
	installUserTools([
		{
			name: 'flag',
			description: 'flag',
			argv: ['go', '--strict={on}'],
			parameters: { on: { description: 'strict?', type: 'boolean' } },
		},
	]);
	assert.deepEqual(resolveArgv(only(), { on: false }), ['go', '--strict=false']);
}

// Defaults, so a manifest that says nothing about how it runs still runs.
{
	installUserTools([GREP]);
	assert.equal(only().timeout, 120);
	assert.equal(only().cwd, undefined);
	assert.equal(only().env, undefined);

	installUserTools([{ ...GREP, timeout: 5, cwd: 'packages/app', env: { CI: '1' } }]);
	assert.equal(only().timeout, 5);
	assert.equal(only().cwd, 'packages/app');
	assert.deepEqual(only().env, { CI: '1' });
}

// Braces that are not placeholders. Found by a real manifest rather than by
// thinking about it: argv is full of them, and the first version rejected an
// ordinary `node -e` script for "using {clearInterval(t);} without declaring
// it". Every line here would have failed.
{
	const brace = (argv: string[]) => ({ name: 'brace', description: 'braces', argv });
	const survives = (argv: string[], expected: string[]) => {
		const problems = installUserTools([brace(argv)]);
		assert.deepEqual(problems, [], `rejected ${JSON.stringify(argv)}: ${problems.join(' | ')}`);
		assert.deepEqual(resolveArgv(only(), {}), expected);
	};

	survives(['awk', '{print $1}'], ['awk', '{print $1}']);
	survives(['find', '.', '-exec', 'rm', '{}', ';'], ['find', '.', '-exec', 'rm', '{}', ';']);
	survives(['jq', '{a: .b}'], ['jq', '{a: .b}']);
	survives(['git', 'log', '--format={"h":"%h"}'], ['git', 'log', '--format={"h":"%h"}']);

	// A mistyped parameter is still an identifier, so it is still reported —
	// which is the half of the old rule worth keeping.
	const problems = installUserTools([
		{ ...GREP, argv: ['rg', '{pattenr}', '{path}'] },
	]);
	assert.equal(problems.length, 1);
	assert.ok(problems[0].includes('{pattenr}'), problems[0]);
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

// And it *asks* rather than refuses (ticket 18). Refusing did not stop anyone
// deleting the directory — it moved the deletion into `python3 cleanup.py`,
// where the deny list cannot read it and never asks at all.
//
// Nothing is spawned either way: under node there is no `__TAURI_INTERNALS__`,
// so an approved call fails at the shell instead. That difference is the
// assertion — it is how "the gate let it past" is observable without running
// `rm -rf` to find out.
{
	installUserTools([
		{ name: 'nuke', description: 'clean up', argv: ['rm', '-rf', '{dir}'], parameters: { dir: 'what' } },
	]);
	const events: AgentEvent[] = [];
	const gate = createGate();
	gate.begin('auto', (event) => void events.push(event));
	const [nuke] = userToolDefinitions(gate);

	const declined = nuke.execute('c1', { dir: 'build' }, undefined, undefined, {} as never);
	assert.equal(events.length, 1, 'the user was asked');
	assert.deepEqual(events[0], {
		kind: 'approval',
		id: 'c1',
		name: 'nuke',
		// The argv as an array, not joined into a command string.
		input: ['rm', '-rf', 'build'],
		reason: 'deletes files recursively',
	});
	gate.resolve(false);
	await assert.rejects(declined, /declined/);

	const approved = nuke.execute('c2', { dir: 'build' }, undefined, undefined, {} as never);
	gate.resolve(true);
	await assert.rejects(approved, /native shell/, 'approved gets past the gate');
}

// An ordinary tool is never asked about. A guard that fires on `grep` is one
// people learn to click through.
{
	installUserTools([GREP]);
	const events: AgentEvent[] = [];
	const gate = createGate();
	gate.begin('auto', (event) => void events.push(event));
	const [grep] = userToolDefinitions(gate);
	await assert.rejects(
		grep.execute('c1', { pattern: 'TODO' }, undefined, undefined, {} as never),
		/native shell/
	);
	assert.equal(events.length, 0, 'no question for ordinary work');
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
		{ ...GREP, parameters: { pattern: 'p', path: { description: 'where', type: 'date' } } },
		{ ...GREP, parameters: { pattern: 'p', path: { description: '' } } },
		{ ...GREP, parameters: { pattern: 'p', path: { description: 'where', required: 'no' } } },
		{ ...GREP, parameters: { pattern: 'p', path: { description: 'where', choices: [] } } },
		// A closed set of values only means anything for a string.
		{
			...GREP,
			parameters: { pattern: 'p', path: { description: 'where', type: 'number', choices: ['a'] } },
		},
		{ ...GREP, timeout: 0 },
		{ ...GREP, timeout: 'soon' },
		{ ...GREP, cwd: 42 },
		{ ...GREP, env: { KEY: 7 } },
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
