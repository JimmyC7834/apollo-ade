// Everything that is not topology: which providers are in use, what the
// commands do, what is persisted, and which feature renders into which slot.
// Geometry lives in WorkbenchLayout — this file never sets a width.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { createAgentProvider, loadProfileFiles, type StoredSession } from '../agent';
import { TOOL_ARTIFACTS, clampDock, dockSide, isToolArtifact } from '../artifacts';
import { createChangesProvider } from '../changes';
import { buildCommands } from '../commands/commandRegistry';
import { EditorDialog } from '../editor/EditorDialog';
import { isDirty, type EditorInput } from '../editor/EditorWorkbench';
import { basename, neighbourId } from '../ids';
import { AgentChat } from '../features/agent/AgentChat';
import type { TranscriptHit } from '../features/agent/transcript';
import { CommandCenter } from '../features/commandCenter/CommandCenter';
import type { FileOperations } from '../features/explorer/ExplorerTree';
import { isUnder, movedId } from '../features/explorer/fileOperations';
import { useLsp } from '../features/lsp/useLsp';
import { refuseReason, type Replacement } from '../features/search/replace';
import { SessionNavigator } from '../features/sessions/SessionNavigator';
import { createPersistenceAdapter, type PersistedState } from '../persistence';
import { LIVE_SESSION_ID, breadcrumb, buildGroups, type Session, type SessionStatus } from '../sessions';
import { createTerminalAdapter } from '../terminal';
import { Confirm, Prompt } from '../ui';
import { applyTheme, type ThemeName } from '../ui/theme';
import {
	createWorkspaceProvider,
	type WorkspaceEntry,
	type WorkspaceSelection,
} from '../workspace';
import { AccessibilityHelp } from './AccessibilityHelp';
import { ArtifactView, artifactRef } from './ArtifactView';
import { ConfirmDiscard } from './ConfirmDiscard';
import { PinnedWorkbench } from './PinnedWorkbench';
import { Titlebar, type AdeMenuAction } from './Titlebar';
import { Toasts, type Toast } from './Toasts';
import { WorkbenchLayout } from './WorkbenchLayout';
import { useWindowControls } from './useWindowControls';

/** The dock's default share of the workbench, and what it opens with. */
const DEFAULT_DOCK_FRACTION = 0.34;

/**
 * Which way the workbench splits, from the window as it is now.
 *
 * A subscription rather than a `useState` plus a listener: the value is not
 * this component's to own, it is the window's, and `useSyncExternalStore` is
 * the hook that says so.
 */
function useDockSide() {
	return useSyncExternalStore(
		(listener) => {
			window.addEventListener('resize', listener);
			return () => window.removeEventListener('resize', listener);
		},
		() => dockSide(window.innerWidth, window.innerHeight)
	);
}

// Rust rejections arrive as strings, not Errors, so both shapes are read.
function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Which workspace file an editor is showing.
 *
 * Diffs live in their own id space (`diff:<path>`) so a file and its diff can be
 * open at once. That makes an editor id the wrong thing to compare against a
 * path the explorer just renamed or deleted, and this is the translation.
 */
function fileIdOf(input: EditorInput): string {
	return input.kind === 'diff' ? input.id.slice('diff:'.length) : input.id;
}

