// Agent Chat: the primary workbench mode. It owns the transcript and the live
// run; the provider owns the lifecycle. Nothing here knows how events are
// produced, so swapping the deterministic provider for a real model is a change
// to `agent.ts` alone.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentEvent, AgentProvider, AgentRun } from '../../agent';
import { Icon, Overlay } from '../../ui';

type Part =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'activity'; readonly label: string; readonly detail?: string }
	| {
			readonly kind: 'approval';
			readonly label: string;
			readonly detail: string;
			readonly state: 'pending' | 'approved' | 'skipped';
	  };

interface Turn {
	readonly id: number;
	readonly prompt: string;
	readonly parts: readonly Part[];
	readonly status: 'running' | 'complete' | 'cancelled';
}

export interface AgentChatProps {
	readonly provider: AgentProvider;
	/** Routed to the workbench live region for state changes worth hearing. */
	readonly onAnnounce?: (message: string) => void;
}

/** Fold one event into the running turn. Text chunks merge; the rest append. */
function applyEvent(turn: Turn, event: AgentEvent): Turn {
	if (event.kind === 'complete' || event.kind === 'cancelled') {
		return { ...turn, status: event.kind === 'complete' ? 'complete' : 'cancelled' };
	}
	if (event.kind === 'text') {
		const last = turn.parts.at(-1);
		return {
			...turn,
			parts:
				last?.kind === 'text'
					? [...turn.parts.slice(0, -1), { kind: 'text', text: last.text + event.text }]
					: [...turn.parts, { kind: 'text', text: event.text }],
		};
	}
	if (event.kind === 'activity') {
		return { ...turn, parts: [...turn.parts, event] };
	}
	return { ...turn, parts: [...turn.parts, { ...event, state: 'pending' }] };
}

/** The transcript as plain text, for the accessible-transcript dialog. */
function asPlainText(turns: readonly Turn[]): string {
	return turns
		.map((turn) => {
			const body = turn.parts.map((part) =>
				part.kind === 'text'
					? part.text
					: part.kind === 'activity'
						? `\n[tool] ${part.label}${part.detail ? ` — ${part.detail}` : ''}\n`
						: `\n[approval] ${part.label} — ${part.detail} (${part.state})\n`
			);
			return `You: ${turn.prompt}\n\nAgent: ${body.join('')}\n[${turn.status}]`;
		})
		.join('\n\n———\n\n');
}

