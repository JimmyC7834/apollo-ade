// Run with `npm run check`.
//
// Two things are checked here, and the second one is the unusual one.
//
// 1. **Deny precedence.** A plugin may add a block and may never lift one.
// 2. **The trap is unreachable.** The obvious simplification — handing plugin
//    handlers straight to `harness.on` — deletes the permission gate with no
//    test failing, so the last section reads the source and fails if anyone
//    reintroduces the shape.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
	asBlock,
	dropPlugin,
	firstBlock,
	handlerCount,
	isPluginEvent,
	notifyPlugins,
	registerHandler,
	runToolCall,
	setOnBreach,
	withDeadline,
	PLUGIN_EVENTS,
	type ToolCallDecision,
	type ToolCallPayload,
} from './hooks.ts';

const call: ToolCallPayload = { callId: 'c1', tool: 'bash', input: { command: 'ls' } };
const allow = async (): Promise<ToolCallDecision | undefined> => undefined;
const deny = async (): Promise<ToolCallDecision | undefined> => ({
	block: true,
	reason: 'the gate said no',
});

/*
 * **Only an explicit block is an opinion.** Everything else a handler can return
 * — including the empty object that would have replaced the gate's decision
 * under pi's own `emitHook` — is discarded.
 */
assert.deepEqual(asBlock({ block: true, reason: 'no' }), { block: true, reason: 'no' });
assert.deepEqual(asBlock({ block: true }), { block: true });
assert.equal(asBlock({}), undefined);
assert.equal(asBlock({ block: false }), undefined);
assert.equal(asBlock({ block: 'true' }), undefined);
assert.equal(asBlock(undefined), undefined);
assert.equal(asBlock('go ahead'), undefined);
assert.equal(asBlock(null), undefined);

// The first objection is the one the user reads, so a second plugin cannot
// change the message the first one produced.
assert.deepEqual(firstBlock([{ block: true, reason: 'first' }, { block: true, reason: 'second' }]), {
	block: true,
	reason: 'first',
});
assert.equal(firstBlock([{}, undefined, { block: false }]), undefined);

// --- the chain, end to end -------------------------------------------------

// Nothing registered: the gate is the whole answer, in both directions.
assert.equal(await runToolCall(call, allow), undefined);
assert.deepEqual(await runToolCall(call, deny), { block: true, reason: 'the gate said no' });

// A plugin blocks a call the gate would have allowed.
registerHandler('global:strict', 'tool_call', () => ({ block: true, reason: 'not on my watch' }));
assert.deepEqual(await runToolCall(call, allow), { block: true, reason: 'not on my watch' });

/*
 * **And cannot lift one.** This is the assertion the whole file exists for: a
 * plugin returning an allow, or an empty object, or nothing at all, leaves a
 * blocked call blocked.
 */
dropPlugin('global:strict');
registerHandler('global:eager', 'tool_call', () => ({ block: false }));
registerHandler('global:quiet', 'tool_call', () => ({}));
registerHandler('global:silent', 'tool_call', () => undefined);
assert.deepEqual(await runToolCall(call, deny), { block: true, reason: 'the gate said no' });

// Two plugins both run, and a block from either wins — whichever it is.
registerHandler('global:late', 'tool_call', () => ({ block: true, reason: 'the last one objects' }));
assert.deepEqual(await runToolCall(call, allow), {
	block: true,
	reason: 'the last one objects',
});
for (const id of ['global:eager', 'global:quiet', 'global:silent', 'global:late']) {
	dropPlugin(id);
}
assert.equal(handlerCount(), 0);

// --- failure -----------------------------------------------------------------

// A handler that throws disables its plugin and leaves the call to the gate.
let disabled: string | undefined;
let why = '';
setOnBreach((id, reason) => {
	disabled = id;
	why = reason;
});
registerHandler('global:broken', 'tool_call', () => {
	throw new Error('boom');
});
assert.equal(await runToolCall(call, allow), undefined);
assert.equal(disabled, 'global:broken');
assert.equal(why, 'boom');
// Gone, not retried: a plugin that failed once is out for the session.
assert.equal(handlerCount('tool_call'), 0);

// The deadline. Short, because the point is the shape and not the wall clock.
disabled = undefined;
await assert.rejects(withDeadline(new Promise(() => {}), 'a hanging call', 5));
registerHandler('global:slow', 'tool_call', () => new Promise(() => {}));
const slow = runToolCall(call, allow, 5);
// It resolves rather than hanging, and the gate still decided.
assert.equal(await slow, undefined);
assert.equal(disabled, 'global:slow');
assert.match(why, /took longer than/);

// A notification never carries a decision back, whatever the handler returns.
registerHandler('global:noisy', 'turn_end', () => ({ block: true }));
assert.equal(await notifyPlugins('turn_end', { queued: 0 }), undefined);
dropPlugin('global:noisy');

// The event names are the promise, so a typo is a refusal rather than silence.
assert.ok(isPluginEvent('tool_call'));
assert.ok(!isPluginEvent('tool_calls'));
assert.ok(!isPluginEvent('before_provider_request'));
assert.equal(new Set(PLUGIN_EVENTS).size, PLUGIN_EVENTS.length);

// --- the trap ----------------------------------------------------------------

/*
 * **The check the ticket asked for.**
 *
 * The registry has no accessor that returns handlers, so there is nothing to
 * pass to `harness.on` — but a future edit could add one, or `provider.ts` could
 * grow a second `tool_call` registration beside the bridge. Both are read for
 * here, because both are silent: the gate would still be *called*, and its
 * answer would simply stop being used.
 */
const hooks = readFileSync(new URL('./hooks.ts', import.meta.url), 'utf8');
assert.ok(
	!/export\s+(function|const)\s+(handlers|handlersFor|registrationsFor)\b/.test(hooks),
	'hooks.ts must never export its handlers — that is the list `harness.on` would be given'
);

const provider = readFileSync(new URL('../agent/provider.ts', import.meta.url), 'utf8');
const imported = [...provider.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/plugins\/[^']+'/g)]
	.flatMap((match) => match[1].split(','))
	.map((name) => name.trim())
	.filter(Boolean);
assert.deepEqual(
	imported,
	['bridgePlugins'],
	'provider.ts may reach the plugin system through `bridgePlugins` and nothing else'
);

// Every `tool_call` registration in the provider goes through the bridge.
const registrations = [...provider.matchAll(/harness\.on\(\s*'tool_call'/g)];
assert.equal(
	registrations.length,
	2,
	'the only `tool_call` handlers in provider.ts are the two rtk rewrites; the gate is reached ' +
		'through bridgePlugins'
);
assert.equal(
	(provider.match(/bridgePlugins\(/g) ?? []).length,
	2,
	'both harnesses — the turn and the subagent — are bridged'
);

console.log('plugins/hooks.check.ts: ok');
