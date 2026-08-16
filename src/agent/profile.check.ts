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
	createSelection,
	danglingReferences,
	installProfiles,
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

// A profile file nobody has answered yet decides which profile you are on.
//
// **This block must stay above the first `activateProfile`.** "Nobody has
// chosen" is module state with no reset, and the whole point is that one
// deliberate switch ends it — so the un-chosen case is only reachable here.
{
	assert.equal(activeProfile().name, 'auto', 'the default before any file is read');

	// The reported failure: a file defining only `cheap` left the session on
	// built-in `auto`, which names no model, so every turn refused while the
	// file sat there looking unread.
	installProfiles([{ name: 'cheap', gatePolicy: 'ask' }]);
	assert.equal(activeProfile().name, 'cheap', 'the file decides');
	assert.equal(activeProfile().gatePolicy, 'ask', 'and it is the file definition');

	// The file's *first*, not its last, and not whichever the built-ins put first.
	installProfiles([{ name: 'cheap' }, { name: 'thorough' }]);
	assert.equal(activeProfile().name, 'cheap');

	// A file with nothing usable in it names no profiles, so there is nothing to
	// prefer — and `cheap` went with the file that defined it, since built-ins
	// are the only base. The default is what is left, not a dangling name.
	installProfiles([{ gatePolicy: 'ask' }]);
	assert.equal(activeProfile().name, 'auto');

	installProfiles([]);
}

// Switching, and refusing to. The previous profile survives a refusal — a
// session left on nothing would be worse than a session left where it was.
{
	assert.equal(activeProfile().name, 'auto', 'an empty file falls back to the built-in');

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
	assert.deepEqual(names, ['auto', 'ask', 'plan']);
	assert.equal(listProfiles()[1].gatePolicy, 'ask');
	assert.equal(listProfiles()[0].gatePolicy, 'auto');
}

// Installing from files. The three properties that make decision 4 true:
// built-ins are the base, a later file wins field by field, and a bad field
// costs its own profile nothing but itself.
{
	const problems = installProfiles([
		// Global: retunes a built-in and adds one of its own.
		{ name: 'plan', thinkingLevel: 'max' },
		{ name: 'cheap', model: { provider: 'deepseek', id: 'deepseek-chat' }, rtk: true },
		// Project: same name again, so this one wins — but only where it speaks.
		// `careful` is the pre-rename spelling of `ask`, deliberately left here:
		// hand-written profile files predate ticket 43 and must not silently land
		// on `auto`, which is the opposite of what the field says.
		{ name: 'cheap', gatePolicy: 'careful' },
	]);

	assert.deepEqual(problems, [], 'a well-formed file reports nothing');
	assert.deepEqual(listProfiles().map((profile) => profile.name), [
		'auto',
		'ask',
		'plan',
		'cheap',
	]);

	const plan = listProfiles().find((profile) => profile.name === 'plan') as Profile;
	assert.equal(plan.thinkingLevel, 'max', 'the file retuned it');
	assert.deepEqual(plan.tools, { write: false, edit: false }, 'and left the rest of the built-in');

	const cheap = listProfiles().find((profile) => profile.name === 'cheap') as Profile;
	assert.equal(cheap.gatePolicy, 'ask', 'the project file wins, and `careful` still means ask');
	assert.equal(cheap.rtk, true, 'and does not erase what it did not mention');
	assert.equal(cheap.model.id, 'deepseek-chat');
}

// A malformed field is dropped and named; the profile survives it. One typo
// costing seven good fields would be a worse answer than the typo.
{
	const problems = installProfiles([
		{ name: 'odd', thinkingLevel: 'ludicrous', rtk: 'yes', gatePolicy: 'bypass' },
		{ model: { id: 'nameless' } },
	]);

	const odd = listProfiles().find((profile) => profile.name === 'odd') as Profile;
	assert.equal(odd.gatePolicy, 'bypass', 'the good field applied');
	assert.equal(odd.thinkingLevel, 'medium', 'the bad one fell back to the base');
	assert.equal(odd.rtk, false);
	assert.equal(problems.length, 3, `named every drop: ${problems.join(' | ')}`);
	assert.ok(problems.some((problem) => problem.includes('thinkingLevel')));
	assert.ok(problems.some((problem) => problem.includes('"name"')));
}

