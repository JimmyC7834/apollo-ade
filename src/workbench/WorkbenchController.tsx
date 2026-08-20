// Everything that is not topology: which providers are in use, what the
// commands do, what is persisted, and which feature renders into which slot.
// Geometry lives in WorkbenchLayout — this file never sets a width.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { listSessionsIn, loadProfileFiles, type StoredSession } from '../agent';
import { nextTurnId } from '../features/agent/liveSession';
import { sessionSet } from '../features/agent/sessionSet';
import {
	TOOL_ARTIFACTS,
	clampDock,
	dockSide,
	browserTabId,
	browserTabLabel,
	isBrowserTab,
	isToolArtifact,
} from '../artifacts';
import { agentRect, createBrowserAdapter, normalizeUrl, urlHost } from '../browser';
import { setBrowserHost } from '../agent/browserTool';
import { BrowserTab } from '../features/browser/BrowserTab';
import { createChangesProvider } from '../changes';
import { buildCommands } from '../commands/commandRegistry';
import { EditorDialog } from '../editor/EditorDialog';
import { isDirty, type EditorInput } from '../editor/EditorWorkbench';
import { basename, neighbourId } from '../ids';
import { AgentChat } from '../features/agent/AgentChat';
import type { LiveSession } from '../features/agent/liveSession';
import type { TranscriptHit } from '../features/agent/transcript';
import { CommandCenter } from '../features/commandCenter/CommandCenter';
import type { FileOperations } from '../features/explorer/ExplorerTree';
import { isUnder, movedId } from '../features/explorer/fileOperations';
import { useLsp } from '../features/lsp/useLsp';
import { refuseReason, type Replacement } from '../features/search/replace';
import { SessionNavigator } from '../features/sessions/SessionNavigator';
import { createPersistenceAdapter, type PersistedState } from '../persistence';
import { pluginHost } from '../plugins/host';
import { recordOpenSessions, takeOpenSessions, takeUnopened } from '../sessionRequest';
import {
	archiveMove,
	breadcrumb,
	buildGroups,
	type Session,
	type SessionStatus,
} from '../sessions';
import { createTerminalAdapter } from '../terminal';
import { TerminalPanel } from '../features/terminal/TerminalPanel';
import { Confirm, Prompt, useOccluded } from '../ui';
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
	/*
	 * Browser tabs are dropped on the way back in. `pinned` is persisted and a
	 * page is not — a tab restored from the last launch would be a dock tab with
	 * no page behind it, which is what the first native run of slice 43 showed.
	 * Filtered here rather than at save time, so a state file written by an older
	 * build is also cleaned up.
	 */
	const [pinned, setPinned] = useState<readonly string[]>(
		(restored?.pinned ?? []).filter((id) => !isBrowserTab(id))
	);

	/*
	 * Browser tabs — slice 43.
	 *
	 * **Existence and visibility are separate here, and nowhere else in the
	 * dock.** `browserTabs` is every page that exists; `pinned` is the ones with
	 * a slot in the tab strip. Every other artifact conflates the two, and a
	 * browser tab cannot: the agent opens tabs *hidden*, and a long turn that
	 * pinned each one would flood the dock with pages nobody asked to see. A
	 * hidden tab lives in the transcript as a chip until the dev opens it.
	 *
	 * None of it is persisted. A page restored on the next launch is a page
	 * painted over the workbench by something nobody did.
	 */
	const browser = useMemo(() => createBrowserAdapter(), []);
	const [browserTabs, setBrowserTabs] = useState<
		readonly { readonly id: string; readonly url: string; readonly host: string }[]
	>([]);
	/*
	 * The agent's tools are built once, long before this component mounts, so
	 * the host below is registered rather than passed — and it must not close
	 * over a stale tab list. A ref written during render is what keeps `tabs()`
	 * answering with what exists now.
	 */
	const tabsRef = useRef(browserTabs);
	tabsRef.current = browserTabs;
	// Only ever upward — see `browserTabId`. A reused label races its own close.
	const tabCount = useRef(0);
	const noteOpened = useCallback((id: string, host: string) => {
		setBrowserTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, host } : tab)));
	}, []);
	/*
	 * The tab renders the refusal itself, above the page box. This is the other
	 * half of it: a refusal that is only drawn is a refusal a screen reader never
	 * hears, and the live region is how everything else in the workbench reports.
	 */
	const noteFailed = useCallback((_id: string, reason: string) => announce(reason), []);
	const browserHosts = useMemo(
		() => new Map(browserTabs.map((tab) => [tab.id, tab.host])),
		[browserTabs]
	);
	/*
	 * A page is a child HWND painted above the whole React tree, so an overlay
	 * cannot be drawn over it — it has to be hidden instead. `occlusion.ts` is
	 * where every overlay in the workbench says it is there; this is the one
	 * place that reads it. See ADR 0004.
	 */
	const occluded = useOccluded();
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
	/**
	 * Every conversation this window is holding, and which one is on screen.
	 *
	 * Subscribed to rather than held, because the collection outlives every
	 * component that draws it — a turn running in a session nobody has open has
	 * nothing else to belong to. See `sessionSet.ts`.
	 */
	const live = useSyncExternalStore(sessionSet.subscribe, sessionSet.view);
	const session = live.focused;
	/** This workspace's stored conversations. Empty until they are read. */
	/**
	 * Every root's stored conversations, under the root they were read from.
	 *
	 * **One store — ticket 61.** It used to be two, and the second was a bare list
	 * meaning "the current root's". A bare list carries no root, so it was drawn
	 * against whichever root was current when it rendered; switching moves the
	 * current root immediately and the new list arrives a file read later, so the
	 * workspace you had just arrived in briefly held the conversations of the one
	 * you left.
	 */
	const [storedByRoot, setStoredByRoot] = useState<
		ReadonlyMap<string, readonly StoredSession[]>
	>(new Map());
	const [commandCenterOpen, setCommandCenterOpen] = useState(false);
	/** The session whose close is being confirmed, because a turn is in flight. */
	const [closing, setClosing] = useState<string>();
	/** The stored conversation whose delete is being confirmed — ticket 56. */
	const [deleting, setDeleting] = useState<Session>();
	/*
	 * Bumped when a stored session is archived or deleted, to re-read the list.
	 *
	 * The list is otherwise read once per root on purpose — re-reading on every
	 * status change costs one file open per conversation to learn something
	 * already on screen. Archiving is the one thing this window does that changes
	 * the answer, so it is the one thing that asks again.
	 */
	const [storedNonce, setStoredNonce] = useState(0);
	/*
	 * Notifications — ticket 44. Toasts are a list rather than one slot because
	 * two things can finish while you are away, and the second replacing the first
	 * would make the mechanism unreliable exactly when it is needed.
	 */
	const [toasts, setToasts] = useState<readonly Toast[]>([]);
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

	/**
	 * A finished turn is worth a toast **when you were not there to see it**.
	 *
	 * Two ways not to be there now, and the second is the new one: the window is
	 * behind something else, or the session that finished is not the session on
	 * screen — which is the whole point of ticket 48. A notice for a turn you are
	 * watching is the kind of noise that teaches people to ignore the mechanism.
	 *
	 * Keyed per session in a ref, because "the previous status" stopped being a
	 * single value the moment there was more than one conversation. A ref rather
	 * than state for the reason it always was: this runs from an effect and
	 * raising a toast from a state updater raised two under StrictMode.
	 */
	const lastStatus = useRef(new Map<string, SessionStatus>());
	useEffect(() => {
		for (const open of live.sessions) {
			const status = open.status();
			const before = lastStatus.current.get(open.key) ?? 'idle';
			lastStatus.current.set(open.key, status);
			if (before === status || (status !== 'done' && status !== 'waiting')) {
				continue;
			}
			if (open === live.focused && document.hasFocus()) {
				continue;
			}
			const who = open.name() ?? 'A session';
			notify(
				status === 'waiting' ? `${who} is waiting for your answer.` : `${who} finished.`,
				open === live.focused ? undefined : { label: 'Open', run: () => sessionSet.focus(open.key) }
			);
		}
		// Sessions that have been closed leave nothing behind to compare against.
		for (const key of [...lastStatus.current.keys()]) {
			if (!live.sessions.some((open) => open.key === key)) {
				lastStatus.current.delete(key);
			}
		}
	}, [live, notify]);

	const provider = useMemo(() => createWorkspaceProvider(), []);
	/*
	 * What is open, for the next launch — ticket 53.
	 *
	 * Written on every change rather than at shutdown, because a desktop window is
	 * closed by the window manager, by a crash and by the user, and only one of
	 * those is a moment code could run in. Sessions without a file yet contribute
	 * nothing: there is nothing on disk to reopen, and a blank conversation is
	 * what a launch produces anyway.
	 */
	useEffect(() => {
		const open = live.sessions.flatMap((session) =>
			session.path && session.root
				? [{ root: session.root.path, path: session.path, focused: session === live.focused }]
				: []
		);
		if (open.length > 0) {
			recordOpenSessions(open);
		}
	}, [live]);
	const changesProvider = useMemo(() => createChangesProvider(), []);
	const terminalAdapter = useMemo(() => createTerminalAdapter(), []);
	const [selection, setSelection] = useState<WorkspaceSelection | undefined>(undefined);
	const [entries, setEntries] = useState<readonly WorkspaceEntry[]>([]);
	const [inputs, setInputs] = useState<readonly EditorInput[]>([]);
	const [activeEditorId, setActiveEditorId] = useState<string | undefined>(undefined);
	const [pendingCloseId, setPendingCloseId] = useState<string | undefined>(undefined);
	/**
	 * The editors of every root this window has been in, put down when it left.
	 *
	 * A ref rather than state because nothing renders it: it is read only at the
	 * moment a root changes, and making it state would redraw the workbench every
	 * time a tab in a folder nobody is looking at changed.
	 */
	const stashed = useRef(
		new Map<string, { inputs: readonly EditorInput[]; activeEditorId: string | undefined }>()
	);
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

	/**
	 * Which index in Rust's recent list names this root, right now.
	 *
	 * **Read at the moment it is spent, never held.** An index is a position in a
	 * list `remember` reorders, and `choose_workspace` reorders it — so an index
	 * captured when a row was drawn can name a different folder by the time the
	 * row is clicked. `bootstrap` learned this first: resolving every index up
	 * front and spending them one at a time is what put a restored conversation
	 * in the wrong folder. Ticket 62 gives the two click paths the same rule.
	 *
	 * The path goes no further than this function. What crosses to Rust is the
	 * index, which is the whole of ADR 0002's argument.
	 */
	const locate = useCallback(
		async (root: string): Promise<number | undefined> => {
			const at = (await provider.recentWorkspaces()).findIndex(
				(recent) => recent.path === root
			);
			return at === -1 ? undefined : at;
		},
		[provider]
	);

	/*
	 * The conversations this window comes up with, opened as an *action* rather
	 * than during render — ticket 45. `bootstrap` is idempotent, which is what
	 * makes StrictMode's double-invoked effect produce one session and one file
	 * rather than the module-level promise cache that used to guarantee it.
	 */
	useEffect(() => {
		sessionSet.onAnnounce(announce);
		/*
		 * **Not before there is a root**, and that is a real failure this caught.
		 * `create_agent_session` with no index resolves against Rust's current root,
		 * and at mount `restore_workspace` may not have adopted one yet — the window
		 * then came up with no conversation at all and *"The session could not be
		 * started"* in the live region. It was always a race; it is now a gate.
		 *
		 * A window with no folder therefore has no session, which is the honest
		 * state: there is nowhere to confine one. Choosing a folder makes both.
		 */
		if (!selection) {
			return;
		}
		/*
		 * **Recognised, not named.** The record holds each session's root as a path;
		 * it is matched against Rust's own recent list and passed on as an *index*,
		 * so the renderer still cannot name a folder — the rule `choose_workspace`
		 * exists to hold, and `docs/adr/0002-a-root-per-session.md` restates.
		 *
		 * The match happens per session, immediately before that session is opened,
		 * because the list is Rust's and its order is not ours to assume. Resolving
		 * every index up front and spending them one at a time is what put a
		 * restored conversation in the wrong folder — see `Locate`.
		 */
		sessionSet.bootstrap(takeOpenSessions(), locate);
	}, [announce, locate, provider, selection]);

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
			const loaded = await loadProfileFiles(workspace.path);
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

	/**
	 * The workbench follows the focused conversation into its folder — ticket 49.
	 *
	 * **The one place a root change is applied**, and everything else that used to
	 * do it now goes through here by focusing a session. `enter` moves Rust's
	 * current root to this session's; the explorer, search, git, the language
	 * server and any new terminal read that root, and everything keyed on
	 * `selection` below reloads because it changed.
	 *
	 * The *session's* confinement does not move and never did — it was fixed when
	 * the session was created. What moves is only what the user is looking at,
	 * which is why a turn running in the folder you just left is unaffected.
	 *
	 * **Editors are kept per root rather than discarded**, which is the half of
	 * ticket 31 a reload could never do. That is also what removed the last
	 * refusal: switching used to be blocked on unsaved work because unsaved work
	 * was about to be thrown away, and now it is put down and picked up again.
	 */
	const editors = useRef({ inputs, activeEditorId });
	useEffect(() => {
		editors.current = { inputs, activeEditorId };
	}, [inputs, activeEditorId]);
	/**
	 * Entering a root, one at a time.
	 *
	 * **A queue, because `enter` is two facts that must not be able to disagree**:
	 * Rust's current root, and React's `selection`. Two focus changes in quick
	 * succession issue two `invoke`s, Tauri does not order them, and the second
	 * could adopt while only the first's `setSelection` was applied — leaving the
	 * explorer listing one folder while a save wrote a relative path into another.
	 * Serialising makes the last one win on both sides.
	 */
	const entering = useRef(Promise.resolve());
	const enter = useCallback(
		(next: LiveSession, from: string | undefined) => {
			entering.current = entering.current.then(async () => {
				if (sessionSet.view().focused !== next) {
					// Superseded while it waited. The focus change that replaced it is
					// behind this one in the same queue and will adopt instead — and
					// asking the set rather than tracking a flag means this is the same
					// question the rest of the workbench asks.
					return;
				}
				let entered;
				try {
					entered = await next.provider.enter();
				} catch (error) {
					announce(`Could not open ${next.root?.label ?? 'that folder'}. ${reason(error)}`);
					return;
				}
				if (!entered) {
					return;
				}
				if (from) {
				stashed.current.set(from, editors.current);
			}
				const back = stashed.current.get(entered.path);
				setInputs(back?.inputs ?? []);
				setActiveEditorId(back?.activeEditorId);
				setSelection(entered);
				setUnrestored(undefined);
				/*
				 * Project-scoped profiles, skills and user tools are read from the
				 * root, so arriving in one has to re-read them. This is the half of
				 * ticket 31 most likely to be missed, and it fails quietly when it is.
				 */
				const loaded = await loadProfileFiles(entered.path);
				announce(
					loaded.problems.length > 0
						? `${entered.label}. Profiles: ${loaded.problems.join('. ')}`
						: `${entered.label}.`
				);
			});
			return entering.current;
		},
		[announce]
	);

	useEffect(() => {
		const target = session?.root?.path;
		// `hydrated` is the restore having finished: entering a root before it
		// would have the restore put the previous root's editors back on top.
		if (!session || !hydrated || !target || target === selection?.path) {
			return;
		}
		void enter(session, selection?.path);
	}, [enter, hydrated, selection?.path, session]);

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

	/**
	 * Hand this app a folder, and start a conversation in it — ticket 49.
	 *
	 * **The dialog is still the only door a new root comes through**, and it is
	 * the whole of what this does that the navigator's groups do not: every other
	 * root is already on the recent list and offers *New session* of its own.
	 *
	 * No reload, no refusal, and no lost editors. All three were the same
	 * mechanism: the sessions this window held were bound to one ambient root, so
	 * moving it under them meant rebuilding everything or reloading. A session
	 * carries its own root now, so choosing a folder adds a conversation rather
	 * than replacing the window — and the editors of the root you left are kept,
	 * not discarded, which is what makes coming back cheap.
	 */
	const openFolder = useCallback(async () => {
		const chosen = await provider.chooseWorkspace();
		if (!chosen) {
			return;
		}
		/*
		 * `chooseWorkspace` has already moved Rust's current root, so a session
		 * created now with no index is created *there*. Focusing it is what brings
		 * the workbench across — see `enter`, which is the one place a root change
		 * is applied.
		 */
		if (!(await sessionSet.open({ fresh: true }))) {
			/*
			 * The dialog moved Rust's root and nothing came of it. Left alone, the
			 * workbench would go on believing it is in the old folder while every
			 * ambient-root command — the explorer's reads, an editor's save —
			 * resolved against the new one. Put it back where the sessions are.
			 */
			const back = live.focused;
			if (back) {
				await enter(back, undefined);
			}
			return;
		}
		// A deliberate choice supersedes a root that failed to restore: the
		// user has answered the question the held record was waiting on.
		setUnrestored(undefined);
	}, [enter, live.focused, provider]);

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

	/**
	 * A browser tab, in the dock — ticket 69.
	 *
	 * The number only ever goes up, and never comes back: it is the label of the
	 * child webview Rust holds, and reopening a label that was closed a moment
	 * ago wedges the call that does it. See `browserTabId`.
	 */
	const openBrowserTab = useCallback(() => {
		const id = browserTabId((tabCount.current += 1));
		setBrowserTabs((current) => [...current, { id, url: '', host: 'Browser' }]);
		showArtifact(id);
	}, [showArtifact]);

	/*
	 * What the `browser` tool is given — ticket 70. Registered rather than
	 * passed, because the tool is built when the runner is, which is before any
	 * of this exists.
	 *
	 * **A tab the agent opens is opened straight through the adapter, with no
	 * React component behind it.** That is what "hidden" costs here, and it costs
	 * nothing: a hidden page has no box in the dock to measure, so it has nothing
	 * a component would do for it. When the dev opens one from the transcript it
	 * gains a `BrowserTab`, which calls `open` again with the same label — Rust
	 * navigates the webview that is already there and moves it into the dock.
	 */
	useEffect(() => {
		setBrowserHost({
			async open(url) {
				const id = browserTabId((tabCount.current += 1));
				const target = normalizeUrl(url);
				// Awaited, so a URL the allow-list refuses reaches the model as a
				// failed tool call rather than as a tab that quietly shows nothing.
				await browser.open(browserTabLabel(id), target, agentRect(window.innerHeight));
				const host = urlHost(target);
				setBrowserTabs((current) => [...current, { id, url: target, host }]);
				return { id, host };
			},
			tabs: () => tabsRef.current.map((tab) => ({ id: tab.id, host: tab.host })),
			evaluate: (id, js) => browser.evaluate(browserTabLabel(id), js),
		});
		return () => setBrowserHost(undefined);
	}, [browser]);

	/*
	 * A page outlives the component that shows it, so nothing else closes the
	 * tabs the agent opened and never showed. Closing the window is the one
	 * moment they are all certainly finished with.
	 */
	useEffect(
		() => () => {
			for (const tab of tabsRef.current) {
				void browser.close(browserTabLabel(tab.id));
			}
		},
		[browser]
	);

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
			/*
			 * A browser tab is a dock thing too, and it is the one artifact that
			 * can already exist while being unpinned — this is how a tab the agent
			 * opened gets its slot in the strip. It is also the one that can stop
			 * existing while its chip stays in the transcript, so the chip says so
			 * rather than pinning a tab with no page behind it.
			 */
			if (isBrowserTab(id)) {
				if (tabsRef.current.some((tab) => tab.id === id)) {
					showArtifact(id);
				} else {
					announce('That browser tab has been closed.');
				}
				return;
			}
			if (isToolArtifact(id)) {
				showArtifact(id);
				return;
			}
			void openFile(id);
		},
		[announce, openFile, showArtifact]
	);

	const unpin = useCallback((id: string) => {
		// Unpinning a browser tab destroys its page, the same way unpinning the
		// terminal kills its shell. There is no unpinned-but-alive state for a tab
		// the dev opened: the strip is the only place it exists.
		if (isBrowserTab(id)) {
			setBrowserTabs((current) => current.filter((tab) => tab.id !== id));
		}
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

	const closeHelp = useCallback(() => setHelpOpen(false), []);
	const closeCommandCenter = useCallback(() => setCommandCenterOpen(false), []);

	/**
	 * A conversation of its own — ticket 47, in any root this app has been given
	 * since ticket 49.
	 *
	 * @param at Index into the recent list. Undefined is the root you are in.
	 */
	/**
	 * Start a conversation, here or in another recent root.
	 *
	 * `root` is a path and `undefined` means *here* — the workspace the window is
	 * already in, which needs no index and must not be given one: a root the
	 * window is in but the recent list does not name would otherwise be refused
	 * a session in the folder it is standing in.
	 */
	const newSession = useCallback(
		async (root?: string) => {
			if (root === undefined) {
				announce('New session.');
				await sessionSet.open({ fresh: true });
				return;
			}
			const at = await locate(root);
			if (at === undefined) {
				announce('That folder is no longer available.');
				return;
			}
			announce(`New session in ${recents[at]?.label ?? 'another folder'}.`);
			await sessionSet.open({ fresh: true }, at);
		},
		[announce, locate, recents]
	);

	/**
	 * Stop watching the focused conversation.
	 *
	 * **Closing is not deleting.** The file stays on disk and the row stays in the
	 * navigator as a stored conversation, because reopening is cheap now. A turn
	 * in flight is confirmed first and stopped on confirm — ticket 48 — since the
	 * one thing closing does destroy is a run nobody asked to end.
	 */
	const dropSession = useCallback(
		(key: string) => {
			sessionSet.close(key);
			announce('Session closed. It is still listed as a stored conversation.');
		},
		[announce]
	);
	const closeSession = useCallback(() => {
		const going = live.focused;
		if (!going) {
			return;
		}
		/*
		 * Asked through the app's own `Confirm` rather than `window.confirm`, which
		 * blocks the whole webview and cannot be styled or driven. `ConfirmDiscard`
		 * is the same shape for the same reason.
		 */
		if (going.status() === 'running' || going.status() === 'waiting') {
			setClosing(going.key);
			return;
		}
		dropSession(going.key);
	}, [dropSession, live.focused]);

	/**
	 * Tell every other conversation in this folder that an undo took its work.
	 *
	 * **Ticket 52's last criterion, and the only part of it the chat cannot do**:
	 * a session whose edits were reverted must not be left claiming them, and
	 * nothing watches the working tree — it would never find out on its own. It is
	 * put in two places for the two readers: the model's own context, so its next
	 * answer is not built on files that no longer say what it wrote, and the
	 * transcript, so the person who opens that conversation tomorrow can see why
	 * its work is missing.
	 *
	 * Told to everyone in the root rather than only to whoever Rust named as a
	 * writer. The narrower list is what the *confirmation* needs, because it is
	 * naming consequences; this is a session being told the ground moved, which is
	 * true for all of them and cheap to say.
	 */
	const tellTheOthers = useCallback(
		(note: string) => {
			for (const other of live.sessions) {
				// A conversation with no turns has nothing to be wrong about yet, and
				// this note would become its name.
				if (other === live.focused || other.snapshot().turns.length === 0) {
					continue;
				}
				if (other.root?.path !== live.focused?.root?.path) {
					continue;
				}
				void other.provider.record(note);
				other.setTurns((current) => [
					...current,
					{
						// Never a bare `Date.now()`: a turn id is both the React key and
						// the identity `applyEvent` matches on, and restored history can
						// carry ids ahead of the clock. See `nextTurnId`.
						id: nextTurnId(current),
						/*
						 * No prompt: nobody said this. The transcript's prompt line is
						 * marked up as *"You said"* for screen readers, and putting a
						 * heading there would attribute the sentence to the user. The
						 * note is the whole row, styled as what it is.
						 */
						prompt: '',
						parts: [{ kind: 'undone', note }],
						status: 'complete',
					},
				]);
				other.patch({ unread: true });
			}
		},
		[live.focused, live.sessions]
	);

	/*
	 * What the plugin host is running — ticket 72.
	 *
	 * A module singleton read through `useSyncExternalStore` rather than state
	 * the controller owns, because plugins load *before this component mounts*
	 * and `provider.ts` reaches the same host from outside the tree. One store,
	 * two readers.
	 */
	const pluginState = useSyncExternalStore(pluginHost.subscribe, pluginHost.snapshot);

	/*
	 * The second load. Global plugins are already in by now — `main.tsx` loads
	 * them before React mounts, which is where the ADR puts injection. A *local*
	 * plugin lives under a root and there is no root until one has been opened,
	 * so this is where those are discovered. Nothing runs that the user has not
	 * enabled for this root; discovery is only reading.
	 */
	useEffect(() => {
		if (selection?.path) {
			void pluginHost.load();
		}
	}, [selection?.path]);

	const commands = useMemo(
		() => [
			...buildCommands({
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
				// The command exists wherever the capability does, and nothing
				// disables it any more: a root change keeps the editors of the root
				// it leaves rather than discarding them — ticket 49.
				openFolder: provider.canChooseWorkspace ? () => void openFolder() : undefined,
				showAccessibilityHelp: () => setHelpOpen(true),
				newSession: () => void newSession(),
				closeSession,
				openBrowserTab,
			}),
			/*
			 * Claimed by plugins, appended rather than merged. They are already
			 * namespaced by plugin id, so nothing here can collide with a command
			 * the workbench contributes — and the palette draws them with our own
			 * component, which is what `claim` means.
			 */
			...pluginState.commands,
		],
		[
			pluginState.commands,
			showArtifact,
			openBrowserTab,
			newSession,
			closeSession,
			closeEditor,
			saveFile,
			activeEditorId,
			inputs,
			provider,
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
	/*
	 * Asked of the *focused* session, because a provider reads the sessions of its
	 * own root and this list is the current root's. Any session would have done
	 * when they all shared a folder; since ticket 49 they do not.
	 */
	const listProvider = session?.provider;
	/*
	 * The root that provider reads — the answer's own root rather than the
	 * window's. The two agree once a switch has settled and disagree while one is
	 * in flight, which is exactly the window this list used to be mislabelled in.
	 */
	const listRoot = session?.root?.path;
	useEffect(() => {
		if (!listProvider) {
			return;
		}
		let cancelled = false;
		void listProvider.listSessions().then((sessions) => {
			if (cancelled) {
				return;
			}
			/*
			 * Filed under the root it was *read from*, never under whichever root is
			 * current when it lands. `listRoot` is the focused session's own root,
			 * and a switch moves the window's while this read is in flight.
			 */
			if (listRoot) {
				setStoredByRoot((current) => new Map(current).set(listRoot, sessions));
			}
			/*
			 * A session was picked and could not be opened.
			 *
			 * **Read here rather than at mount, and the ordering is the whole
			 * reason.** `openSession` records the failure, and it is async: a mount
			 * effect reads `localStorage` before the provider has finished deciding
			 * which session it got, and finds nothing. This runs after
			 * `listSessions`, which awaits that same session — so by now the answer
			 * exists. Measured, not reasoned: the first version was a mount effect
			 * and the note was still sitting in storage afterwards.
			 *
			 * Worth saying at all because the switch otherwise *looks* successful:
			 * right root, a conversation on screen, just not the one asked for.
			 */
			if (takeUnopened() !== undefined) {
				/*
				 * It says what happened, not why. "Damaged" was the first wording
				 * and it was a diagnosis this code cannot make: a session over
				 * 2 MiB fails the same way, through `read_file`'s cap, and telling
				 * someone their healthy conversation is corrupt is worse than
				 * telling them nothing.
				 */
				notify('That conversation could not be reopened. Opened the most recent one instead.');
			}
		});
		return () => {
			cancelled = true;
		};
		/*
		 * Re-read when a session opens or closes as well as on a root change: a
		 * conversation that was closed becomes a stored row, and one that was
		 * opened stops being one. Both are cheap and neither happens often — unlike
		 * a turn ending, which is why that is still deliberately not a trigger.
		 */
	}, [listProvider, listRoot, live.sessions.length, notify, selection, storedNonce]);

	/*
	 * The other recent roots' conversations.
	 *
	 * **Sequential, capped, and after the current root's list, all for the same
	 * reason**: these are file reads on Tauri's dispatcher, which is serialised, so
	 * eight roots asked at once would put every other command behind a hundred and
	 * sixty of them at start-up. One root at a time, five rows each, and the
	 * workspace you are actually in is already on screen before any of it runs.
	 *
	 * Never rejects and never blocks anything: a root that has been deleted or
	 * unmounted since it was recorded simply contributes nothing.
	 */
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			for (const [index, recent] of recents.entries()) {
				if (cancelled) {
					return;
				}
				if (recent.path === selection?.path) {
					continue;
				}
				const sessions = await listSessionsIn(index);
				if (cancelled) {
					return;
				}
				/*
				 * An empty answer is written down like any other. Skipping it left a
				 * root's old rows on screen after its sessions were deleted — and
				 * `openFolder` re-runs this without a reload, so it is reachable in
				 * one page life. Picking one of those rows then asks for a file that
				 * is not there.
				 */
				setStoredByRoot((current) => new Map(current).set(recent.path, sessions));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [recents, selection?.path]);

	/**
	 * Take a stored conversation off the list, keeping the file — ticket 56.
	 *
	 * A rename into `.ade/sessions/archive`, because `listStored` reads a
	 * directory: a file that is not in it is not listed, and nothing about
	 * naming, resuming or the store's shape has to change. It survives a restart
	 * because it is a fact about the filesystem rather than about this window.
	 *
	 * **Archived conversations are not browsable from the app, and that is a
	 * deliberate shortcut.** Archive's job is to get a row off a list; a second
	 * list for reading back the rows you removed is scaffolding for a need nobody
	 * has stated. The folder is plainly named and a file manager reaches it. Add
	 * the Archived group when someone actually goes looking for one.
	 */
	const archiveSession = useCallback(
		async (row: Session) => {
			if (!row.storedPath) {
				return;
			}
			/*
			 * The harness goes first, and that ordering is the whole safety of
			 * this: a session still attached to the file appends to it, and a file
			 * that moves under an open writer is the state `manageable` used to
			 * avoid by refusing outright. `manageable` has already excluded a
			 * running turn and the focused row, so nothing is interrupted here.
			 */
			if (row.live) {
				sessionSet.close(row.id);
			}
			const move = archiveMove(row.storedPath);
			try {
				// Idempotent on both sides: `create_dir_all` does not mind an
				// archive folder that is already there.
				await provider.createFolder(move.folder);
				await provider.rename(move.from, move.to);
			} catch (error) {
				announce(`Could not archive ${row.name}. ${reason(error)}`);
				return;
			}
			setStoredNonce((n) => n + 1);
			announce(`Archived ${row.name}.`);
		},
		[announce, provider]
	);

	/** Delete a stored conversation, once the dialog has been answered. */
	const deleteSession = useCallback(
		async (row: Session) => {
			if (!row.storedPath) {
				return;
			}
			// Same ordering, same reason — see `archiveSession`.
			if (row.live) {
				sessionSet.close(row.id);
			}
			try {
				await provider.deleteEntry(archiveMove(row.storedPath).from);
			} catch (error) {
				announce(`Could not delete ${row.name}. ${reason(error)}`);
				return;
			}
			setStoredNonce((n) => n + 1);
			announce(`Deleted ${row.name}.${provider.deletesToTrash ? ' It is in the trash.' : ''}`);
		},
		[announce, provider]
	);

	/*
	 * `goToWorkspace` was here, and ticket 55 deleted it with its only caller.
	 *
	 * It focused a session in a recent root, or started one if that root had
	 * none — the group header's switch. With the header reduced to a collapse
	 * toggle there is nothing left that goes to a *workspace*: you go to a
	 * conversation, and the workbench follows it. `newSession(at)` covers the
	 * one case the header still has to answer, which is a workspace you have
	 * never talked in.
	 */

	/**
	 * Opening a session, from the navigator or from a search result.
	 *
	 * **Three answers, and the first two are the interesting ones.** A session
	 * already open in this window is simply focused — nothing restarts, nothing is
	 * re-read from disk, and the conversation you left keeps every turn it had.
	 * That is ticket 47, and it is what retired the reload: switching used to mean
	 * writing a note to `localStorage` and reloading the page, which was the only
	 * way to rebind a provider, a harness and a session store that were all
	 * module-level.
	 *
	 * A stored conversation is opened as a session beside the ones already here,
	 * rather than in place of them — in this root, or in another one, which is
	 * ticket 49 and the only part of this that ever needed the reload. The root
	 * is named by its index into the recent list, never by path.
	 */
	const selectSession = useCallback(
		async (picked: Session) => {
			const already = live.sessions.find(
				(open) => open.key === picked.id || (picked.storedPath && open.path === picked.storedPath)
			);
			if (already) {
				sessionSet.focus(already.key);
				return;
			}
			if (!picked.storedPath) {
				return;
			}
			/*
			 * A row in another root re-resolves its index here rather than trusting
			 * the one it was drawn with — ticket 62. `switchIndex` says *whether*
			 * this is elsewhere; `root` says where, and the list is read now.
			 */
			let at: number | undefined;
			if (picked.switchIndex !== undefined) {
				at = picked.root === undefined ? undefined : await locate(picked.root);
				if (at === undefined) {
					announce('That folder is no longer available.');
					return;
				}
			}
			announce(`Opening ${picked.name}.`);
			await sessionSet.open({ requested: picked.storedPath }, at);
		},
		[announce, live.sessions, locate]
	);

	const groups = useMemo(
		() =>
			buildGroups({
				workspace: selection,
				branch,
				recents,
				/*
				 * The live rows, built here because this is the only place holding both
				 * the session objects and the row model. `live` in the dependency list
				 * is what makes a status change redraw them: the collection's identity
				 * changes on every revision, and nothing else about it does.
				 */
				live: live.sessions.map((open) => ({
					id: open.key,
					// Empty means "not known yet" — `buildGroups` fills it from the
					// stored row being opened, or falls back to `New session`.
					name: open.name() ?? '',
					status: open.status(),
					unread: open.snapshot().unread,
					live: true,
					focused: open === live.focused,
					storedPath: open.path,
					// Which group it lands in. Its own root, not the focused one.
					root: open.root?.path,
				})),
				stored: storedByRoot,
			}),
		[branch, live, recents, selection, storedByRoot]
	);

	/**
	 * The ADE menu — the only application menu.
	 *
	 * Settings and About say what they are rather than being absent: a menu item
	 * that will exist is more honest present-and-explained than missing.
	 */
	const adeMenu = useMemo<readonly AdeMenuAction[]>(
		() => [
			{ id: 'new-session', label: 'New session', run: () => void newSession() },
			{ id: 'close-session', label: 'Close session', run: closeSession },
			{ id: 'palette', label: 'Command palette', run: () => setCommandCenterOpen(true) },
			{
				id: 'debug-notification',
				label: 'Debug notification',
				// Kept now that background sessions raise real ones: this is still the
				// only way to look at the surface without waiting for a long turn to
				// end unwatched.
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
		[announce, closeSession, controls.available, controls.close, newSession, notify]
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
					session={session?.name()}
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
						activeId={session?.key ?? ''}
						onSelect={(picked) => void selectSession(picked)}
						onNewSession={(at) => void newSession(at)}
						onChooseFolder={provider.canChooseWorkspace ? () => void openFolder() : undefined}
						onArchive={(picked) => void archiveSession(picked)}
						onDelete={setDeleting}
					/>
					{session ? (
						<AgentChat
							/*
							 * Keyed by session, so the purely visual state — which
							 * completion is highlighted, whether the file drawer is open —
							 * resets on focus rather than leaking between conversations.
							 * Everything that must survive is on the session itself.
							 */
							key={session.key}
							session={session}
							files={fileIds}
							onAnnounce={announce}
							onOpenArtifact={openArtifact}
							onTranscript={(search) => {
								transcriptSearch.current = search;
							}}
							onUndone={tellTheOthers}
						/>
					) : null}
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
						artifacts={pinned.map((id) => artifactRef(id, inputs, browserHosts))}
						activeId={activeArtifact}
						onSelect={setActiveArtifactId}
						onUnpin={unpin}
					>
						{/*
						 * The terminal is mounted for as long as it is *pinned*, not
						 * for as long as it is the tab in front — and hidden rather
						 * than removed the rest of the time.
						 *
						 * `ArtifactView`'s subtree is swapped whole when the active
						 * artifact changes, and unmounting a terminal kills its shell.
						 * Rendering it in there meant every shell in every root died
						 * the moment the user glanced at the file tree, which made
						 * keeping them per root (ticket 31) worth nothing. Unpinning
						 * still kills them, and that is the one place it should.
						 */}
						{pinned.includes(TOOL_ARTIFACTS.terminal.id) ? (
							<div
								className="ide-dock-layer"
								hidden={activeArtifact !== TOOL_ARTIFACTS.terminal.id}
							>
								<TerminalPanel adapter={terminalAdapter} root={selection?.path} />
							</div>
						) : null}
						{/*
						 * One layer per *pinned* browser tab, for the same reason the
						 * terminal has one: unmounting destroys the thing. A page is a
						 * child webview Rust owns, and `ArtifactView`'s subtree is
						 * swapped whole on every tab switch.
						 *
						 * The layer is absolutely positioned and toggled with
						 * `visibility`, never `hidden`. `hidden` would collapse the box
						 * to nothing, and the box's rectangle is what tells Rust where
						 * to paint — a zero rect is a page with no layout, which is the
						 * exact failure hidden mode is designed around.
						 */}
						{browserTabs
							.filter((tab) => pinned.includes(tab.id))
							.map((tab) => (
								<div
									key={tab.id}
									className="ide-browser-layer"
									style={{
										visibility: activeArtifact === tab.id ? 'visible' : 'hidden',
									}}
								>
									<BrowserTab
										id={tab.id}
										adapter={browser}
										initialUrl={tab.url || undefined}
										visible={
											activeArtifact === tab.id && !dockCollapsed && !occluded
										}
										onOpened={noteOpened}
										onFailed={noteFailed}
									/>
								</div>
							))}
						{activeArtifact ? (
							<ArtifactView
								id={activeArtifact}
								provider={provider}
								changesProvider={changesProvider}
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
								pluginState={pluginState}
								onSetPluginEnabled={(id, enabled) => void pluginHost.setEnabled(id, enabled)}
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
						onSelectSession={(picked) => void selectSession(picked)}
						searchTranscript={searchTranscript}
						onClose={closeCommandCenter}
					/>
					{/*
					 * Ticket 56. `delete_entry` moves the file to the trash, so the
					 * wording does not claim the conversation is gone for good — a
					 * dialog that overstates the loss is its own small lie. It still
					 * asks, because an accidental click makes a conversation vanish
					 * from the list and the person clicking does not know where to.
					 */}
					<Confirm
						open={deleting !== undefined}
						title="Delete this conversation?"
						message={`${deleting?.name ?? 'This conversation'} will be removed from the list.${
							provider.deletesToTrash ? ' Its file goes to the trash.' : ''
						}`}
						onCancel={() => setDeleting(undefined)}
						actions={[
							{
								label: 'Delete',
								danger: true,
								run: () => {
									if (deleting) {
										void deleteSession(deleting);
									}
									setDeleting(undefined);
								},
							},
						]}
					/>
					<Confirm
						open={closing !== undefined}
						title="Stop this turn?"
						message={`${
							live.sessions.find((open) => open.key === closing)?.name() ?? 'This session'
						} is mid-turn. Closing it stops the turn.`}
						onCancel={() => setClosing(undefined)}
						actions={[
							{
								label: 'Close and stop',
								danger: true,
								run: () => {
									if (closing) {
										dropSession(closing);
									}
									setClosing(undefined);
								},
							},
						]}
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
