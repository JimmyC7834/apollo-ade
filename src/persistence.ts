// Workbench persistence. Versioned from the start: a schema that changes
// without a version leaves users with state that cannot be read or safely
// discarded. Anything unrecognised is ignored, never migrated by guesswork.

import type { ThemeName } from './ui/theme';
import type { WorkspaceSelection } from './workspace';

const KEY = 'ade.workbench';
/*
 * 2 as of slice 40. The three regions this used to store geometry for no longer
 * exist, so a version-1 record describes a workbench that cannot be rebuilt —
 * which is exactly what the version is for. It is dropped, not migrated by
 * guesswork: there is no honest mapping from "panel 220px tall" to a dock.
 */
const VERSION = 2;

export interface PersistedEditor {
	readonly id: string;
	readonly name: string;
	/** Present only for a dirty editor: the unsaved text. */
	readonly content?: string;
}

export interface PersistedState {
	/** Fraction of the workbench the dock takes, already within its bounds. */
	readonly dockFraction: number;
	readonly dockCollapsed: boolean;
	/** Artifact ids currently pinned, in tab order. A dock you rebuild every
	 *  launch is a dock you stop using. */
	readonly pinned: readonly string[];
	readonly activeArtifactId?: string;
	readonly theme?: ThemeName;
	readonly workspace?: WorkspaceSelection;
	readonly editors: readonly PersistedEditor[];
	readonly activeEditorId?: string;
}

export interface PersistenceAdapter {
	load(): PersistedState | undefined;
	save(state: PersistedState): void;
}

/*
 * Persist stable user state, not active runtime resources: no live PTY
 * sessions, no in-flight streams, no modal visibility, no focus references.
 * Restoring any of those would recreate a shape without its substance.
 */
export function createPersistenceAdapter(): PersistenceAdapter {
	return {
		load() {
			try {
				const raw = localStorage.getItem(KEY);
				if (!raw) {
					return undefined;
				}
				const parsed: unknown = JSON.parse(raw);
				// An unknown or malformed version is dropped, not repaired.
				if (
					typeof parsed !== 'object' ||
					parsed === null ||
					(parsed as { version?: unknown }).version !== VERSION
				) {
					return undefined;
				}
				return (parsed as { state: PersistedState }).state;
			} catch {
				// Corrupt JSON, or localStorage unavailable. Start clean.
				return undefined;
			}
		},
		save(state) {
			try {
				localStorage.setItem(KEY, JSON.stringify({ version: VERSION, state }));
			} catch {
				// Quota or private mode. Losing layout state is not worth
				// interrupting the user over.
			}
		},
	};
}