export function WorkbenchController() {
	const controls = useWindowControls();

	// Read once, synchronously: layout that arrives after the first paint
	// shows the user the default and then snaps, which reads as a glitch.
	const persistence = useMemo(() => createPersistenceAdapter(), []);
	const restored = useMemo(() => persistence.load(), [persistence]);

	const side = useDockSide();

	/*
	 * The dock. `pinned` holds artifact ids in tab order — tool artifacts from
	 * `TOOL_ARTIFACTS` and file ids side by side, because the dock does not care
	 * which it is showing. Nothing is pinned by default: an empty dock is not
	 * rendered at all, so a first launch is chat and nothing else, which is what
	 * "chat is the primary workspace" means.
	 */
	const [dockFraction, setDockFraction] = useState(
		() => restored?.dockFraction ?? DEFAULT_DOCK_FRACTION
	);
	const [dockCollapsed, setDockCollapsed] = useState(restored?.dockCollapsed ?? false);
	const [pinned, setPinned] = useState<readonly string[]>(restored?.pinned ?? []);
	const [activeArtifactId, setActiveArtifactId] = useState<string | undefined>(
		restored?.activeArtifactId
	);

	/*
	 * The theme is applied before the first paint rather than from an effect:
	 * an effect runs after the commit, which would show every user one frame of
	 * the wrong theme on every launch. `applyTheme` also redefines Monaco's
	 * theme, which is global and keyed by name, so this is the only call site.
	 */
	const [theme, setTheme] = useState<ThemeName>(restored?.theme ?? 'dark');
	useMemo(() => applyTheme(theme), [theme]);

	const [helpOpen, setHelpOpen] = useState(false);
	const [branch, setBranch] = useState<string | undefined>(undefined);
	const [recents, setRecents] = useState<readonly WorkspaceSelection[]>([]);
	/** The live session, as `AgentChat` reports it. */
	const [session, setSession] = useState<{
		readonly status: SessionStatus;
		readonly name: string | undefined;
	}>({ status: 'idle', name: undefined });
	/** This workspace's stored conversations. Empty until they are read. */
	const [stored, setStored] = useState<readonly StoredSession[]>([]);
	const [commandCenterOpen, setCommandCenterOpen] = useState(false);
	/*
	 * Notifications — ticket 44. Toasts are a list rather than one slot because
	 * two things can finish while you are away, and the second replacing the first
	 * would make the mechanism unreliable exactly when it is needed.
	 */
	const [toasts, setToasts] = useState<readonly Toast[]>([]);
	/**
	 * Whether the live session has something you have not seen.
	 *
	 * **Not a lifecycle status**, which is the whole point of `Session.unread`: a
	 * session can be done and read, or done and unread, and folding the two loses
	 * the second. Set when a turn ends while the window is not focused; cleared
	 * when it comes back, because that is when you saw it.
	 */
	const [unread, setUnread] = useState(false);
	/** Search the live transcript. Handed over by the chat; see `onTranscript`. */
	const transcriptSearch = useRef<(term: string) => readonly TranscriptHit[]>(() => []);
	const searchTranscript = useCallback((term: string) => transcriptSearch.current(term), []);
	/*
	 * The editor is a transient surface over the workbench, not a region and not
	 * layout: it is never persisted, so a session always reopens on Agent Chat
	 * with the editor closed. The tabs behind it are persisted as they always
	 * were, so dismissing loses nothing.
	 */
	const [editorOpen, setEditorOpen] = useState(false);
	/*
	 * Announcements carry a sequence number because a live region only reacts to
	 * a mutation: two runs that both end in "Agent finished" would set identical
	 * text, and the second would be announced to nobody. The counter replaces the
	 * node instead of rewriting it.
	 */
	const [announcement, setAnnouncement] = useState({ seq: 0, message: '' });
	const announce = useCallback(
		(message: string) => setAnnouncement((current) => ({ seq: current.seq + 1, message })),
		[]
	);

	/**
	 * Raise a toast. Also announced, because a toast is visual and the live region
	 * is the only channel that is not.
	 */
	const notify = useCallback(
		(message: string, action?: Toast['action']) => {
			setToasts((current) => [...current, { id: Date.now() + current.length, message, action }]);
			announce(message);
		},
		[announce]
	);

	/*
	 * A finished turn is worth a toast **only when you are not here to see it**.
	 * With the window focused the transcript already said so, and a notice for
	 * something on screen is the kind of noise that teaches people to ignore the
	 * mechanism. The same condition sets unread.
	 */
	/*
	 * The previous status, in a ref rather than read inside the `setSession`
	 * updater. A state updater has to be pure — StrictMode calls it twice to prove
	 * it — and raising a toast from inside one raised two.
	 */
	const lastStatus = useRef<SessionStatus>('idle');
	const onSessionState = useCallback(
		(next: { readonly status: SessionStatus; readonly name: string | undefined }) => {
			setSession(next);
			if (
				lastStatus.current !== next.status &&
				(next.status === 'done' || next.status === 'waiting') &&
				!document.hasFocus()
			) {
				setUnread(true);
				notify(
					next.status === 'waiting'
						? 'The agent is waiting for your answer.'
						: 'The agent finished.'
				);
			}
			lastStatus.current = next.status;
		},
		[notify]
	);

	// Coming back is when you saw it. Nothing else clears unread, because nothing
	// else means you looked.
	useEffect(() => {
		const seen = () => setUnread(false);
		window.addEventListener('focus', seen);
		return () => window.removeEventListener('focus', seen);
	}, []);

	const provider = useMemo(() => createWorkspaceProvider(), []);
	const agentProvider = useMemo(() => createAgentProvider(), []);
	const changesProvider = useMemo(() => createChangesProvider(), []);
	const terminalAdapter = useMemo(() => createTerminalAdapter(), []);
	const [selection, setSelection] = useState<WorkspaceSelection | undefined>(undefined);
	const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
	const [inputs, setInputs] = useState<readonly EditorInput[]>([]);
	const [activeEditorId, setActiveEditorId] = useState<string | undefined>(undefined);
	const [pendingCloseId, setPendingCloseId] = useState<string | undefined>(undefined);
	/*
	 * The save effect below must not run before the async restore has put the
	 * restored state back: on mount `selection` is undefined and `inputs` is
	 * empty, and writing that out erases the record being restored.
	 */
	const [hydrated, setHydrated] = useState(false);
	/*
	 * A root that could not be restored — a disconnected drive, or a browser
	 * handle that cannot be re-granted without a gesture. The session carries on
	 * without it, but its record is held here and written back untouched, since
	 * it may well be reachable next launch and overwriting it forgets the folder
	 * and its editors permanently. Superseded as soon as a root is chosen.
	 */
	const [unrestored, setUnrestored] = useState<PersistedState | undefined>(undefined);

	/*
	 * Restore the workspace, then the editors that lived in it. The order
	 * matters: reading a file needs the root to be selected first. A file that
	 * has since moved or been deleted is dropped rather than failing the whole
	 * restore, and a dirty editor keeps its unsaved text while its `saved`
	 * baseline comes from what is on disk now.
	 */
	useEffect(() => {
		let cancelled = false;
		async function start(): Promise<void> {
			// Whether a folder can be *chosen* says nothing about whether one is
			// already available: the browser can now do both.
			let workspace = provider.defaultWorkspace;
			if (restored?.workspace) {
				try {
					workspace = await provider.restoreWorkspace();
				} catch {
					// Gone, or a browser handle that cannot be re-granted
					// without a gesture. Fall back to whatever exists by
					// default — nothing natively, the fixture in the browser —
					// and keep the record rather than writing over it.
					setUnrestored(restored);
				}
			}
			if (cancelled) {
				return;
			}
			// Whatever the session has is now the truth, including having no
			// root at all. Saving before this point writes an empty state over
			// the record being restored.
			setHydrated(true);
			if (!workspace) {
				return;
			}
			/*
			 * Profiles, now that there is a root to read the project file from.
			 * Never fails: a missing file is the normal state and a malformed one
			 * is reported here rather than costing anyone their editors. The
			 * announcement is the only channel — a profile that silently did not
			 * load looks exactly like a profile that did nothing.
			 *
			 * **Before `setSelection`, not after, and that ordering is load-bearing
			 * now.** Everything keyed on `selection` runs once it is set — the
			 * session list is, and the model a profile names is what decides which
			 * sessions there are to list. This reads through Rust's root, which
			 * `restoreWorkspace` has already set, so it never needed React's copy
			 * of it; being second was incidental and is what left effects racing a
			 * profile that had not arrived.
			 */
			const loaded = await loadProfileFiles();
			if (cancelled) {
				return;
			}
			setSelection(workspace);
			if (loaded.problems.length > 0) {
				// One announcement, not one per problem: a live region only
				// reacts to the latest mutation, so announcing in a loop would
				// leave a screen-reader user hearing the last problem and no
				// hint that there were others.
				announce(`Profiles: ${loaded.problems.join('. ')}`);
			}

			const reopened: EditorInput[] = [];
			for (const editor of restored?.editors ?? []) {
				try {
					const file = await provider.readFile(editor.id);
					reopened.push({
						kind: 'source',
						id: file.id,
						name: file.name,
						content: editor.content ?? file.content,
						saved: file.content,
					});
				} catch {
					// Gone since last session.
				}
			}
			if (cancelled) {
				return;
			}
			setInputs(reopened);
			setActiveEditorId(
				reopened.some((input) => input.id === restored?.activeEditorId)
					? restored?.activeEditorId
					: reopened[0]?.id
			);
		}
		void start();
		return () => {
			cancelled = true;
		};
	}, [announce, provider, restored]);

	// The tree belongs to the selected root, so it is reloaded with it.
	useEffect(() => {
		if (!selection) {
			setEntries([]);
			return;
		}
		// The change set belongs to the root too: until one is chosen there is
		// no repository to ask.
		changesProvider.refresh();
		let cancelled = false;
		void provider.getTree().then((tree) => {
			if (!cancelled) {
				setEntries(tree);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [changesProvider, provider, selection]);

	const dirty = inputs.some(isDirty);

	/*
	 * The paths `@` completes over — ticket 27. The tree the explorer already
	 * draws, filtered to files, so a mention can only name something that exists
	 * and the chat never needs a workspace provider of its own. It reloads with
	 * the root, which is what makes the list right after a folder switch.
	 */
	const fileIds = useMemo(
		() => entries.filter((entry) => entry.kind === 'file').map((entry) => entry.id),
		[entries]
	);

	// Closing the last tab leaves the dialog with nothing to show, so it is
	// dismissed rather than left sitting empty over the agent.
	useEffect(() => {
		if (inputs.length === 0) {
			setEditorOpen(false);
		}
	}, [inputs.length]);

	const openFolder = useCallback(async () => {
		// Switching roots discards every editor, so the guard lives here and not
		// only on the controls that offer it. Callers may be disabled; this is
		// what makes the operation itself safe.
		if (dirty) {
			return;
		}
		const chosen = await provider.chooseWorkspace();
		if (!chosen) {
			return;
		}
		// Editor ids are relative to the old root, so they cannot survive.
		// Switching is blocked while anything is dirty, so nothing is lost.
		setInputs([]);
		setActiveEditorId(undefined);
		setSelection(chosen);
		// A deliberate choice supersedes a root that failed to restore: the
		// user has answered the question the held record was waiting on.
		setUnrestored(undefined);
	}, [dirty, provider]);

	const openFile = useCallback(
		async (id: string, revealLine?: number) => {
			// Already open: keep any unsaved edits, but honour a new target
			// line — that is the whole point of opening a search result.
			if (inputs.some((input) => input.id === id)) {
				setActiveEditorId(id);
				setEditorOpen(true);
				if (revealLine !== undefined) {
					setInputs((current) =>
						current.map((input) =>
							input.id === id && input.kind === 'source' ? { ...input, revealLine } : input
						)
					);
				}
				return;
			}
			// Same rule as openDiff: a file the workspace refuses is reported,
			// not silently nothing-happened.
			let file;
			try {
				file = await provider.readFile(id);
			} catch (error) {
				announce(`Could not open ${id}. ${reason(error)}`);
				return;
			}
			setInputs((current) =>
				current.some((input) => input.id === id)
					? current
					: [
							...current,
							{
								kind: 'source',
								id: file.id,
								name: file.name,
								content: file.content,
								saved: file.content,
								revealLine,
							},
						]
			);
			/*
			 * Activated and raised only once the file is in state, and in that
			 * order. Selecting an id the inputs do not contain yet leaves a
			 * render with no active input at all, which unmounts the editor and
			 * remounts it a moment later — throwing away the Monaco instance,
			 * its models, and any focus just placed in it.
			 */
			setActiveEditorId(id);
			setEditorOpen(true);
		},
		[announce, inputs, provider]
	);

	// Diffs share the editor's tab strip but live in their own id space, so a
	// file and its diff can be open at the same time without colliding.
	const openDiff = useCallback(
		async (id: string) => {
			const diffId = `diff:${id}`;
			/*
			 * A refused diff has to say so. Rust reports a file it will not read
			 * — outside the workspace, a symlink, over the size cap — as an
			 * error rather than as empty content, precisely so this does not
			 * render as a diff deleting the whole file. Swallowing it here would
			 * put the silence back one layer down.
			 */
			let diff;
			try {
				diff = await changesProvider.getDiff(id);
			} catch (error) {
				announce(`Could not open the diff for ${id}. ${reason(error)}`);
				return;
			}
			const input: EditorInput = {
				kind: 'diff',
				id: diffId,
				name: diff.name,
				original: diff.original,
				modified: diff.modified,
			};
			// A diff has no unsaved state, so re-opening one that is already
			// there replaces it: that is how a stale diff picks up a save.
			setInputs((current) =>
				current.some((existing) => existing.id === diffId)
					? current.map((existing) => (existing.id === diffId ? input : existing))
					: [...current, input]
			);
			// Same ordering rule as openFile: never select an id the inputs do
			// not have yet.
			setActiveEditorId(diffId);
			setEditorOpen(true);
		},
		[announce, changesProvider]
	);

	/*
	 * Ticket 30's preview: a planned replacement, as a diff, in the editor that
	 * already renders diffs.
	 *
	 * Its own id space — `replace:` beside `diff:` — so a file, its git diff and
	 * its proposed replacement can all be open at once without one replacing
	 * another. Nothing is written by opening it; the tab is a picture.
	 */
	const openReplacePreview = useCallback((plan: Replacement) => {
		const input: EditorInput = {
			kind: 'diff',
			id: `replace:${plan.id}`,
			name: plan.name,
			original: plan.original,
			modified: plan.modified,
		};
		setInputs((current) =>
			current.some((existing) => existing.id === input.id)
				? current.map((existing) => (existing.id === input.id ? input : existing))
				: [...current, input]
		);
		setActiveEditorId(input.id);
		setEditorOpen(true);
	}, []);

	/**
	 * Write the planned replacements, and report what was refused.
	 *
	 * Here rather than in `SearchView` because this is the only thing that knows
	 * which files are open and which are dirty, and both halves of the safety
	 * rule are about that. Sequential rather than parallel: a report that says
	 * which files were skipped is worth more than a faster write, and the writes
	 * are a handful.
	 *
	 * **A refusal is never a partial write.** Each file is re-read, checked and
	 * written on its own, so a file that fails leaves the others correct and is
	 * named in the report rather than rolling anything back — there is nothing
	 * to roll back to that the git checkpoint does not already hold.
	 */
	const applyReplacements = useCallback(
		async (plans: readonly Replacement[]): Promise<string> => {
			const refused: string[] = [];
			const written: string[] = [];
			for (const plan of plans) {
				const open = inputs.find((input) => input.id === plan.id);
				let current: string | undefined;
				try {
					current = (await provider.readFile(plan.id)).content;
				} catch {
					current = undefined;
				}
				const refusal = refuseReason(plan, current, open !== undefined && isDirty(open));
				if (refusal) {
					refused.push(refusal);
					continue;
				}
				try {
					await provider.writeFile(plan.id, plan.modified);
				} catch (error) {
					refused.push(`${plan.id}: ${reason(error)}`);
					continue;
				}
				written.push(plan.id);
				// An open editor showing the old text would be a second copy of the
				// file that disagrees with disk — and saving it would undo the
				// replacement. It is clean, so both sides move together and it stays
				// clean.
				setInputs((currentInputs) =>
					currentInputs.map((input) =>
						input.id === plan.id && input.kind === 'source'
							? { ...input, content: plan.modified, saved: plan.modified }
							: input
					)
				);
			}
			if (written.length > 0) {
				changesProvider.refresh();
			}
			const report = [
				written.length === 0
					? 'Nothing was written.'
					: `Replaced in ${written.length} file${written.length === 1 ? '' : 's'}.`,
				...refused,
			].join(' ');
			announce(report);
			return report;
		},
		[announce, changesProvider, inputs, provider]
	);

	const editFile = useCallback((id: string, content: string) => {
		setInputs((current) =>
			current.map((input) =>
				input.id === id && input.kind === 'source' ? { ...input, content } : input
			)
		);
	}, []);

	const saveFile = useCallback(
		async (id: string) => {
			const input = inputs.find((item) => item.id === id);
			if (!input || input.kind !== 'source' || !isDirty(input)) {
				return;
			}
			const { content } = input;
			await provider.writeFile(id, content);
			// Mark the written text as the new baseline, not the text as it is
			// now — the user may have typed more while the write was in flight.
			setInputs((current) =>
				current.map((item) =>
					item.id === id && item.kind === 'source' ? { ...item, saved: content } : item
				)
			);
			// The working tree just moved and nothing watches the filesystem, so
			// the Changes view is told directly.
			changesProvider.refresh();
		},
		[changesProvider, inputs, provider]
	);

	const forceCloseEditor = useCallback((id: string) => {
		setInputs((current) => {
			// Closing the active tab selects its neighbour rather than nothing.
			setActiveEditorId((active) => (active === id ? neighbourId(current, id) : active));
			return current.filter((input) => input.id !== id);
		});
	}, []);

	/**
	 * Close every editor `gone` picks out, keeping a sensible selection.
	 *
	 * The plural of `forceCloseEditor`, needed because deleting a *folder* takes
	 * an unknown number of tabs at once and closing them one by one would pick a
	 * neighbour that is itself about to close.
	 */
	const closeEditors = useCallback((gone: (input: EditorInput) => boolean) => {
		setInputs((current) => {
			const kept = current.filter((input) => !gone(input));
			setActiveEditorId((active) =>
				active && kept.some((input) => input.id === active) ? active : kept[0]?.id
			);
			return kept;
		});
	}, []);

	const refreshTree = useCallback(async () => {
		setEntries(await provider.getTree());
	}, [provider]);

	/**
	 * Ticket 29's operations, wired to everything they knock over.
	 *
	 * Undefined without a root, which is what makes the explorer's context menu
	 * absent rather than present-and-failing. None of these rejects: a refusal is
	 * announced here, because this is the side that owns the live region, and a
	 * dialog that stayed open waiting for one would be a second place to decide
	 * what went wrong.
	 */
	const fileOperations = useMemo<FileOperations | undefined>(() => {
		if (!selection) {
			return undefined;
		}
		const failed = (what: string, error: unknown) => {
			announce(`Could not ${what}. ${reason(error)}`);
		};
		return {
			deletesToTrash: provider.deletesToTrash,
			async create(id, kind) {
				try {
					await (kind === 'folder' ? provider.createFolder(id) : provider.createFile(id));
				} catch (error) {
					failed(`create ${id}`, error);
					return;
				}
				await refreshTree();
				announce(`Created ${id}.`);
				if (kind === 'file') {
					// Creating a file and not opening it is asking the user to go
					// and find the thing they just named.
					await openFile(id);
				}
			},
			async rename(from, to) {
				try {
					await provider.rename(from, to);
				} catch (error) {
					failed(`rename ${from}`, error);
					return;
				}
				/*
				 * Editors follow the file. A tab left pointing at the old id would
				 * save to a path that no longer exists — and `write_file` creates
				 * nothing, so it would fail on every save from then on.
				 */
				setInputs((current) =>
					current.map((input) => {
						const moved = input.kind === 'source' ? movedId(input.id, from, to) : undefined;
						return moved ? { ...input, id: moved, name: basename(moved) } : input;
					})
				);
				setActiveEditorId((active) => (active ? (movedId(active, from, to) ?? active) : active));
				// A diff is a snapshot against a path git no longer has in the
				// working tree, so it is closed rather than moved.
				closeEditors((input) => input.kind === 'diff' && isUnder(fileIdOf(input), from));
				await refreshTree();
				changesProvider.refresh();
				announce(`Renamed ${from} to ${to}.`);
			},
			async plan(id) {
				try {
					const plan = await provider.deletePlan(id);
					return {
						...plan,
						// Only this side knows what is open, and an unsaved buffer is
						// the one part of a delete the trash cannot give back.
						unsaved: inputs.filter((input) => isDirty(input) && isUnder(fileIdOf(input), id))
							.length,
					};
				} catch (error) {
					failed(`work out what deleting ${id} would take`, error);
					return undefined;
				}
			},
			async remove(id) {
				try {
					await provider.deleteEntry(id);
				} catch (error) {
					failed(`delete ${id}`, error);
					return;
				}
				// The ticket's rule: no tab left writing to nothing.
				closeEditors((input) => isUnder(fileIdOf(input), id));
				await refreshTree();
				changesProvider.refresh();
				announce(`Deleted ${id}.${provider.deletesToTrash ? ' It is in the trash.' : ''}`);
			},
		};
	}, [announce, changesProvider, closeEditors, inputs, openFile, provider, refreshTree, selection]);

	const closeEditor = useCallback(
		(id: string) => {
			const input = inputs.find((item) => item.id === id);
			if (input && isDirty(input)) {
				setPendingCloseId(id);
				return;
			}
			forceCloseEditor(id);
		},
		[inputs, forceCloseEditor]
	);

	/*
	 * Persist stable user state on every change. Dirty text is written out;
	 * clean editors keep only their identity, since the file itself is the
	 * record. Live terminals, modal visibility, and focus are deliberately
	 * absent — restoring their shape without their substance is worse than
	 * starting fresh.
	 */
	useEffect(() => {
		if (!hydrated) {
			return;
		}
		const state: PersistedState = {
			dockFraction,
			dockCollapsed,
			pinned,
			activeArtifactId,
			theme,
			// Geometry always belongs to this session. The workspace and its
			// editors still belong to the last one until the root it named is
			// either restored or replaced.
			...(unrestored
				? {
						workspace: unrestored.workspace,
						editors: unrestored.editors,
						activeEditorId: unrestored.activeEditorId,
					}
				: {
						workspace: selection,
						editors: inputs
							.filter((input) => input.kind === 'source')
							.map((input) => ({
								id: input.id,
								name: input.name,
								...(isDirty(input) ? { content: input.content } : {}),
							})),
						activeEditorId,
					}),
		};
		persistence.save(state);
	}, [
		hydrated,
		unrestored,
		persistence,
		dockFraction,
		dockCollapsed,
		pinned,
		activeArtifactId,
		theme,
		selection,
		inputs,
		activeEditorId,
	]);

	/**
	 * Pin an artifact, or raise it if it is already pinned.
	 *
	 * Also un-collapses. An artifact the user just asked for that stays behind a
	 * collapsed strip looks exactly like the command did nothing — the same rule
	 * the old `showPrimaryView` followed for a hidden sidebar.
	 */
	const showArtifact = useCallback((id: string) => {
		setPinned((current) => (current.includes(id) ? current : [...current, id]));
		setActiveArtifactId(id);
		setDockCollapsed(false);
	}, []);

	/*
	 * The language server — tickets 33, 34 and 35.
	 *
	 * One hook, because everything it needs is already here and nowhere else:
	 * the workspace root it is initialised against, the open files it has to be
	 * told about, and `openFile`, which is where a definition or a reference
	 * ends up. What it hands back is what has to be rendered — the status line
	 * in the Problems panel, the References artifact's contents, and the rename
	 * prompt.
	 */
	const lspFiles = useMemo(
		() =>
			inputs.flatMap((input) =>
				input.kind === 'source' ? [{ id: input.id, content: input.content }] : []
			),
		[inputs]
	);
	const lsp = useLsp({
		root: selection?.path,
		openFiles: lspFiles,
		openFile: (id, line) => void openFile(id, line),
		readFile: useCallback(
			async (id: string) => {
				try {
					return (await provider.readFile(id)).content;
				} catch {
					return undefined;
				}
			},
			[provider]
		),
		announce,
		revealReferences: useCallback(
			() => showArtifact(TOOL_ARTIFACTS.references.id),
			[showArtifact]
		),
	});

	/*
	 * A rename the server has computed and nobody has applied — ticket 35.
	 *
	 * It is `Replacement[]`, the same type ticket 30's preview and apply already
	 * carry, so the previewing and the writing below are literally ticket 30's
	 * code and not a second implementation of it. That was the acceptance
	 * criterion; sharing the *type* is what makes it true rather than claimed.
	 */
	const [pendingRename, setPendingRename] = useState<
		{ readonly to: string; readonly files: readonly Replacement[] } | undefined
	>(undefined);

	/**
	 * Where an artifact reference goes when it is clicked — ticket 41.
	 *
	 * The two halves of the workbench model, and the reference does not choose
	 * between them: a tool artifact is a dock thing and lands in the dock, and a
	 * file is a Modal Workbench tab, which is what `openFile` already opens. The
	 * chat resolved which it is; this only knows where each one lives.
	 */
	const openArtifact = useCallback(
		(id: string) => {
			if (isToolArtifact(id)) {
				showArtifact(id);
				return;
			}
			void openFile(id);
		},
		[openFile, showArtifact]
	);

	const unpin = useCallback((id: string) => {
		setPinned((current) => {
			const next = current.filter((pinnedId) => pinnedId !== id);
			// Unpinning the visible artifact selects its neighbour, the same way
			// closing the active editor tab does.
			setActiveArtifactId((active) => (active === id ? neighbourId(
				current.map((pinnedId) => ({ id: pinnedId })),
				id
			) : active));
			return next;
		});
	}, []);

	/**
	 * Selecting a session, from the navigator or from a search result.
	 *
	 * One function because it is one decision, and the decision is still a
	 * refusal — but no longer the same one. The rows used to be fixtures with no
	 * harness behind them; they are now real stored conversations that this build
	 * cannot *reopen*. Resuming one means stopping the running harness, opening
	 * another file, and rebuilding the transcript from its entries, which is its
	 * own slice. Saying so is what stops a row that does nothing from reading as
	 * a row that failed.
	 *
	 * The live session is already what is on screen, so choosing it only clears
	 * unread.
	 */
	const selectSession = useCallback(
		(picked: Session) => {
			if (!picked.live) {
				announce(`${picked.name} is a stored session. Reopening one is not built yet.`);
				return;
			}
			setUnread(false);
		},
		[announce]
	);

	const closeHelp = useCallback(() => setHelpOpen(false), []);
	const closeCommandCenter = useCallback(() => setCommandCenterOpen(false), []);

	const commands = useMemo(
		() =>
			buildCommands({
				showArtifact,
				toggleDock: () => setDockCollapsed((current) => !current),
				closeActiveEditor: () => {
					if (activeEditorId) {
						closeEditor(activeEditorId);
					}
				},
				saveActiveEditor: () => {
					if (activeEditorId) {
						void saveFile(activeEditorId);
					}
				},
				// Reopening is only meaningful with something to reopen, and an
				// empty modal over the agent is worse than no modal.
				showEditor: () => setEditorOpen(true),
				showEditorDisabled: inputs.length === 0 ? 'No open editors' : undefined,
				// The command exists wherever the capability does. Unsaved work
				// blocks it — switching roots drops every editor — but it stays
				// in the palette saying so rather than disappearing.
				openFolder: provider.canChooseWorkspace ? () => void openFolder() : undefined,
				openFolderDisabled: dirty ? 'Save your changes first' : undefined,
				showAccessibilityHelp: () => setHelpOpen(true),
			}),
		[
			showArtifact,
			closeEditor,
			saveFile,
			activeEditorId,
			inputs,
			provider,
			dirty,
			openFolder,
		]
	);

	/*
	 * Ctrl+Shift+P is bound on the capture phase because Monaco claims the same
	 * chord for its own palette. Capturing means the workbench decides first;
	 * without it the shortcut silently does nothing whenever the editor has
	 * focus, which is most of the time.
	 */
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent): void {
			// Ctrl+K as well as Ctrl+Shift+P: the Guide names Ctrl+K for Global
			// Search, and it is the same palette rather than a second one.
			if (
				(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') ||
				(event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'k')
			) {
				event.preventDefault();
				event.stopPropagation();
				setCommandCenterOpen(true);
			}
		}
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, []);

	// Ctrl+S likewise: capture, so the WebView's own save never appears.
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent): void {
			if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 's') {
				event.preventDefault();
				event.stopPropagation();
				if (activeEditorId) {
					void saveFile(activeEditorId);
				}
			}
		}
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, [activeEditorId, saveFile]);

	/*
	 * The branch, for the titlebar breadcrumb. Read with the root and again
	 * whenever the change set moves, because that is when a checkout would have
	 * happened — nothing watches `.git/HEAD`, and adding a watcher for a label
	 * is more machinery than the label is worth.
	 */
	useEffect(() => {
		if (!selection) {
			setBranch(undefined);
			return;
		}
		let cancelled = false;
		const read = () => {
			void changesProvider.getBranch().then((name) => {
				if (!cancelled) {
					setBranch(name);
				}
			});
		};
		read();
		const stop = changesProvider.subscribe(read);
		return () => {
			cancelled = true;
			stop();
		};
	}, [changesProvider, selection]);

	// The recent list is Rust's; this only reads it, and re-reads it after a
	// switch because switching reorders it.
	useEffect(() => {
		void provider.recentWorkspaces().then(setRecents);
	}, [provider, selection]);

	/*
	 * The workspace's stored conversations.
	 *
	 * Keyed on the root and nothing else. It is deliberately *not* re-read when a
	 * turn ends: a session started in this window is the live row, drawn from
	 * live state, and re-reading on every status change would mean up to twenty
	 * file opens four times a turn to learn something already on screen. Stored
	 * rows change when another window writes or between launches, and both of
	 * those are covered by reading once per root.
	 *
	 * `cancelled` because a switch can land while the previous root's sessions
	 * are still being read, and the answer to the old question must not overwrite
	 * the answer to the new one.
	 */
	useEffect(() => {
		let cancelled = false;
		void agentProvider.listSessions().then((sessions) => {
			if (!cancelled) {
				setStored(sessions);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [agentProvider, selection]);

	/**
	 * Switch roots by index into that list — never by path. See
	 * `docs/adr/0001-multi-root-confinement.md`.
	 *
	 * Refused outright while anything is dirty or a turn is running, rather
	 * than handled. Both are legitimate answers and this is the cheap one:
	 * editor ids are relative to the old root and the agent's `ExecutionEnv` is
	 * bound to it, so a switch underneath either loses work or races.
	 */
	const switchWorkspace = useCallback(
		async (index: number) => {
			if (index >= recents.length) {
				return;
			}
			if (dirty) {
				announce('Save your changes before switching workspace.');
				return;
			}
			if (session.status === 'running' || session.status === 'waiting') {
				announce('The agent is mid-turn. Wait for it to finish before switching workspace.');
				return;
			}
			let chosen: WorkspaceSelection;
			try {
				chosen = await provider.switchWorkspace(index);
			} catch (error) {
				announce(`Could not switch workspace. ${reason(error)}`);
				return;
			}
			/*
			 * **Reload, rather than reset what this callback can reach.**
			 *
			 * Editor ids are relative to the old root and project profiles are read
			 * from it — both were handled here. The one that was not is the agent's
			 * session: `ExecutionEnv` sends every path to Rust, which resolves it
			 * against whatever root is current *now*, so a `Session` opened under
			 * the old root goes on appending under the new one. Its parent chain
			 * then splits across two files, and every later turn dies on a parent
			 * id that exists only in the other root — an unrecoverable window, since
			 * this build has one session and no way to start another.
			 *
			 * Rebinding that from here would mean rebuilding the provider, the
			 * harness and the session store mid-life. Reloading rebinds everything
			 * through ordinary start-up instead, which reads the root back from
			 * Rust — the restore path, already proven. Refusing while an editor is
			 * dirty or a turn is running is what makes it safe to be this blunt.
			 *
			 * The announcement below is deliberately not made on this path: the
			 * page is going. What replaces it is the workbench coming up on the new
			 * root, which is the same information more plainly.
			 */
			if (chosen.path !== selection?.path) {
				window.location.reload();
				return;
			}
			setInputs([]);
			setActiveEditorId(undefined);
			setSelection(chosen);
			setUnrestored(undefined);
			/*
			 * Project-scoped profiles, skills and user tools are read from the
			 * root, so a switch has to re-read them. This is the half of ticket
			 * 31 most likely to be missed, and it fails quietly when it is.
			 */
			const loaded = await loadProfileFiles();
			announce(
				loaded.problems.length > 0
					? `Switched to ${chosen.label}. Profiles: ${loaded.problems.join('. ')}`
					: `Switched to ${chosen.label}.`
			);
		},
		[announce, dirty, provider, recents.length, selection?.path, session.status]
	);

	const groups = useMemo(
		() =>
			buildGroups({
				workspace: selection,
				branch,
				recents,
				liveName: session.name,
				liveStatus: session.status,
				liveUnread: unread,
				stored,
			}),
		[branch, recents, selection, session, stored, unread]
	);

	/**
	 * The ADE menu — the only application menu.
	 *
	 * Settings and About say what they are rather than being absent: a menu item
	 * that will exist is more honest present-and-explained than missing.
	 */
	const adeMenu = useMemo<readonly AdeMenuAction[]>(
		() => [
			{
				id: 'new-session',
				label: 'New session',
				// One harness, one session. Saying so beats an item that does
				// nothing, and beats hiding what the Guide says is there.
				disabled: 'one session in this build',
				run: () => {},
			},
			{ id: 'palette', label: 'Command palette', run: () => setCommandCenterOpen(true) },
			{
				id: 'debug-notification',
				label: 'Debug notification',
				// A design affordance rather than a feature: with one live session
				// there is little to notify about, so this is how the surface gets
				// looked at without waiting for a long turn to end unwatched.
				run: () => notify('This is what a notification looks like.'),
			},
			{ id: 'settings', label: 'Settings', disabled: 'not built yet', run: () => {} },
			{
				id: 'about',
				label: 'About ADE',
				run: () => announce('ADE — an agent development environment. Prototype build.'),
			},
			{
				id: 'quit',
				label: 'Quit',
				disabled: controls.available ? undefined : 'native window only',
				run: controls.close,
			},
		],
		[announce, controls.available, controls.close, notify]
	);

	// A pinned id that is no longer pinned would render an empty dock body.
	const activeArtifact =
		activeArtifactId && pinned.includes(activeArtifactId) ? activeArtifactId : pinned[0];

	return (
		<WorkbenchLayout
			side={side}
			titlebar={
				<Titlebar
					workspace={breadcrumb(selection, branch)}
					session={session.name}
					controls={controls}
					theme={theme}
					onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
					menu={adeMenu}
				/>
			}
			main={
				<>
					<SessionNavigator
						groups={groups}
						activeId={LIVE_SESSION_ID}
						onSelect={selectSession}
						onSwitchWorkspace={(index) => void switchWorkspace(index)}
					/>
					<AgentChat
						provider={agentProvider}
						files={fileIds}
						onAnnounce={announce}
						onSession={onSessionState}
						onOpenArtifact={openArtifact}
						onTranscript={(search) => {
							transcriptSearch.current = search;
						}}
					/>
				</>
			}
			announcement={<span key={announcement.seq}>{announcement.message}</span>}
			toasts={
				<Toasts
					toasts={toasts}
					onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
				/>
			}
			dock={
				pinned.length === 0 ? null : (
					<PinnedWorkbench
						side={side}
						fraction={clampDock(dockFraction)}
						onFraction={setDockFraction}
						collapsed={dockCollapsed}
						onCollapsed={setDockCollapsed}
						artifacts={pinned.map((id) => artifactRef(id, inputs))}
						activeId={activeArtifact}
						onSelect={setActiveArtifactId}
						onUnpin={unpin}
					>
						{activeArtifact ? (
							<ArtifactView
								id={activeArtifact}
								provider={provider}
								changesProvider={changesProvider}
								terminalAdapter={terminalAdapter}
								entries={entries}
								inputs={inputs}
								activeEditorId={activeEditorId}
								onOpenFile={(id, line) => void openFile(id, line)}
								onOpenDiff={(id) => void openDiff(id)}
								onOpenFolder={
									provider.canChooseWorkspace && !selection ? () => void openFolder() : undefined
								}
								fileOperations={fileOperations}
								lsp={lsp}
								onPreviewReplace={openReplacePreview}
								onApplyReplace={applyReplacements}
								onChange={editFile}
							/>
						) : null}
					</PinnedWorkbench>
				)
			}
			overlays={
				<>
					<EditorDialog
						open={editorOpen}
						inputs={inputs}
						activeId={activeEditorId}
						onSelect={setActiveEditorId}
						onCloseEditor={closeEditor}
						onChange={editFile}
						onDismiss={() => setEditorOpen(false)}
						onPin={(id) => {
							showArtifact(id);
							setEditorOpen(false);
						}}
					/>
					<CommandCenter
						open={commandCenterOpen}
						commands={commands}
						files={entries}
						groups={groups}
						onOpenFile={(entry) => void openFile(entry.id)}
						onOpenArtifact={showArtifact}
						onSelectSession={selectSession}
						searchTranscript={searchTranscript}
						onClose={closeCommandCenter}
					/>
					<ConfirmDiscard
						name={inputs.find((input) => input.id === pendingCloseId)?.name}
						onCancel={() => setPendingCloseId(undefined)}
						onDiscard={() => {
							if (pendingCloseId) {
								forceCloseEditor(pendingCloseId);
							}
							setPendingCloseId(undefined);
						}}
						onSave={() => {
							const id = pendingCloseId;
							setPendingCloseId(undefined);
							if (id) {
								// Only close once the write succeeded; a failed save
								// that still closed the tab would lose the edit.
								void saveFile(id).then(() => forceCloseEditor(id));
							}
						}}
					/>
					{/*
					 * Rename, in two dialogs — ticket 35. The name is asked for
					 * first, then the server is asked what that would change, and
					 * only then is there anything to confirm. Confirming before the
					 * server has answered would be confirming a number nobody knows.
					 */}
					<Prompt
						open={lsp.renameTarget !== undefined}
						title="Rename symbol"
						label="New name"
						initialValue={lsp.renameTarget?.symbol ?? ''}
						confirmLabel="Preview"
						validate={(value) => (value.trim() === '' ? 'A name is required.' : undefined)}
						onCancel={lsp.cancelRename}
						onSubmit={(value) => {
							lsp.cancelRename();
							void lsp.planRename(value).then((plan) => {
								if (!plan.ok) {
									announce(plan.reason);
									return;
								}
								// Every file, not just the first: a preview showing one
								// of nine is a preview of the wrong thing.
								for (const file of plan.files) {
									openReplacePreview(file);
								}
								setPendingRename({ to: value, files: plan.files });
							});
						}}
					/>
					<Confirm
						open={pendingRename !== undefined}
						title="Apply rename"
						message={
							pendingRename
								? `Rename to ${pendingRename.to} in ${pendingRename.files.length} ` +
									`file${pendingRename.files.length === 1 ? '' : 's'}. The tabs behind this ` +
									'dialog show every change. Nothing is written until you apply.'
								: ''
						}
						onCancel={() => setPendingRename(undefined)}
						actions={[
							{
								label: 'Apply',
								run: () => {
									const files = pendingRename?.files ?? [];
									setPendingRename(undefined);
									void applyReplacements(files);
								},
							},
						]}
					/>
					<AccessibilityHelp open={helpOpen} onClose={closeHelp} />
				</>
			}
		/>
	);
}
