// Run with `npm run check`.
//
// The two properties worth asserting are the two decisions
// (docs/wayfinder/pi-harness/tickets/04-profile-data-model.md): a tool *map*
// degrades correctly when the tool set moves underneath it, and a dangling
// reference refuses activation rather than quietly activating a lesser agent.

import assert from 'node:assert/strict';
import {
	activateProfile,
	activeProfile,
	activeToolNames,
	builtinProfiles,
	danglingReferences,
	listProfiles,
	onProfileChange,
	setCapabilities,
	type Profile,
} from './profile.ts';

const HAVE = { tools: ['read', 'write', 'edit', 'bash'], skills: [] };
setCapabilities(HAVE);

const plan = builtinProfiles().find((profile) => profile.name === 'plan') as Profile;

// The map's whole point: a tool nobody mentioned is on. A *list* would have
// excluded `read` and `bash` here by omission, which is the silent failure the
// shape was chosen against.
{
	assert.deepEqual(activeToolNames(plan), ['read', 'bash']);

	// A tool pi adds tomorrow falls through to its default rather than vanishing.
	const widened = { tools: [...HAVE.tools, 'glob'], skills: [] };
	assert.ok(activeToolNames(plan, widened).includes('glob'), 'a new tool is on by default');
}

// Disabling something that is gone is not a dangling reference. That is a
// profile outliving a tool, which the map shape exists to survive.
{
	const gone = { tools: ['read'], skills: [] };
	assert.deepEqual(danglingReferences(plan, gone), []);
	assert.deepEqual(activeToolNames(plan, gone), ['read']);

	// Enabling something that is gone *is* one, because the profile is now
	// claiming a capability the agent does not have.
	const claims: Profile = { ...plan, tools: { grep: true } };
	assert.deepEqual(danglingReferences(claims, gone), ['tool "grep"']);
	assert.deepEqual(danglingReferences({ ...plan, skills: ['grilling'] }, gone), [
		'skill "grilling"',
	]);
	assert.deepEqual(
		danglingReferences({ ...plan, model: { provider: 'openai' as never, id: 'x' } }, gone),
		['provider "openai"']
	);
}

// Switching, and refusing to. The previous profile survives a refusal — a
// session left on nothing would be worse than a session left where it was.
{
	assert.equal(activeProfile().name, 'auto', 'the gate default is the first run');

	const seen: string[] = [];
	const off = onProfileChange((profile) => seen.push(profile.name));

	assert.equal(activateProfile('plan').ok, true);
	assert.equal(activeProfile().name, 'plan');

	const missing = activateProfile('nonesuch');
	assert.equal(missing.ok, false);
	assert.match(missing.ok === false ? missing.reason : '', /No profile named/);
	assert.equal(activeProfile().name, 'plan', 'a refusal leaves the session where it was');

	assert.deepEqual(seen, ['plan'], 'only successful switches notify');

	off();
	activateProfile('auto');
	assert.deepEqual(seen, ['plan'], 'the disposer works');
}

// Built-ins exist and are distinguishable, because a profile feature whose
// profiles are all the same is a setting.
{
	const names = listProfiles().map((profile) => profile.name);
	assert.deepEqual(names, ['auto', 'careful', 'plan']);
	assert.equal(listProfiles()[1].gatePolicy, 'careful');
	assert.equal(listProfiles()[0].gatePolicy, 'auto');
}

console.log('agent/profile.check.ts: ok');
