import { useCallback, useState } from 'react';

import type { TerminalAdapter } from '../../terminal';
import { ActionBar, Badge, IconButton, Tabs } from '../../ui';
import { TerminalInstance } from './TerminalInstance';

export interface TerminalPanelProps {
	readonly adapter: TerminalAdapter;
	/** Working directory for new shells; the selected workspace root. */
	readonly cwd: string | undefined;
}

interface Session {
	readonly id: string;
	readonly name: string;
	readonly exited: boolean;
}

let counter = 0;

export function TerminalPanel({ adapter, cwd }: TerminalPanelProps) {
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
		<div className="ide-terminal-panel">
			<div className="ide-terminal-bar">
				{sessions.length > 0 ? (
					<Tabs
						label="Terminals"
						items={sessions.map((session) => ({ id: session.id, label: session.name }))}
						activeId={activeId}
						onSelect={setActiveId}
						onClose={close}
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
				<p className="ide-tree-empty">No terminals. Use New terminal to start one.</p>
			) : (
				sessions.map((session) => (
					<TerminalInstance
						key={session.id}
						adapter={adapter}
						id={session.id}
						active={session.id === activeId}
						cwd={cwd}
						onExit={markExited}
					/>
				))
			)}
		</div>
	);
}
