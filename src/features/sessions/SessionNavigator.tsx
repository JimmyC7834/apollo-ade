import { useState } from 'react';

import { manageable, type Session, type SessionStatus, type WorkspaceGroup } from '../../sessions';
import { Icon } from '../../ui';

export interface SessionNavigatorProps {
	readonly groups: readonly WorkspaceGroup[];
	readonly activeId: string;
	readonly onSelect: (session: Session) => void;
	/**
	 * Start a conversation in a workspace — ticket 47, widened by ticket 49.
	 *
	 * **Born inside the group it belongs to**, because picking where a session
	 * goes and making it are one gesture. Every group offers it: the argument is
	 * the group's root *path*, and undefined is the workspace the window is
	 * already in.
	 *
	 * A path rather than an index since ticket 62. An index is a position in a
	 * list that choosing a folder reorders, so one captured when this row was
	 * drawn can name a different folder by the time it is pressed; the controller
	 * resolves the path into an index at that moment instead.
	 *
	 * **It is also the only door into a workspace with nothing in it**, since
	 * ticket 55 took switching off the group header.
	 *
	 * One control, on the header, and ticket 57 made it that. It used to be a
	 * `New session` row *and* a `+` that stood in for the row while the group was
	 * collapsed — two affordances for one action, and the row was a session-shaped
	 * thing in a list of sessions that was not one.
	 */
	readonly onNewSession?: (root?: string) => void;
	/**
	 * Hand this app a folder it has never been given — ticket 49.
	 *
	 * The OS dialog is still the only door a new root comes through, and this is
	 * where it is offered: at the bottom of the list of roots, which is the one
	 * place someone looks when the folder they want is not on it.
	 */
	readonly onChooseFolder?: () => void;
	/**
	 * Take a stored conversation off the list, keeping the file — ticket 56.
	 *
	 * Offered only where `manageable` says so, which is the row's own folder and
	 * a session no harness is attached to.
	 */
	readonly onArchive?: (session: Session) => void;
	/** Delete a stored conversation. Asks first; the file goes to the trash. */
	readonly onDelete?: (session: Session) => void;
}

const STATUS_LABEL: Record<SessionStatus, string> = {
	running: 'Running',
	waiting: 'Waiting for input',
	idle: 'Idle',
	done: 'Done',
};

/**
 * The same four states as a character each, because the strip *is* these
 * characters: collapsed, a conversation is one glyph and nothing else.
 *
 * `~` and `?` are doing work — one says a turn is in flight, the other says it
 * stopped and is waiting on you — and they say it without colour, which is what
 * makes the strip legible to someone who cannot tell the two hues apart.
 */
const STATUS_GLYPH: Record<SessionStatus, string> = {
	running: '~',
	waiting: '?',
	done: '✓',
	idle: '*',
};

/**
 * The navigator belongs to the Chat Workbench and spans only its height.
 *
 * Collapsed it is a 28px strip of status glyphs; expanded it is 264px **over**
 * chat — it never reflows it, which is why it is absolutely positioned rather
 * than a flex sibling.
 *
 * **Collapsed, the strip is the conversations and nothing else.** No group
 * header, no chevron, no "choose folder": a header names a group, and there are
 * no groups at 28px, because grouping is what expanding is *for*. That is also
 * why a collapsed group opens back up while the strip is closed — a group whose
 * sessions were hidden with no header to bring them back would be a
 * conversation the strip had swallowed.
 *
 * The strip is exactly one glyph wide and has no scrollbar, which is what makes
 * it only glyphs: at 32px around a 31px icon column, a pixel of every label ran
 * down its side.
 *
 * **It has no border and no shadow, and it is the chat's own background in both
 * states** (ticket 55). It is meant to read as part of the chat rather than as a
 * panel beside it. Opaque rather than transparent because expanded labels sit
 * above transcript text and have to be readable.
 *
 * Every row is exactly 32px and there are no dividers, no group margins and no
 * rounding on highlights. The active session gets no row background at all: its
 * label brightens, and its glyph goes on saying what its status is.
 */
