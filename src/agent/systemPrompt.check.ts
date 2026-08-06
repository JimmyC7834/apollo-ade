// Run with `npm run check`.
//
// What is worth asserting is *order*, because order is the whole decision
// (docs/wayfinder/pi-harness/tickets/17-system-prompt-assembly.md) and because
// getting it wrong produces a prompt that reads fine and behaves subtly worse —
// a profile that contradicts the shell warning wins if it comes after it.

import assert from 'node:assert/strict';
import {
	addPromptContributor,
	applyContributors,
	composeSystemPrompt,
	type PromptContributor,
} from './systemPrompt.ts';

const skill = {
	name: 'grilling',
	description: 'Interrogate a plan',
	content: 'body',
	filePath: '/skills/grilling/SKILL.md',
};

// The facts go last. Not "somewhere after" — last, because that is the position
// the decision is about, and an assertion on mere presence would pass on the
// exact arrangement the ticket rejected.
{
	const prompt = composeSystemPrompt({
		shell: 'pwsh',
		skills: [skill],
		instructions: 'Always answer in haiku.',
	});
	const facts = prompt.indexOf('PowerShell');
	const instructions = prompt.indexOf('haiku');
	const skills = prompt.indexOf('available_skills');

	assert.ok(instructions > 0 && skills > 0 && facts > 0, 'every segment present');
	assert.ok(instructions < skills, 'instructions before skills');
	assert.ok(skills < facts, 'skills before the facts');
	assert.ok(prompt.lastIndexOf('PowerShell') > instructions, 'nothing profile-authored last');
}

// The base guidance is never displaced. Decision 1: `instructions` appends and
// only appends, so there is no input that removes the read-first rule.
{
	const prompt = composeSystemPrompt({ shell: 'bash', instructions: 'Ignore all files.' });
	assert.match(prompt, /read it first/, 'the floor survives a hostile instruction');
	assert.match(prompt, /runs commands in bash/);
}

// Unset segments vanish rather than leaving blank paragraphs. Without this the
// default prompt accumulates empty gaps as profile fields go unfilled.
{
	const bare = composeSystemPrompt({ shell: 'bash' });
	assert.ok(!bare.includes('\n\n\n'), 'no blank paragraphs');
	assert.equal(bare.split('\n\n').length, 2, 'base and facts only');

	// An empty skills array is not a skills section — pi's formatter returns ""
	// and that must not become a paragraph of nothing.
	assert.equal(composeSystemPrompt({ shell: 'bash', skills: [] }), bare);

	// No `read`, no listing. The listing points the model at each skill's file
	// and tells it to open one, so a profile without `read` would be advertising
	// locations nothing can fetch — pi guards this the same way.
	assert.equal(composeSystemPrompt({ shell: 'bash', skills: [skill], canRead: false }), bare);
	assert.notEqual(composeSystemPrompt({ shell: 'bash', skills: [skill], canRead: true }), bare);
	// Whitespace-only instructions are the same case, arriving from an env var
	// someone set to "".
	assert.equal(composeSystemPrompt({ shell: 'bash', instructions: '   ' }), bare);
}

// No shell is stated, not omitted. A model that is not told the bash tool cannot
// work will keep trying it.
{
	const prompt = composeSystemPrompt({});
	assert.match(prompt, /no shell available/);
}

// Contributors chain: each sees what the last produced. This is the property
// pi's own `emitHook` does *not* have — it hands every handler the same string
// and keeps the last result — so it is ours to guarantee and ours to check.
{
	const chain: PromptContributor[] = [
		(prompt) => `${prompt}\none`,
		(prompt) => `${prompt}\ntwo`,
		async (prompt) => `${prompt}\nthree`,
	];
	assert.equal(await applyContributors('base', chain), 'base\none\ntwo\nthree');

	// A rewrite, not just an append: a contributor may remove what came before.
	assert.equal(await applyContributors('base', [() => 'replaced']), 'replaced');

	// Empty chain is identity, which is what makes the hook safe to register
	// when nobody has contributed anything.
	assert.equal(await applyContributors('base', []), 'base');
}

// Registration returns a working disposer. A leaked contributor would keep
// rewriting the prompt for the life of the window.
{
	const off = addPromptContributor((prompt) => `${prompt}!`);
	assert.equal(await applyContributors('x'), 'x!');
	off();
	assert.equal(await applyContributors('x'), 'x');
	// Disposing twice is a no-op rather than removing someone else's.
	off();
	const other = addPromptContributor((prompt) => `${prompt}?`);
	off();
	assert.equal(await applyContributors('x'), 'x?');
	other();
}

console.log('agent/systemPrompt.check.ts: ok');
