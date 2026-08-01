// Agent Chat: the primary workbench mode. It owns the transcript and the live
// run; the provider owns the lifecycle. Nothing here knows how events are
// produced, so swapping the deterministic provider for a real model is a change
// to `agent.ts` alone.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentProvider, AgentRun } from '../../agent';
import { Icon, Overlay } from '../../ui';
import {
	applyEvent,
	approvalLabel,
	asPlainText,
	canAnswer,
	resolveApproval,
	type Turn,
} from './transcript';

export interface AgentChatProps {
	readonly provider: AgentProvider;
	/** Routed to the workbench live region for state changes worth hearing. */
	readonly onAnnounce?: (message: string) => void;
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
			setTurns((current) => resolveApproval(current, approved));
			setAwaitingApproval(false);
			onAnnounce?.(approved ? 'Approved. Continuing.' : 'Skipped.');
			runRef.current?.resolveApproval(approved);
			// The button that was just clicked is about to be replaced by static
			// text, and focus would fall to `body` — for the rest of the run, since
			// nothing else reclaims it until the run ends. Send it where the run
			// ending sends it too, so answering never strands a keyboard user.
			promptRef.current?.focus();
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
									// Carries its own outcome: navigating group to group
									// should not require reading into each one to find
									// out which questions are still being asked.
									aria-label={`Approval: ${part.label} — ${approvalLabel(
										part.state,
										turn.status
									)}`}
								>
									<p className="ide-agent-approval-title">{part.label}</p>
									<p className="ide-agent-approval-detail">{part.detail}</p>
									{canAnswer(part, turn) ? (
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
											{approvalLabel(part.state, turn.status)}
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
