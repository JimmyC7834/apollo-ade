// Run with `npm run check`.
//
// What a plugin tool is allowed to be called, and what happens when a name is
// already spoken for. The collision rules are the whole reason ticket 74 exists
// as a ticket rather than as a line in 72.

import assert from 'node:assert/strict';

import { installUserTools } from '../agent/userTools.ts';
import { setOnToolDropped, declareTool, installPluginTools, pluginToolDefinitions, pluginTools, onPluginToolsChange, type PluginTool } from './tools.ts';

const hello = { id: 'global:hello', manifest: { name: 'Hello' } };
const other = { id: 'global:other', manifest: { name: 'Other' } };

const echo = {
	name: 'echo',
	description: 'say it back',
	parameters: { text: 'what to say' },
	run: ({ text }: Record<string, unknown>) => `you said ${String(text)}`,
};

// The happy path: a claim becomes a tool, and the short parameter form means
// what it means everywhere else — a required string.
const tool = declareTool(hello, echo, []);
assert.equal(tool.name, 'echo');
assert.equal(tool.pluginName, 'Hello');
assert.deepEqual(tool.parameters.text, {
	description: 'what to say',
	type: 'string',
	required: true,
});

// Malformed claims are refused whole. There is no half a tool.
for (const [spec, expected] of [
	[{ ...echo, name: '' }, /short identifier/],
	[{ ...echo, name: 'has a space' }, /short identifier/],
	[{ ...echo, description: '' }, /needs a description/],
	[{ ...echo, run: 'not a function' }, /needs a run function/],
	[{ ...echo, parameters: { text: '' } }, /needs a description/],
] as const) {
	assert.throws(() => declareTool(hello, spec, []), expected);
}

// **A plugin may not shadow a built-in.** The same rule a user manifest gets,
// for the same reason: the harness throws on a duplicate name.
assert.throws(() => declareTool(hello, { ...echo, name: 'bash' }, []), /may not shadow/);
assert.throws(() => declareTool(hello, { ...echo, name: 'browser' }, []), /may not shadow/);

// **Two plugins, one name: the second is refused, and the message names the
// first.** Refused rather than namespaced — see the header of `tools.ts`.
assert.throws(() => declareTool(other, echo, [tool]), /already claimed by Hello/);
// And the same plugin reclaiming a name it holds in the *previous* load is not
// a collision, because `taken` is only this load's.
assert.doesNotThrow(() => declareTool(hello, echo, []));

// --- what the model is handed -------------------------------------------------

let notified = 0;
onPluginToolsChange(() => {
	notified += 1;
});
installPluginTools([tool]);
assert.equal(notified, 1, 'installing tells the provider, which is what rebuilds the harness');
assert.equal(pluginTools().length, 1);

const [definition] = pluginToolDefinitions();
assert.equal(definition.name, 'echo');
assert.deepEqual(definition.parameters, {
	type: 'object',
	properties: { text: { type: 'string', description: 'what to say' } },
	required: ['text'],
});

const ran = await definition.execute!('call-1', { text: 'hi' }, undefined, undefined);
assert.deepEqual(ran.content, [{ type: 'text', text: 'you said hi' }]);

// A tool that returns an object rather than a string still reaches the transcript.
installPluginTools([{ ...tool, run: () => ({ ok: true }) } as PluginTool]);
const [asObject] = pluginToolDefinitions();
const printed = await asObject.execute!('call-2', {}, undefined, undefined);
assert.match((printed.content[0] as { text: string }).text, /"ok": true/);

// --- the third collision ------------------------------------------------------

/*
 * A *user* tool with the same name. Claim time cannot see this one: user tools
 * are read from a profile file on a different schedule. The tool is dropped
 * rather than offered, and the plugin is told so it can appear in Problems.
 */
let droppedFor = '';
let why = '';
setOnToolDropped((pluginId, reason) => {
	droppedFor = pluginId;
	why = reason;
});
installPluginTools([tool]);
installUserTools([
	{ name: 'echo', description: 'the user wrote one too', parameters: {}, argv: ['echo'] },
]);
assert.equal(pluginToolDefinitions().length, 0);
assert.equal(droppedFor, 'global:hello');
assert.match(why, /already declared outside this plugin/);

// The same for a built-in the harness already holds.
installUserTools([]);
assert.equal(pluginToolDefinitions(new Set(['echo'])).length, 0);

// --- removal ------------------------------------------------------------------

// Disabling a plugin is a reload with its tools absent, and nothing else.
installPluginTools([]);
assert.equal(pluginToolDefinitions().length, 0);

console.log('plugins/tools.check.ts: ok');
