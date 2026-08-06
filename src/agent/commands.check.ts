// Run with `npm run check`. The matching rule is four lines and one of them is
// the reason `/skills` is not `/skill` with an argument — which is exactly the
// kind of thing that is right until someone reorders the list.

import assert from 'node:assert/strict';
import { parseCommand, SLASH_COMMANDS } from './commands.ts';

const name = (text: string) => parseCommand(text)?.command.name;

// The bare command, and the command with an argument.
assert.equal(name('/compact'), '/compact');
assert.equal(name('/skill grilling'), '/skill');
assert.deepEqual(parseCommand('/skill grilling this plan')?.args, 'grilling this plan');
assert.equal(parseCommand('/compact')?.args, '');

// The one that a prefix match gets wrong. `/skills` is its own command, and
// reading it as `/skill` with the argument "s" would run a skill named "s".
assert.equal(name('/skills'), '/skills');
assert.equal(name('/skill'), '/skill');

// No name may shadow a longer one, whatever order the list is in — the space is
// required, so this holds for every pair rather than for the pair we thought of.
for (const command of SLASH_COMMANDS) {
	for (const other of SLASH_COMMANDS) {
		if (other !== command) {
			assert.equal(
				name(other.name),
				other.name,
				`${other.name} must not be read as ${command.name}`
			);
		}
	}
}

// Ordinary prose is not a command, and neither is an unknown slash word — which
// goes to the model, because a typo is a sentence we have no right to reject.
assert.equal(parseCommand('read the file'), undefined);
assert.equal(parseCommand('/nonsense'), undefined);
assert.equal(parseCommand('/skillful thing'), undefined);

// Surrounding whitespace is the user's, not the parser's problem.
assert.equal(name('  /profile  '), '/profile');
assert.equal(parseCommand('/profile   careful  ')?.args, 'careful');

// Steering is the only one that means anything mid-turn, and the flag decides
// both refusals: every other command is refused while a turn runs rather than
// queued as prose, and this one is refused while idle rather than sent to the
// model. A second command earning the flag needs no change in the composer.
assert.deepEqual(
	SLASH_COMMANDS.filter((command) => command.whileRunning).map((command) => command.name),
	['/steer']
);

console.log('agent/commands.check.ts: ok');
