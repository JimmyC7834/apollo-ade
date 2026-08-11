import { useState } from 'react';

import type { Session, SessionStatus, WorkspaceGroup } from '../../sessions';
import { Icon } from '../../ui';

export interface SessionNavigatorProps {
	readonly groups: readonly WorkspaceGroup[];
	readonly activeId: string;
	readonly onSelect: (session: Session) => void;
	/** Switch to a workspace by its index in the recent list. Rust owns that list. */
	readonly onSwitchWorkspace: (index: number) => void;
}

const STATUS_LABEL: Record<SessionStatus, string> = {
	running: 'Running',
	waiting: 'Waiting for input',
	idle: 'Idle',
	done: 'Done',
};

/**
 * The navigator belongs to the Chat Workbench and spans only its height.
 *
 * Collapsed it is 32px of status markers floating over chat with no background.
 * Expanded it is 264px **over** chat — it never reflows it, which is why it is
 * absolutely positioned rather than a flex sibling. Expansion is what restores
 * a solid surface, because that is the only state where labels have to be read
 * against whatever is underneath.
 *
 * Every row is exactly 32px and there are no dividers, no group margins and no
 * rounding on highlights. The active session gets no row background at all —
 * its marker grows from 12px to 18px instead.
 */
export function SessionNavigator({
	groups,
	activeId,
	onSelect,
	onSwitchWorkspace,
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
				 * A group is either a place you are (collapse its sessions) or a
				 * place you can go (switch to it). Never both — a header that
				 * collapses on click and switches on double-click makes switching
				 * roots something you can do by accident.
				 */
				const switchTo = group.switchIndex;
				return (
					<div key={group.id} className="ide-navigator-group">
						<button
							type="button"
							className="ide-navigator-header"
							aria-expanded={switchTo === undefined ? !groupCollapsed : undefined}
							title={switchTo === undefined ? undefined : `Switch to ${group.label}`}
							onClick={() => {
								if (switchTo !== undefined) {
									onSwitchWorkspace(switchTo);
									return;
								}
								setCollapsedGroups((current) =>
									current.includes(group.id)
										? current.filter((id) => id !== group.id)
										: [...current, group.id]
								);
							}}
						>
							<span className="ide-navigator-icon">
								{switchTo !== undefined ? (
									<Icon name="root-folder" />
								) : groupCollapsed ? (
									/* Workspace status dots appear only when the group is
									   collapsed — expanded, the session rows say it. */
									<span
										className={`ide-navigator-dot ide-status-${dominant(group.sessions)}`}
									/>
								) : (
									<Icon name="chevron-down" />
								)}
							</span>
							<span className="ide-navigator-label">
								{group.label}
								{group.branch ? ` · ${group.branch}` : ''}
							</span>
							{group.fixture ? <span className="ide-navigator-fixture">fixture</span> : null}
							{switchTo === undefined ? null : (
								<span className="ide-visually-hidden">— switch to this workspace</span>
							)}
						</button>

						{groupCollapsed
							? null
							: group.sessions.map((session) => (
									<button
										key={session.id}
										type="button"
										className="ide-navigator-row"
										aria-current={session.id === activeId ? 'true' : undefined}
										onClick={() => onSelect(session)}
									>
										<span className="ide-navigator-icon">
											<span
												className={`ide-navigator-marker ide-status-${session.status}${
													session.id === activeId ? ' ide-navigator-marker-active' : ''
												}`}
											/>
										</span>
										<span className="ide-navigator-label">{session.name}</span>
										{/*
										 * The prototype marking, in the model and on the
										 * screen. A fixture row must never be mistakable
										 * for a session with a harness behind it.
										 */}
										{session.live ? null : (
											<span className="ide-navigator-fixture">fixture</span>
										)}
										<span className="ide-visually-hidden">
											{`— ${STATUS_LABEL[session.status]}${
												session.unread ? ', unread' : ''
											}${session.live ? '' : ', prototype fixture'}`}
										</span>
										<span className="ide-navigator-action">
											{session.unread ? <span className="ide-navigator-unread" /> : null}
										</span>
									</button>
								))}
					</div>
				);
			})}
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
