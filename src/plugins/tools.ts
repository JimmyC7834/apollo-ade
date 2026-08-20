// Tools a plugin declared — ticket 74.
//
// ## Two decisions, one act each
//
// Enabling a plugin says *run this code*. A profile naming its tool says *let
// the model call this*. They are separate acts because they answer separate
// questions, and keeping them separate is what lets a plugin's hooks and panel
// work while none of its tools are exposed to any model.
//
// So a plugin tool is **opt-in**, exactly like a user tool and for ticket 13's
// reason: a manifest on disk is not a trust decision. It joins `optIn` in
// `Capabilities` rather than getting a rule of its own.
//
// ## Names are refused, not namespaced
//
// A claimed *command* is namespaced (`hello/refresh`) and a claimed *tool* is
// not. That looks inconsistent and is not, because the two ids are read by
// different readers:
//
// - A command id is ours. Nobody types it, the palette shows a title and a
//   category, and a prefix costs a plugin author nothing.
// - A tool name is **prose the model reads**, in the same list as `read`,
//   `write` and `bash`. `hello_echo` is worse prompt material than `echo`, and
//   a namespace we applied silently is a name its author never wrote.
//
// So a collision is a refusal with a line in Problems, which is also the rule
// `userTools.ts` already applies to a manifest shadowing a built-in — one rule
// for tool names rather than two.

import { Type, type TSchema } from 'typebox';
import type { AgentHarnessTool } from '@earendil-works/pi-agent-core';

// Explicit extensions: this module is reachable from a check script, which node
// resolves without Vite's help.
import {
	parseParameter,
	schemaFor,
	userTools,
	RESERVED,
	type UserToolParameter,
} from '../agent/userTools.ts';
import { withDeadline } from './hooks.ts';

/** One tool a plugin declared, plus the plugin's own function to run it. */
export interface PluginTool {
	readonly pluginId: string;
	/** For the profile editor: a user granting trust deserves to see whose. */
	readonly pluginName: string;
	readonly name: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, UserToolParameter>>;
	readonly run: (args: Record<string, unknown>) => unknown;
}

/** Model-visible tool names travel in the request; the same rule as a manifest's. */
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Validate one `claim('tool')`, refusing rather than repairing.
 *
 * `taken` is what has been claimed **so far in this load**, passed in rather
 * than read off the store: the store still holds the previous load's tools
 * while a new one is running, and checking against those would refuse a plugin
 * for colliding with its own former self.
 *
 * Throws, because the caller turns a throw into "this plugin failed to load"
 * with the reason in Problems — the ticket's chosen collision behaviour.
 */
export function declareTool(
	plugin: { readonly id: string; readonly manifest: { readonly name: string } },
	spec: unknown,
	taken: readonly PluginTool[]
): PluginTool {
	const record = (spec ?? {}) as Record<string, unknown>;
	const name = typeof record.name === 'string' ? record.name.trim() : '';
	if (!NAME.test(name)) {
		throw new Error(`a tool claim needs a "name" that is a short identifier, saw ${JSON.stringify(record.name)}`);
	}
	if (typeof record.description !== 'string' || !record.description.trim()) {
		throw new Error(`the tool "${name}" needs a description — it is what the model reads to choose it`);
	}
	if (typeof record.run !== 'function') {
		throw new Error(`the tool "${name}" needs a run function`);
	}
	if (RESERVED.has(name)) {
		throw new Error(`the tool "${name}" is a built-in; a plugin may not shadow one`);
	}
	const clash = taken.find((tool) => tool.name === name);
	if (clash) {
		throw new Error(`the tool "${name}" is already claimed by ${clash.pluginName}`);
	}

	const parameters: Record<string, UserToolParameter> = {};
	for (const [key, raw] of Object.entries((record.parameters ?? {}) as Record<string, unknown>)) {
		const parsed = parseParameter(raw);
		if (typeof parsed === 'string') {
			throw new Error(`the tool "${name}" has a parameter "${key}" that ${parsed}`);
		}
		parameters[key] = parsed;
	}

	return {
		pluginId: plugin.id,
		pluginName: plugin.manifest.name,
		name,
		description: record.description,
		parameters,
		run: record.run as PluginTool['run'],
	};
}