export function SessionNavigator({
	groups,
	activeId,
	onSelect,
	onNewSession,
	onChooseFolder,
	onArchive,
	onDelete,
}: SessionNavigatorProps) {
	const [expanded, setExpanded] = useState(false);
	const [collapsedGroups, setCollapsedGroups] = useState<readonly string[]>([]);

	return (
		<nav
			className={`ide-navigator${expanded ? ' ide-navigator-expanded' : ''}`}
			aria-label="Sessions"
			onMouseEnter={() => setExpanded(true)}
			onMouseLeave={() => setExpanded(false)}
			// Keyboard users get the same surface: tabbing into any row expands it,
			// and leaving collapses it. Without this the labels are pointer-only.
			onFocusCapture={() => setExpanded(true)}
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					setExpanded(false);
				}
			}}
		>
			{groups.map((group) => {
				const groupCollapsed = collapsedGroups.includes(group.id);
				/*
				 * A group header does one thing: collapse and expand its sessions.
				 *
				 * **It used to also switch roots**, for every group naming a root the
				 * window was not in — a header that is a toggle here and a jump there,
				 * with a comment explaining why it could never be both. Ticket 55
				 * deleted the jump rather than the explanation: picking a session
				 * already moves the window to its folder (ticket 49), so switching from
				 * the header was a second way to do something that works.
				 *
				 * `born` is what survives of `switchIndex` — not a place to go, just
				 * which workspace a new conversation would be born in, as a path.
				 * Undefined is this window's own root, which needs no index.
				 */
				const born = group.switchIndex === undefined ? undefined : group.root;
				return (
					<div key={group.id} className="ide-navigator-group">
						{/*
						 * A row rather than a button, because the `+` is a button and
						 * buttons do not nest — the inner one stops receiving clicks.
						 * Same shape the session rows take in ticket 56.
						 *
						 * Absent rather than hidden while the strip is closed: a header
						 * is a control, and a control nobody can read is one the
						 * keyboard should not stop at either.
						 */}
						{expanded ? (
							<div className="ide-navigator-header">
								<button
									type="button"
									className="ide-navigator-open"
									aria-expanded={!groupCollapsed}
									onClick={() =>
										setCollapsedGroups((current) =>
											current.includes(group.id)
												? current.filter((id) => id !== group.id)
												: [...current, group.id]
										)
									}
								>
									<span className="ide-navigator-icon">
										{groupCollapsed ? (
											/* The workspace's own state, as the glyph of the most
											   urgent thing inside it. Shown only while the group is
											   folded — open, its session rows say it row by row. */
											<span
												className={`ide-navigator-dot ide-status-${dominant(group.sessions)}`}
												aria-hidden={true}
											>
												{STATUS_GLYPH[dominant(group.sessions)]}
											</span>
										) : (
											<Icon name="chevron-down" />
										)}
									</span>
									<span className="ide-navigator-label">
										{group.label}
										{group.branch ? ` · ${group.branch}` : ''}
									</span>
								</button>
								{onNewSession ? (
									<button
										type="button"
										className="ide-navigator-action-button"
										title={`New session in ${group.label}`}
										onClick={() => onNewSession(born)}
									>
										<Icon name="add" />
										<span className="ide-visually-hidden">{`New session in ${group.label}`}</span>
									</button>
								) : null}
							</div>
						) : null}

						{expanded && groupCollapsed
							? null
							: group.sessions.map((session) => (
									/*
									 * A shell around the row rather than the row itself,
									 * because archive and delete are buttons and buttons do
									 * not nest — inside a `<button>` they stop receiving
									 * clicks. The row keeps being one control for opening;
									 * the actions sit beside it.
									 */
									<div key={session.id} className="ide-navigator-row-shell">
										<button
											type="button"
											className="ide-navigator-row"
											aria-current={session.id === activeId ? 'true' : undefined}
											/* Collapsed, the label is clipped to nothing and the glyph
											   is all there is, so the tooltip is the only way to tell
											   one conversation from another without opening the strip. */
											title={`${session.name} — ${STATUS_LABEL[session.status]}`}
											onClick={() => onSelect(session)}
										>
											<span className="ide-navigator-icon">
												<span
													className={`ide-navigator-marker ide-status-${session.status}`}
													aria-hidden={true}
												>
													{STATUS_GLYPH[session.status]}
												</span>
											</span>
											<span className="ide-navigator-label">{session.name}</span>
											{/*
											 * No prototype marking any more, because there is
											 * nothing left to mark: every row is a real
											 * conversation, either the live one or one read
											 * back from `.ade/sessions`. It used to say
											 * "fixture" on anything with `live: false`, which
											 * became a lie the moment those rows came off
											 * disk — and a real session labelled as invented
											 * is a worse error than the one the marking was
											 * put there to prevent.
											 *
											 * Which one has a harness is still shown: the active
											 * session is the one whose label is not muted.
											 */}
											<span className="ide-visually-hidden">
												{`— ${STATUS_LABEL[session.status]}${
													session.unread ? ', unread' : ''
												}`}
											</span>
											<span className="ide-navigator-action">
												{session.unread ? <span className="ide-navigator-unread" /> : null}
											</span>
										</button>
										{/*
										 * Asked once, around both: archive and delete are
										 * offered together or not at all. A row you may
										 * archive but not delete is not a state this has.
										 */}
										{manageable(session) ? (
											<>
												{onArchive ? (
													<button
														type="button"
														className="ide-navigator-action-button"
														onClick={() => onArchive(session)}
													>
														<Icon name="archive" />
														<span className="ide-visually-hidden">{`Archive ${session.name}`}</span>
													</button>
												) : null}
												{onDelete ? (
													<button
														type="button"
														className="ide-navigator-action-button"
														onClick={() => onDelete(session)}
													>
														<Icon name="trash" />
														<span className="ide-visually-hidden">{`Delete ${session.name}`}</span>
													</button>
												) : null}
											</>
										) : null}
									</div>
								))}

					</div>
				);
			})}
			{expanded && onChooseFolder ? (
				<button type="button" className="ide-navigator-row" onClick={onChooseFolder}>
					<span className="ide-navigator-icon">
						<Icon name="root-folder" />
					</span>
					<span className="ide-navigator-label">Choose folder…</span>
				</button>
			) : null}
		</nav>
	);
}

/**
 * What a collapsed workspace shows in place of its rows: the most urgent state
 * inside it, in the order a person would want to be told about them.
 */
function dominant(sessions: readonly Session[]): SessionStatus {
	for (const status of ['waiting', 'running', 'done'] as const) {
		if (sessions.some((session) => session.status === status)) {
			return status;
		}
	}
	return 'idle';
}
