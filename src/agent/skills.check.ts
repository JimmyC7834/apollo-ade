// Run with `npm run check`.
//
// Two rules and one message. The loading, parsing and formatting are all pi's
// and are not re-asserted here — what this file covers is the part pi's core
// deliberately leaves to the application: which directory wins, and which skills
// a profile permits.
//
// `reloadSkills` itself is not exercised: it needs an `ExecutionEnv` over real
// directories, which node's type stripping cannot supply and a fake one would
// only prove pi's loader still works. The pure halves it is built from are what
// is checked.

import assert from 'node:assert/strict';
import type { Skill } from '@earendil-works/pi-agent-core';
import { describeSkills, mergeSkills, permittedSkills } from './skills.ts';
import { listProfiles, type Profile } from './profile.ts';

const skill = (name: string, filePath: string): Skill => ({
	name,
	description: `does ${name}`,
	content: `# ${name}`,
	filePath,
});

const profileWith = (names: string[]): Profile => ({
	...(listProfiles()[0] as Profile),
	name: 'test',
	skills: names,
});

// Project wins, and the loser is named rather than dropped.
//
// This is the rule that disagrees with pi on purpose. pi's client takes the user
// directory first, because it does not trust a project until you approve it;
// here a skill does nothing until a profile names it, so trust is already spent
// and specificity is what is left — which is the rule both profiles files
// already follow.
{
	const merged = mergeSkills(
		[skill('grilling', '/.skills/grilling/SKILL.md'), skill('tdd', '/.skills/tdd/SKILL.md')],
		[skill('grilling', '/.agents/skills/grilling/SKILL.md')]
	);

	const grilling = merged.skills.find((each) => each.name === 'grilling');
	assert.equal(grilling?.filePath, '/.agents/skills/grilling/SKILL.md', 'the project one wins');
	assert.equal(merged.skills.length, 2, 'a collision replaces, it does not add');

	// A warning, not a refusal: both files exist and one of them works. But the
	// loser is now dead code on someone's disk, so both paths are in the message.
	assert.equal(merged.warnings.length, 1);
	assert.match(merged.warnings[0]!, /grilling/);
	assert.match(merged.warnings[0]!, /\.agents\/skills\/grilling/, 'says which one is used');
	assert.match(merged.warnings[0]!, /\.skills\/grilling/, 'and which is ignored');
}

// No collision, no warning. The normal case has to stay quiet, or `/skills`
// becomes a screen nobody reads.
{
	const merged = mergeSkills([skill('a', '/.skills/a/SKILL.md')], [skill('b', '/x/b/SKILL.md')]);
	assert.equal(merged.skills.length, 2);
	assert.deepEqual(merged.warnings, []);
}

// Default **off**. A skill on disk that no profile names is not available — the
// user-tools rule, not the `tools` map's. This is the whole trust story: a
// directory appearing on disk must not arm anything.
{
	const all = [skill('a', '/.skills/a/SKILL.md'), skill('b', '/.skills/b/SKILL.md')];

	assert.deepEqual(permittedSkills(all, profileWith([])), [], 'unmentioned is off');
	assert.deepEqual(
		permittedSkills(all, profileWith(['a'])).map((each) => each.name),
		['a']
	);
	// A name that matches nothing is silently absent here. It is not silent
	// overall: `danglingReferences` refuses to activate that profile and says so,
	// which is why this function does not need to report it twice.
	assert.deepEqual(permittedSkills(all, profileWith(['nope'])), []);
}

// The listing distinguishes on-disk from permitted, because that is the state a
// user who wrote a skill and saw nothing happen is actually in.
{
	const all = [skill('a', '/.skills/a/SKILL.md'), skill('b', '/.skills/b/SKILL.md')];
	const text = describeSkills(all, profileWith(['a']), [], 'C:/config/skills');

	assert.match(text, /● a/, 'permitted');
	assert.match(text, /○ b/, 'on disk, not permitted');
	assert.match(text, /must name a skill/, 'says how to enable one');
	assert.match(text, /C:\/config\/skills/, 'and where the global directory is');
	assert.match(text, /\.agents\/skills/, 'and the project one');

	// Warnings appear here and only here. `loadSkills` reports a bad name or an
	// unreadable file as a diagnostic, and nothing else in the app reads them.
	assert.doesNotMatch(text, /two skills/);
	assert.match(
		describeSkills(all, profileWith(['a']), ['two skills are named "a"']),
		/two skills are named "a"/
	);
}

// Nothing on disk is a sentence, not an empty list. The path is still printed,
// because "no skills" and "no skills *here*" send someone to different places.
{
	const text = describeSkills([], profileWith([]), [], 'C:/config/skills');
	assert.match(text, /No skills found/);
	assert.match(text, /C:\/config\/skills/);
	assert.match(text, /names none/, 'and the profile names none, which is why');
}

console.log('agent/skills.check.ts: ok');
