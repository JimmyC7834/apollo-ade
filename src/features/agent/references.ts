// Artifact references: the `artifact:` URL protocol, and who is allowed to
// write one.
//
// **The harness emits these links, not the model.** A model instructed to write
// `artifact:` URLs gets it wrong at some rate, and a broken artifact link is a
// dead click with no error surface and no way for the model to learn it failed.
// Event chips already carry structured tool results, so a reference is built
// from data rather than from prose — which is what `toolReferences` is. Nothing
// about this goes in the system prompt.
//
// No JSX here, so `references.check.ts` runs it under plain node. Rendering is
// `markdown.tsx`.

import { TOOL_ARTIFACTS, type ToolArtifactKind } from '../../artifacts.ts';
import type { ToolPart } from './transcript.ts';

/**
 * The protocol. `react-markdown` strips unknown ones through its default URL
 * transform, so this string is also what `markdown.tsx` has to let past — the
 * Shell Guide warns about that twice, which is usually a sign someone lost an
 * afternoon to it.
 */
export const ARTIFACT_SCHEME = 'artifact:';

/**
 * A link the harness wrote.
 *
 * `target` is what follows the scheme: either one of the four tool-artifact
 * kinds or a root-relative file path. Not an artifact *id*, because a tool
 * artifact's id already begins with `artifact:` and `artifact:artifact:terminal`
 * is nobody's idea of a URL.
 */
export interface ArtifactReference {
	readonly label: string;
	readonly target: string;
}

export function artifactHref(target: string): string {
	return `${ARTIFACT_SCHEME}${target}`;
}

/**
 * A path as the workspace names it, from a path as the model wrote it.
 *
 * pi's tools take "relative or absolute", so what arrives is whatever the model
 * typed. Only the cheap normalisations are done here — a leading `./`, a leading
 * separator, backslashes — because the root is deliberately not known on this
 * side. Anything this fails to normalise simply does not match a known file, and
 * `resolveArtifact` renders it as a broken reference rather than guessing.
 */
export function normalisePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Which artifact a href names, or undefined when it names nothing that exists.
 *
 * Undefined is the whole point: a reference to an artifact that is not there has
 * to fail *visibly*. Returning the target anyway would produce a link that opens
 * an empty surface, which is the silent failure this is written to prevent.
 */
export function resolveArtifact(href: string, files: readonly string[]): string | undefined {
	if (!href.startsWith(ARTIFACT_SCHEME)) {
		return undefined;
	}
	const target = href.slice(ARTIFACT_SCHEME.length);
	const kind = target as ToolArtifactKind;
	if (Object.hasOwn(TOOL_ARTIFACTS, kind)) {
		return TOOL_ARTIFACTS[kind].id;
	}
	// A file artifact is the file's own id, so it has to be a file the workspace
	// actually holds. `files` is the same list `@` completes over.
	return files.includes(target) ? target : undefined;
}

/** The `path` argument of a tool call, when it made one and it is a string. */
function toolPath(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const path = (input as { path?: unknown }).path;
	return typeof path === 'string' && path ? normalisePath(path) : undefined;
}

/**
 * The references a tool call earns, from what it did rather than from prose.
 *
 * Only a call that *finished* earns one. A reference from a failed write points
 * at a change that was never made, and a reference from a running one points at
 * an artifact whose content is still arriving — both are dead clicks of the kind
 * the harness-emits rule exists to avoid.
 */
export function toolReferences(part: ToolPart): readonly ArtifactReference[] {
	if (part.state !== 'done') {
		return [];
	}
	const path = toolPath(part.input);
	switch (part.name) {
		case 'bash':
			return [{ label: 'terminal', target: 'terminal' }];
		case 'read':
			return path ? [{ label: path, target: path }] : [];
		case 'write':
		case 'edit':
			return [
				...(path ? [{ label: path, target: path }] : []),
				{ label: 'working diff', target: 'changes' },
			];
		default:
			return [];
	}
}

/** Those references as the Markdown the transcript renders. */
export function referencesMarkdown(references: readonly ArtifactReference[]): string {
	return references
		.map((reference) => `[${reference.label}](${artifactHref(reference.target)})`)
		.join(' · ');
}

/**
 * A tool result at chip width: the last line that says anything.
 *
 * The last rather than the first, because a command's outcome is at the bottom
 * of its output and the top is usually its banner. Truncated with an ellipsis so
 * one long line cannot change the chip's width — the non-shifting rule, in the
 * one place a chip's content is not fixed.
 */
const CHIP_RESULT_CHARS = 72;

export function compactResult(output: string | undefined): string | undefined {
	const last = output
		?.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1);
	if (!last) {
		return undefined;
	}
	return last.length > CHIP_RESULT_CHARS ? `${last.slice(0, CHIP_RESULT_CHARS - 1)}…` : last;
}
