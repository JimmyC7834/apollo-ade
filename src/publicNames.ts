/*
 * The names a plugin is allowed to say.
 *
 * ## The rule
 *
 * **A rename in here is an `api` bump.** Everything this module names is part
 * of the compatibility promise described in
 * `docs/adr/0005-a-plugin-is-injected-and-the-api-is-a-promise.md`: a plugin
 * that hides the strip item called `terminal`, or puts its own command beside
 * `view.browser`, has imported nothing from us and is still depending on us.
 * Strings are the fragile surface of a plugin system, not code reach.
 *
 * ## Nothing is defined here
 *
 * Every name below is **re-exported** from where it already lives. A copy would
 * be a second definition that drifts, and drift in this particular file is
 * indistinguishable from a broken promise. `publicNames.check.ts` fails if a
 * name promised here is not one the workbench actually produces.
 *
 * ## What makes an id public
 *
 * Three things at once, and an id missing any of them is **unsupported** — a
 * plugin may still say it, and nothing stops it working today, but we will not
 * keep it working:
 *
 * 1. **We chose it.** It is written in a source file, not generated at runtime.
 * 2. **It is the same on every run and in every workspace.** Session ids,
 *    editor ids, file ids, browser tab ids (`browser:1`, `browser:2`) and
 *    language-server request ids are all identities rather than names, and none
 *    of them mean anything to a plugin the next time the app starts.
 * 3. **A plugin can act on it without our help.** It names a thing the plugin
 *    can show, hide or add beside.
 *
 * That is why this set is much smaller than "every id in the codebase", which
 * is what the answer was before this file existed.
 */

import { TOOL_ARTIFACTS, TOOL_ARTIFACT_IDS } from './artifacts.ts';
import { COMMAND_IDS, showArtifactCommandId } from './commands/commandRegistry.ts';
import { ICON_NAMES, type IconName } from './ui/glyphs.ts';

/**
 * The six artifacts that are not files — Terminal, Changes, Replace, Explorer,
 * Problems, References. `browser:n` is deliberately absent: it is an identity
 * handed out by a counter, and rule 2 above excludes it.
 */
export { TOOL_ARTIFACTS, TOOL_ARTIFACT_IDS };

/** Every command the workbench itself contributes, and the one derived id. */
export { COMMAND_IDS, showArtifactCommandId };

/**
 * The glyph vocabulary, because a claimed command names an icon and the set of
 * legal names is the whole of what a plugin needs to pick one.
 */
export { ICON_NAMES, type IconName };

/**
 * Tokens are promised **by scope, not by list**: every custom property
 * `src/tokens.css` defines is public, and nothing else is.
 *
 * The alternative — writing the names out here with a check that each exists in
 * the stylesheet — was rejected because it is the copy this file otherwise
 * refuses to make. `tokens.css` is already exactly one definition of exactly
 * this set, authored as a unit by the Shell Guide (ADR 0003), and a TypeScript
 * list beside it would be a second list to keep in agreement for no gain: the
 * check could only ever tell us the copy had gone stale.
 *
 * The cost is honest and worth naming: **the promise widens whenever a token is
 * added**, because scope is not a curated list. That is acceptable for tokens
 * specifically — they are values in a design system, and one appearing is not a
 * new API surface the way a command id is.
 *
 * There is no export for this. A plugin's `theme` is checked against the
 * stylesheet at the point it is applied, which is ticket 76.
 */
export const TOKEN_PROMISE =
	'every custom property defined in src/tokens.css, and nothing else';