export function AgentChat({ provider, onAnnounce }: AgentChatProps) {
	const [turns, setTurns] = useState<readonly Turn[]>([]);
	const [prompt, setPrompt] = useState('');
	const [running, setRunning] = useState(false);
	const [awaitingApproval, setAwaitingApproval] = useState(false);
	const [transcriptOpen, setTranscriptOpen] = useState(false);

	const runRef = useRef<AgentRun>(null);
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const logRef = useRef<HTMLDivElement>(null);

	// A chat that does not follow its own stream is unreadable, so the log is
	// pinned to the bottom as content arrives.
	useEffect(() => {
		const log = logRef.current;
		if (log) {
			log.scrollTop = log.scrollHeight;
		}
	}, [turns]);

	// A run outliving its view would keep emitting into dead state.
	useEffect(() => () => runRef.current?.cancel(), []);

	const send = useCallback(() => {
		const text = prompt.trim();
		if (!text || running) {
			return;
		}
		const turn: Turn = { id: Date.now(), prompt: text, parts: [], status: 'running' };
		setTurns((current) => [...current, turn]);
		setPrompt('');
		setRunning(true);

		runRef.current = provider.start(text, (event) => {
			setTurns((current) =>
				current.map((item) => (item.id === turn.id ? applyEvent(item, event) : item))
			);
			if (event.kind === 'approval') {
				setAwaitingApproval(true);
				onAnnounce?.(`Approval required: ${event.label}`);
			} else if (event.kind === 'complete' || event.kind === 'cancelled') {
				setRunning(false);
				setAwaitingApproval(false);
				runRef.current = null;
				onAnnounce?.(event.kind === 'complete' ? 'Agent finished' : 'Agent stopped');
				// The composer is where the next action starts; a keyboard user
				// should not have to find their way back to it.
				promptRef.current?.focus();
			}
		});
	}, [onAnnounce, prompt, provider, running]);

	const resolve = useCallback(
		(approved: boolean) => {
			setTurns((current) =>
				current.map((turn) => ({
					...turn,
					parts: turn.parts.map((part) =>
						part.kind === 'approval' && part.state === 'pending'
							? { ...part, state: approved ? 'approved' : 'skipped' }
							: part
					),
				}))
			);
			setAwaitingApproval(false);
			onAnnounce?.(approved ? 'Approved. Continuing.' : 'Skipped.');
			runRef.current?.resolveApproval(approved);
		},
		[onAnnounce]
	);

	return (
		<div className="ide-agent">
			<div
				className="ide-agent-log"
				ref={logRef}
				role="log"
				aria-live="polite"
				aria-label="Agent transcript"
				tabIndex={0}
			>
				{turns.length === 0 ? (
					<p className="ide-agent-placeholder">
						Ask the agent to do something. Enter sends, Shift+Enter adds a newline.
					</p>
				) : null}

				{turns.map((turn) => (
					<article className="ide-agent-turn" key={turn.id}>
						<p className="ide-agent-prompt">{turn.prompt}</p>
						{turn.parts.map((part, index) =>
							part.kind === 'text' ? (
								<p className="ide-agent-text" key={index}>
									{part.text}
								</p>
							) : part.kind === 'activity' ? (
								<p className="ide-agent-activity" key={index}>
									<Icon name="tools" />
									<span>{part.label}</span>
									{part.detail ? (
										<span className="ide-agent-activity-detail">{part.detail}</span>
									) : null}
								</p>
							) : (
								<div
									className="ide-agent-approval"
									key={index}
									role="group"
									aria-label={`Approval: ${part.label}`}
								>
									<p className="ide-agent-approval-title">{part.label}</p>
									<p className="ide-agent-approval-detail">{part.detail}</p>
									{part.state === 'pending' ? (
										<div className="ide-agent-approval-actions">
											<button
												type="button"
												className="ide-button"
												onClick={() => resolve(true)}
											>
												Continue
											</button>
											<button
												type="button"
												className="ide-button"
												onClick={() => resolve(false)}
											>
												Skip
											</button>
										</div>
									) : (
										<p className="ide-agent-approval-state">
											{part.state === 'approved' ? 'Approved' : 'Skipped'}
										</p>
									)}
								</div>
							)
						)}
						{turn.status === 'cancelled' ? (
							<p className="ide-agent-status">Stopped.</p>
						) : null}
					</article>
				))}
			</div>

			<form
				className="ide-agent-composer"
				onSubmit={(event) => {
					event.preventDefault();
					send();
				}}
			>
				<textarea
					className="ide-agent-input"
					ref={promptRef}
					rows={3}
					value={prompt}
					placeholder="Ask the agent…"
					aria-label="Prompt"
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							send();
						}
					}}
				/>
				<div className="ide-agent-composer-actions">
					<button
						type="button"
						className="ide-button"
						onClick={() => setTranscriptOpen(true)}
						disabled={turns.length === 0}
					>
						Plain text transcript
					</button>
					{running ? (
						<button
							type="button"
							className="ide-button ide-button-danger"
							onClick={() => runRef.current?.cancel()}
						>
							Stop
						</button>
					) : (
						<button type="submit" className="ide-button" disabled={!prompt.trim()}>
							Send
						</button>
					)}
				</div>
				{awaitingApproval ? (
					<p className="ide-agent-status">Waiting for your approval above.</p>
				) : null}
			</form>

			<Overlay
				open={transcriptOpen}
				title="Agent transcript"
				onClose={() => setTranscriptOpen(false)}
			>
				<pre className="ide-agent-plain">{asPlainText(turns)}</pre>
				<button type="button" className="ide-button" onClick={() => setTranscriptOpen(false)}>
					Close
				</button>
			</Overlay>
		</div>
	);
}