// The tenth field, and the warning it produces. `subagent: true` with no
// description is dropped from the delegable list rather than offered blind —
// reported at `/reload`, because that is the moment the user can act on it.
{
	const problems = installProfiles([
		{ name: 'researcher', subagent: true, description: 'reads and reports' },
		{ name: 'half', subagent: true },
		{ name: 'odd', subagent: 'yes' },
	]);

	const researcher = listProfiles().find((one) => one.name === 'researcher') as Profile;
	assert.equal(researcher.subagent, true);
	assert.equal(researcher.description, 'reads and reports');

	assert.ok(
		problems.some((problem) => problem.includes('"half"') && problem.includes('description')),
		`warned about the undescribed one: ${problems.join(' | ')}`
	);
	assert.ok(problems.some((problem) => problem.includes('subagent')));

	// The profile still works for the user; it is only invisible to a parent
	// model. A warning is not a rejection.
	assert.ok(listProfiles().some((one) => one.name === 'half'));

	// And no built-in is delegable, because running unattended is the user's
	// decision to write down rather than ours to ship a default for.
	assert.deepEqual(
		builtinProfiles().filter((one) => one.subagent),
		[]
	);
	installProfiles([]);
}

// Reloading re-resolves the active profile by name, so editing the file you
// are running under takes effect without a switch.
{
	activateProfile('plan');
	const seen: string[] = [];
	const off = onProfileChange((profile) => seen.push(profile.name));

	installProfiles([{ name: 'plan', gatePolicy: 'ask' }]);
	assert.equal(activeProfile().name, 'plan', 'still on it');
	assert.equal(activeProfile().gatePolicy, 'ask', 'and it is the new definition');
	assert.deepEqual(seen, ['plan'], 'the harness is told');

	// A file that drops the profile you are on leaves you somewhere real
	// rather than on a profile that is no longer in the list.
	installProfiles([]);
	assert.equal(activeProfile().name, 'plan', 'built-ins still define it');
	off();
}

// A file cannot break the profile you are standing on. This is the one place a
// switch happens without anyone asking for one, so decision 2 has to be made
// here too rather than inherited from `activateProfile`.
{
	activateProfile('plan');
	const problems = installProfiles([{ name: 'plan', tools: { grep: true } }]);

	assert.equal(activeProfile().name, 'auto', 'fell back to a built-in');
	assert.ok(
		problems.some((problem) => problem.includes('tool "grep"')),
		`said why: ${problems.join(' | ')}`
	);
	installProfiles([]);
}

/*
 * **Two conversations, two profiles** — ticket 50. The catalogue is one per
 * window and the choice is one per session, so switching in one must not reach
 * the other, and a reload must reach both.
 */
{
	installProfiles([]);
	activateProfile('auto');
	const a = createSelection();
	const b = createSelection();
	let told = 0;
	const off = b.subscribe(() => {
		told += 1;
	});

	// Born on whatever the window opened with — captured, not followed. That is
	// what "chosen when it is created" means.
	assert.equal(a.current().name, activeProfile().name);
	assert.equal(b.current().name, activeProfile().name);

	/*
	 * **A session that never chose is still not the window's.** Focusing a
	 * conversation in another folder re-reads that folder's project profiles, and
	 * a selection that resolved to the module's `active` would follow — retuning a
	 * background session's model, tools and approval mode from another root.
	 */
	installProfiles([{ name: 'from-another-root', gatePolicy: 'bypass' }]);
	assert.equal(b.current().name, 'auto', 'still on the profile it was born with');
	assert.notEqual(b.current().gatePolicy, 'bypass', 'and on its approval mode, not that one');
	installProfiles([]);

	assert.ok(a.activate('plan').ok);
	assert.equal(a.current().name, 'plan');
	assert.equal(b.current().name, 'auto', 'the other conversation was not retuned');
	assert.equal(activeProfile().name, 'auto', 'nor was the window');

	// A profile that does not exist is refused, and the session stays where it is.
	const refused = a.activate('nonesuch');
	assert.equal(refused.ok, false);
	assert.equal(a.current().name, 'plan');

	/*
	 * A `/reload` redefines the profile a session is *running under*, and it has
	 * to reach it — which is why a selection holds a name rather than the object
	 * it resolved to when it was made.
	 */
	told = 0;
	installProfiles([{ name: 'plan', gatePolicy: 'ask' }]);
	assert.equal(a.current().gatePolicy, 'ask', 'the new definition, in the session');
	assert.ok(told > 0, 'and its harness is told');

	/*
	 * **A folder change is not a profile change.** Project profiles are read from
	 * the root, so focusing a conversation in another folder replaces them — and a
	 * session running under one that is no longer defined keeps it rather than
	 * being moved onto the window's default behind its own back.
	 */
	installProfiles([{ name: 'from-the-project', gatePolicy: 'ask' }]);
	assert.ok(a.activate('from-the-project').ok);
	installProfiles([]);
	assert.equal(a.current().name, 'from-the-project', 'still on what it chose');
	assert.equal(a.current().gatePolicy, 'ask', 'and still the definition it chose');

	off();
	activateProfile('auto');
}

console.log('agent/profile.check.ts: ok');