/*
 * The store, shaped like `userTools.ts`'s and for the same reason: the provider
 * is built long before a plugin has been read, so the tool set has to be able
 * to arrive afterwards and say so.
 */

let declared: readonly PluginTool[] = [];
const listeners = new Set<() => void>();

export function pluginTools(): readonly PluginTool[] {
	return declared;
}

/** Watch for a load. Returns its disposer, following `harness.on`. */
export function onPluginToolsChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Replace the whole set.
 *
 * Whole, never merged: a plugin that has been disabled, has failed, or whose
 * folder has been deleted must lose its tools, and the load that discovered
 * that produces the complete list of what survives. This is what makes
 * "removing a plugin removes its tools from a live session" fall out rather
 * than need its own path.
 */
export function installPluginTools(tools: readonly PluginTool[]): void {
	declared = tools;
	for (const listener of listeners) {
		listener();
	}
}

/**
 * The third collision, which claim time cannot see.
 *
 * A *user* tool is declared in a profile file, read when a root is opened —
 * before or after a plugin depending on which folder it lives in. The harness
 * throws on a duplicate name, so a plugin tool that a user tool has taken is
 * dropped here rather than allowed to take the session down. Reported through
 * the host, which owns the Problems line, via a callback because the host
 * imports this module and not the other way round.
 */
let onDropped: (pluginId: string, reason: string) => void = () => {};

export function setOnToolDropped(report: (pluginId: string, reason: string) => void): void {
	onDropped = report;
}

/** What a plugin's tool returns, as the transcript will show it. */
function asText(result: unknown): string {
	if (typeof result === 'string') {
		return result;
	}
	if (result === undefined || result === null) {
		return '(no output)';
	}
	// A plugin is JavaScript, so a returned object is the common case rather than
	// a mistake. Stringifying is the only reading of it that survives a transport.
	return JSON.stringify(result, null, 2) ?? String(result);
}

/**
 * The pi tools for whatever is currently declared.
 *
 * `taken` is every name the harness already has — pi's built-ins and the user's
 * own tools — because the harness throws rather than resolving a duplicate.
 */
export function pluginToolDefinitions(
	taken: ReadonlySet<string> = new Set()
): AgentHarnessTool<{ env: unknown }>[] {
	const userToolNames = new Set(userTools().map((tool) => tool.name));
	const definitions: AgentHarnessTool<{ env: unknown }>[] = [];

	for (const tool of declared) {
		if (taken.has(tool.name) || userToolNames.has(tool.name)) {
			onDropped(
				tool.pluginId,
				`the tool "${tool.name}" is already declared outside this plugin, so it is not offered to the model`
			);
			continue;
		}
		const parameters = Type.Object(
			Object.fromEntries(
				Object.entries(tool.parameters).map(([key, spec]) => [key, schemaFor(spec)])
			)
		) as TSchema;

		definitions.push({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters,
			/*
			 * The plugin's own function, in our renderer, under ticket 73's
			 * deadline — the same one every other call into a plugin runs under,
			 * because a tool call happens inside a model's turn and a turn cannot
			 * wait forever.
			 *
			 * The gate is not consulted here and that is not an omission. It sits
			 * *below* the tool layer: everything this function can actually do to
			 * the machine it does by calling a Rust command, and those are gated,
			 * root-confined and deny-listed for the plugin exactly as they are for
			 * us. A second gate at this level would be asking about a wrapper.
			 */
			async execute(_callId, params) {
				const result = await withDeadline(
					Promise.resolve(tool.run(params as Record<string, unknown>)),
					`${tool.pluginId} running ${tool.name}`
				);
				const text = asText(result);
				return { content: [{ type: 'text', text }], details: undefined };
			},
		});
	}

	return definitions;
}
