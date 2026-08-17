import { useCallback, useState } from 'react';

import { neighbourId } from '../../ids';
import { activeIn, terminalsIn, type TerminalAdapter, type TerminalSession } from '../../terminal';
import { ActionBar, Badge, IconButton, Tabs } from '../../ui';
import { TerminalInstance } from './TerminalInstance';

export interface TerminalPanelProps {
	readonly adapter: TerminalAdapter;
	/** The folder the window is in. Shells are opened in it and stay in it. */
	readonly root?: string;
}

let counter = 0;

export function TerminalPanel({ adapter, root }: TerminalPanelProps) {
	const [sessions, setSessions] = useState<readonly TerminalSession[]>([]);
	/*
	 * Remembered, not authoritative: `activeIn` decides what is on screen, so a
	 * root change moves the tab strip without this having to be reset — and a
	 * shell in the folder just left cannot end up selected in this one.
	 */
	const [remembered, setRemembered] = useState<string | undefined>(undefined);
	const shells = terminalsIn(sessions, root);
	const activeId = activeIn(sessions, root, remembered);

	const create = useCallback(() => {
		counter += 1;
		const id = `term-${counter}`;
		setSessions((current) => [...current, { id, name: `Shell ${counter}`, exited: false, root }]);
		setRemembered(id);
	}, [root]);

	// Unmounting the instance kills the session; nothing to do here but drop it.
	const close = useCallback(
		(id: string) => {
			setSessions((current) => {
				setRemembered((active) =>
					active === id ? neighbourId(terminalsIn(current, root), id) : active
				);
				return current.filter((session) => session.id !== id);
			});
		},
		[root]
	);

	const markExited = useCallback((id: string) => {
		// The tab stays open: the user may still want to read the output.
		setSessions((current) =>
			current.map((session) => (session.id === id ? { ...session, exited: true } : session))
		);
	}, []);

	const active = shells.find((session) => session.id === activeId);

	return (
		/*
		 * No `Pane` wrapper: a 35px pane header above a 30px tab bar would
		 * spend a third of the panel's default height on chrome. VS Code puts
		 * the title, the tabs, and the actions in one row, so this bar is the
		 * header, and the region is labelled here instead.
		 */
		<section className="ide-terminal-panel" aria-label="Terminal">
			<div className="ide-terminal-bar">
				<h2 className="ide-pane-title ide-terminal-title">Terminal</h2>
				{shells.length > 0 ? (
					<Tabs
						label="Terminals"
						items={shells.map((session) => ({ id: session.id, label: session.name }))}
						activeId={activeId}
						onSelect={setRemembered}
						onClose={close}
						variant="panel"
					/>
				) : null}
				<ActionBar label="Terminal actions">
					{active?.exited ? <Badge label="Exited" title="Shell has exited" /> : null}
					{!adapter.isNative ? (
						<Badge label="Echo" title="Browser fixture: input is echoed, not run" />
					) : null}
					<IconButton icon="add" label="New terminal" onClick={create} />
					<IconButton
						icon="trash"
						label="Kill terminal"
						disabled={!activeId}
						onClick={() => activeId && close(activeId)}
					/>
				</ActionBar>
			</div>

			{shells.length === 0 ? (
				<p className="ide-terminal-empty">No terminals open.</p>
			) : null}
			{/*
			 * Every shell is rendered, not just this folder's: unmounting an
			 * instance kills its process, and a shell in another root is still
			 * running for whoever left it there. The ones that do not belong
			 * here are simply not active, so they are hidden.
			 */}
			{sessions.map((session) => (
				<TerminalInstance
					key={session.id}
					adapter={adapter}
					id={session.id}
					active={session.id === activeId}
					onExit={markExited}
				/>
			))}
		</section>
	);
}
