import { useCallback, useState } from 'react';

import type { TerminalAdapter } from '../../terminal';
import { ActionBar, Badge, IconButton, Tabs } from '../../ui';
import { TerminalInstance } from './TerminalInstance';

export interface TerminalPanelProps {
	readonly adapter: TerminalAdapter;
}

interface Session {
	readonly id: string;
	readonly name: string;
	readonly exited: boolean;
}

let counter = 0;

export function TerminalPanel({ adapter }: TerminalPanelProps) {
	const [sessions, setSessions] = useState<readonly Session[]>([]);
	const [activeId, setActiveId] = useState<string | undefined>(undefined);

	const create = useCallback(() => {
		counter += 1;
		const id = `term-${counter}`;
		setSessions((current) => [...current, { id, name: `Shell ${counter}`, exited: false }]);
		setActiveId(id);
	}, []);

	// Unmounting the instance kills the session; nothing to do here but drop it.
	const close = useCallback((id: string) => {
		setSessions((current) => {
			const index = current.findIndex((session) => session.id === id);
			const next = current.filter((session) => session.id !== id);
			setActiveId((active) => (active === id ? (next[index] ?? next[index - 1])?.id : active));
			return next;
		});
	}, []);

	const markExited = useCallback((id: string) => {
		// The tab stays open: the user may still want to read the output.
		setSessions((current) =>
			current.map((session) => (session.id === id ? { ...session, exited: true } : session))
		);
	}, []);

	const active = sessions.find((session) => session.id === activeId);

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
				{sessions.length > 0 ? (
					<Tabs
						label="Terminals"
						items={sessions.map((session) => ({ id: session.id, label: session.name }))}
						activeId={activeId}
						onSelect={setActiveId}
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

			{sessions.length === 0 ? (
				<p className="ide-terminal-empty">No terminals open.</p>
			) : (
				sessions.map((session) => (
					<TerminalInstance
						key={session.id}
						adapter={adapter}
						id={session.id}
						active={session.id === activeId}
						onExit={markExited}
					/>
				))
			)}
		</section>
	);
}
