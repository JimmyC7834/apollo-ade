// Agent Chat: the primary workbench mode. It owns the transcript and the live
// run; the provider owns the lifecycle. Nothing here knows how events are
// produced, so swapping the deterministic provider for a real model is a change
// to `agent.ts` alone.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { parseCommandArgs } from '@earendil-works/pi-agent-core';

import type { AgentEvent, AgentProvider, AgentRun } from '../../agent';
import { parseCommand, SLASH_COMMANDS } from '../../agent/commands';
import { complete } from '../../agent/completion';
import { allTemplates, onTemplatesChange, templateCommands } from '../../agent/promptTemplates';
import { pressure } from '../../agent/compaction';
import { activateProfile, activeProfile, listProfiles, type Profile } from '../../agent/profile';
import { loadProfileFiles, profileSources } from '../../agent/profileFiles';
import { delegable } from '../../agent/subagent';
import { allSkills, permittedSkills, skillList } from '../../agent/skills';
import { userTools } from '../../agent/userTools';
import { Icon, Overlay } from '../../ui';
import { OTHER } from '../../agent/ask';
import { thinkingUnavailable } from '../../agent/models';
import { liveStatus, type SessionStatus } from '../../sessions';
import { ComposerBar } from './ComposerBar';
import { ContextExplorer } from './ContextExplorer';
import { withAttachments } from './composer';
import { EventChip } from './EventChip';
import { Markdown } from './Markdown';
import { ProfileModal } from './ProfileModal';
import { compactResult, referencesMarkdown, toolReferences } from './references';
import {
	answerQuestion,
	applyEvent,
	approvalLabel,
	asPlainText,
	canAnswer,
	questionLabel,
	queuedLabel,
	resolveApproval,
	searchTranscript,
	formatCost,
	sessionCost,
	toolLabel,
	turnCost,
	type Part,
	type QuestionPart,
	type TranscriptHit,
	type Turn,
	type Usage,
} from './transcript';

export interface AgentChatProps {
	readonly provider: AgentProvider;
	/**
	 * Every file in the workspace, root-relative, for `@` — ticket 27.
	 *
	 * Passed in rather than read from a workspace provider, because this
	 * component has never held one and giving it one to complete a filename
	 * would put the filesystem seam inside the chat. The controller already has
	 * the tree; this is the list it drew the explorer from.
	 */
	readonly files?: readonly string[];
	/** Routed to the workbench live region for state changes worth hearing. */
	readonly onAnnounce?: (message: string) => void;
	/**
	 * Report the live session's state upward, for the Session Navigator.
	 *
	 * A callback rather than lifting `running`/`awaiting` into the controller:
	 * those are this component's own working state, and the navigator wants one
	 * derived answer, not three raw flags it would have to combine correctly.
	 * `name` is the first prompt, which is the only thing about a session that
	 * is naturally a name.
	 */
	readonly onSession?: (state: {
		readonly status: SessionStatus;
		readonly name: string | undefined;
	}) => void;
	/**
	 * Open or activate an artifact, by id — an artifact reference was clicked.
	 *
	 * The chat resolves the reference (it has the file list); the controller
	 * decides where the thing is shown, which is the split every other opening in
	 * this app already follows.
	 */
	readonly onOpenArtifact?: (id: string) => void;
	/**
	 * Hand the palette a way to search this transcript — ticket 44.
	 *
	 * A **function**, handed over once, rather than the turns themselves. The
	 * transcript changes on every streamed chunk, and lifting it into the
	 * controller would re-render the whole workbench at that rate to serve a
	 * surface that is closed almost all of the time.
	 */
	readonly onTranscript?: (search: (term: string) => readonly TranscriptHit[]) => void;
}

/**
 * A question the agent asked, with the free-text box that is always there.
 *
 * Its own component because it is the only part that holds state between render
 * and answer — what is ticked, and what has been typed. Keeping that inside
 * `PartView` would put a `useState` behind an `if`, and the hook rules would
 * make every other part pay for it.
 *
 * **The box is unconditional, and it is not one of the options.** A model that
 * could choose to omit it would, and the case it exists for is the one the model
 * did not think of — which is the reason it is asking rather than deciding. It
 * is also not a fifth radio button: picking "Other" and then typing is two
 * actions where one will do, and a typed answer is unambiguous on its own.
 */
function QuestionView({
	part,
	turn,
	onAnswer,
}: {
	readonly part: QuestionPart;
	readonly turn: Turn;
	readonly onAnswer: (chosen: readonly string[]) => void;
}) {
	const [picked, setPicked] = useState<readonly string[]>([]);
	const [other, setOther] = useState('');

	const open = canAnswer(part, turn);
	const written = other.trim();
	// The typed answer is labelled where the model reads it, because a bare
	// string among the option labels is indistinguishable from a chosen one —
	// and the distinction is the point of offering the box.
	const chosen = written ? [...picked, `${OTHER}: ${written}`] : picked;

	const toggle = (option: string) =>
		setPicked((current) =>
			part.multiSelect
				? current.includes(option)
					? current.filter((item) => item !== option)
					: [...current, option]
				: [option]
		);

	return (
		<div
			className="ide-agent-approval"
			role="group"
			aria-label={`Question: ${part.question} — ${questionLabel(part, turn.status)}`}
		>
			<p className="ide-agent-approval-title">{part.question}</p>
			{open ? (
				<>
					<ul className="ide-agent-question-options">
						{part.options.map((option) => (
							<li key={option}>
								<label>
									<input
										// A radio group per question, so two questions in one
										// transcript never share a selection.
										type={part.multiSelect ? 'checkbox' : 'radio'}
										name={`question-${part.id}`}
										checked={picked.includes(option)}
										onChange={() => toggle(option)}
									/>
									<span>{option}</span>
								</label>
							</li>
						))}
					</ul>
					<label className="ide-agent-question-other">
						<span>{OTHER}</span>
						<input
							type="text"
							className="ide-agent-question-text"
							value={other}
							placeholder="Write your own answer…"
							onChange={(event) => setOther(event.target.value)}
						/>
					</label>
					<div className="ide-agent-approval-actions">
						<button
							type="button"
							className="ide-button"
							// Nothing ticked and nothing typed is not an answer. Sending it
							// would resolve the tool with an empty list, which it reports to
							// the model as "the user did not answer" — true, but the user
							// would have thought they had.
							disabled={chosen.length === 0}
							onClick={() => onAnswer(chosen)}
						>
							Answer
						</button>
					</div>
				</>
			) : (
				<p className="ide-agent-approval-state">{questionLabel(part, turn.status)}</p>
			)}
		</div>
	);
}

/**
 * One transcript part.
 *
 * Extracted from the map that used to render three kinds inline, because
 * twelve kinds inside JSX is where a rule about who can answer a question
 * stops being reviewable — which is the mistake `transcript.ts` exists to
 * prevent.
 */
function PartView({
	part,
	turn,
	files,
	onResolve,
	onAnswer,
	onOpenArtifact,
}: {
	readonly part: Part;
	readonly turn: Turn;
	readonly files: readonly string[];
	readonly onResolve: (approved: boolean) => void;
	readonly onAnswer: (chosen: readonly string[]) => void;
	readonly onOpenArtifact?: (id: string) => void;
}) {
	// The agent's prose: unboxed Markdown, no heading and no avatar. Who said it
	// is carried by the turn's visually-hidden speaker label — see the log below.
	if (part.kind === 'text') {
		return (
			<Markdown files={files} onOpenArtifact={onOpenArtifact}>
				{part.text}
			</Markdown>
		);
	}

	if (part.kind === 'thinking') {
		// A chip like every other event, and collapsed for the same reason it
		// always was: reasoning is long and usually noise, so the answer stays the
		// thing you read.
		return (
			<EventChip icon="lightbulb" label="Thinking">
				<p className="ide-chip-text">{part.text}</p>
			</EventChip>
		);
	}

	if (part.kind === 'tool') {
		const status = toolLabel(part, turn.status);
		/*
		 * The references this call earned, built from event data — the harness
		 * writes them, the model never does. Rendered through the same Markdown
		 * path an agent's prose goes through, so there is one implementation of
		 * what an artifact link is and one place it can break.
		 */
		const references = referencesMarkdown(toolReferences(part));
		return (
			<EventChip
				icon="tools"
				label={part.name}
				result={compactResult(part.output) ?? status}
				state={part.state}
				// Carries its own outcome, so moving chip to chip does not require
				// reading into each one to find out how it ended.
				ariaLabel={`Tool: ${part.name} — ${status}`}
			>
				<p className="ide-chip-input">{JSON.stringify(part.input)}</p>
				{part.output ? <pre className="ide-chip-output">{part.output}</pre> : null}
				{references ? (
					<Markdown files={files} onOpenArtifact={onOpenArtifact}>
						{references}
					</Markdown>
				) : null}
			</EventChip>
		);
	}

	/*
	 * Three kinds are deliberately not chips, and the rule is what they are for
	 * rather than what they are.
	 *
	 * A chip is a record of something that happened, which is why it can be
	 * collapsed to one row: nothing is owed. An approval and a question are the
	 * opposite — the run is stopped until you answer, and an answer behind a
	 * disclosure is an answer nobody gives. An error is the same shape: it is
	 * something to act on, so it is not muted like activity is.
	 */
	if (part.kind === 'error') {
		// `role="alert"` would interrupt whatever the live region is already
		// reading. The log is `aria-live="polite"` and announces this anyway.
		return (
			<p className="ide-agent-error">
				<Icon name="warning" />
				<span>{part.message}</span>
			</p>
		);
	}

	/*
	 * Compaction changes what the *model* sees; the transcript above still shows
	 * every message. So the summary is not decoration — it is the only record of
	 * what the agent still knows, and the place to look when it later forgets
	 * something. Collapsed rather than hidden, and the history above is left
	 * fully legible: dimming it would imply discarded.
	 *
	 * The count is the size before compacting, not the amount saved. It used to
	 * say "to save {tokensBefore} tokens", which overstated it by whatever was
	 * retained — roughly 20k, every time.
	 */
	if (part.kind === 'compacted') {
		return (
			<EventChip
				icon="archive"
				label="Summarised earlier messages"
				result={`${part.tokensBefore.toLocaleString()} tokens before`}
			>
				<p className="ide-chip-text">{part.summary}</p>
			</EventChip>
		);
	}

	if (part.kind === 'question') {
		return <QuestionView part={part} turn={turn} onAnswer={onAnswer} />;
	}

	return (
		<div
			className="ide-agent-approval"
			role="group"
			aria-label={`Approval: ${part.label} — ${approvalLabel(part.state, turn.status)}`}
		>
			<p className="ide-agent-approval-title">{part.label}</p>
			<p className="ide-agent-approval-detail">{part.detail}</p>
			{canAnswer(part, turn) ? (
				<div className="ide-agent-approval-actions">
					<button type="button" className="ide-button" onClick={() => onResolve(true)}>
						Continue
					</button>
					<button type="button" className="ide-button" onClick={() => onResolve(false)}>
						Skip
					</button>
				</div>
			) : (
				<p className="ide-agent-approval-state">{approvalLabel(part.state, turn.status)}</p>
			)}
		</div>
	);
}

/**
 * The turn's footer: tokens in, out, and how full the context now is.
 *
 * The share is shown only when the model's real context window is known —
 * listed in `CONTEXT_WINDOWS` or given by env var. `41,830 context` means very
 * little to a reader; `86% context` means something — but only if the
 * denominator is true, so an unknown window keeps the bare count rather than
 * inventing a percentage from a guess.
 *
 * Cost follows the same rule and for the same reason: a model whose rates
 * nobody has shows no cost at all, rather than `$0.00`. The breakdown is on the
 * title, not in the line — four figures on every turn is what the token counts
 * already prove nobody reads, and cache reads are the only one worth splitting
 * out when they matter.
 */
function UsageView({ usage }: { readonly usage: Usage }) {
	const meter = pressure(usage.contextTokens, usage.contextWindow);
	const spent = turnCost(usage);
	const cost = usage.cost;
	return (
		<p className={meter?.warn ? 'ide-agent-usage ide-agent-usage-warn' : 'ide-agent-usage'}>
			{usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out ·{' '}
			{meter
				? `${meter.percent}% context`
				: `${usage.contextTokens.toLocaleString()} context`}
			{spent !== undefined && cost ? (
				<>
					{' · '}
					<span
						title={
							`input ${formatCost(cost.input)} · output ${formatCost(cost.output)} · ` +
							`cache read ${formatCost(cost.cacheRead)} · cache write ${formatCost(cost.cacheWrite)}`
						}
					>
						{formatCost(spent)}
					</span>
				</>
			) : null}
			{meter?.warn ? ' · run /compact' : null}
		</p>
	);
}

export function AgentChat({
	provider,
	files = [],
	onAnnounce,
	onSession,
	onOpenArtifact,
	onTranscript,
}: AgentChatProps) {
	const [turns, setTurns] = useState<readonly Turn[]>([]);
	const [prompt, setPrompt] = useState('');
	const [running, setRunning] = useState(false);
	const [awaiting, setAwaiting] = useState(false);
	const [transcriptOpen, setTranscriptOpen] = useState(false);
	// Tracked separately from `running` because compaction cannot be stopped —
	// pi's `compact()` takes no abort signal — so the Stop button must be gone
	// rather than present and inert.
	const [compacting, setCompacting] = useState(false);
	/**
	 * Why the last thing you typed did not go anywhere.
	 *
	 * Composer state rather than a transcript part, because *nothing happened* —
	 * a refused command is not an event in the conversation, and writing one into
	 * the transcript would make the record claim it was. The typed text is kept
	 * with it, so the answer to the notice is to press Enter again once the
	 * condition it names has changed.
	 */
	const [notice, setNotice] = useState<string>();
	/** Which completion is selected, and whether Escape has closed the menu. */
	const [picked, setPicked] = useState(0);
	const [menuOpen, setMenuOpen] = useState(true);
	/**
	 * Draft attachments — ticket 42. Root-relative paths, in the order added.
	 *
	 * Draft, and that is the whole model: they belong to the message being
	 * written, not to the conversation, so they clear when it is sent and a chip
	 * can be taken off before it goes anywhere. What they become on the way out is
	 * `withAttachments`' business.
	 */
	const [attachments, setAttachments] = useState<readonly string[]>([]);
	const [explorerOpen, setExplorerOpen] = useState(false);
	/** A file is over the composer right now — the border and surface say so. */
	const [dragging, setDragging] = useState(false);
	/**
	 * The profile modal — ticket 43. A wrapper object rather than a bare
	 * `Profile | undefined`, because *undefined* is a meaningful value here: it
	 * is Create. The wrapper's presence is "open" and its field is "which".
	 */
	const [editing, setEditing] = useState<{ readonly profile?: Profile }>();

	/** What the conversation has cost, over the turns that reported a price. */
	const spent = useMemo(() => sessionCost(turns), [turns]);

	/*
	 * `awaiting` covers an approval and a question alike: both stop the run dead
	 * until the user answers, which is what "waiting for input" means. Reporting
	 * it separately from `running` is the whole point — see `liveStatus`.
	 */
	useEffect(() => {
		onSession?.({
			status: liveStatus({ running: running || compacting, blocked: awaiting, turns: turns.length }),
			name: turns[0]?.prompt,
		});
	}, [onSession, running, compacting, awaiting, turns]);

	/*
	 * The turns, for the palette to search without subscribing to them. A ref
	 * because the search reads whatever is current at the moment it is called, and
	 * a ref is the one thing whose identity does not change when it does.
	 */
	const turnsRef = useRef(turns);
	turnsRef.current = turns;
	const search = useCallback(
		(term: string) => searchTranscript(turnsRef.current, term),
		[]
	);
	useEffect(() => onTranscript?.(search), [onTranscript, search]);

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

	/**
	 * Open a turn and return the sink its events go into.
	 *
	 * Shared by sending and by `/compact`, because both produce something the
	 * user reads in the transcript. Only one of them has a run to cancel.
	 */
	const beginTurn = useCallback(
		(label: string) => {
			const turn: Turn = { id: Date.now(), prompt: label, parts: [], status: 'running' };
			setTurns((current) => [...current, turn]);
			setRunning(true);

			return (event: AgentEvent) => {
				setTurns((current) =>
					current.map((item) => (item.id === turn.id ? applyEvent(item, event) : item))
				);
				if (event.kind === 'approval') {
					setAwaiting(true);
					onAnnounce?.(`Approval required: ${event.name}`);
				} else if (event.kind === 'question') {
					setAwaiting(true);
					onAnnounce?.(`The agent asked: ${event.question}`);
				} else if (event.kind === 'complete' || event.kind === 'cancelled') {
					setRunning(false);
					setCompacting(false);
					setAwaiting(false);
					runRef.current = null;
					onAnnounce?.(event.kind === 'complete' ? 'Agent finished' : 'Agent stopped');
					// The composer is where the next action starts; a keyboard user
					// should not have to find their way back to it.
					promptRef.current?.focus();
				}
			};
		},
		[onAnnounce]
	);

	/** Refuse, visibly and audibly, without touching the transcript. */
	const say = useCallback(
		(message: string) => {
			setNotice(message);
			onAnnounce?.(message);
		},
		[onAnnounce]
	);

	/*
	 * The completion menu — ticket 21.
	 *
	 * The two source lists are read on every keystroke rather than cached,
	 * because `/reload` replaces both and nothing here would hear about it. They
	 * are a handful of strings; the alternative is a stale menu.
	 *
	 * Only *permitted* skills are offered. An unpermitted skill is on disk and
	 * refused (ticket 13), and completing a name that is about to fail is the
	 * same lie as offering a command the running turn will refuse. `/skills`
	 * remains the place that lists every one with a mark for which is which.
	 */
	/*
	 * The built-ins plus whatever the user wrote in `.agents/commands`.
	 *
	 * Subscribed rather than read, because the templates change on `/reload` and
	 * nothing else here would hear it — the store holds the same array until the
	 * next load, which is what `useSyncExternalStore` requires. Built-ins come
	 * first: the first match wins, and that is the whole name-clash rule.
	 */
	const templates = useSyncExternalStore(onTemplatesChange, templateCommands);
	const commands = useMemo(() => [...SLASH_COMMANDS, ...templates], [templates]);

	const completions = useMemo(
		() =>
			menuOpen
				? complete(
						prompt,
						{
							skill: permittedSkills(allSkills(), activeProfile()).map((skill) => skill.name),
							profile: listProfiles().map((profile) => profile.name),
							file: files,
						},
						running,
						commands
					)
				: [],
		[commands, files, menuOpen, prompt, running]
	);

	/** Take an entry: it replaces the whole line, and may open the next menu. */
	const accept = useCallback(
		(index: number) => {
			const entry = completions[index];
			if (entry) {
				setPrompt(entry.value);
				setPicked(0);
			}
		},
		[completions]
	);

	const send = useCallback(() => {
		const raw = prompt.trim();
		if (!raw) {
			return;
		}
		/*
		 * The command list is data, in `agent/commands.ts`. What is matched here is
		 * the same list ticket 21's completion will read and pi's prompt templates
		 * will extend; what is *done* about each command stays here, because every
		 * body closes over the provider and this component's state.
		 */
		const parsed = parseCommand(raw, commands);
		/*
		 * Attachments join prose and never a command. `/compact` with a file
		 * attached is still `/compact`, and prepending `@src/App.tsx` to it would
		 * turn a command into a prompt — the same silent-becoming-prose failure the
		 * running-turn branch below refuses for the same reason.
		 */
		const text = parsed ? raw : withAttachments(raw, attachments);
		setNotice(undefined);

		// The one command that only means something *inside* a turn, so the idle
		// path has to refuse it: pi throws `invalid_state` on an idle harness, and
		// falling through would send the word "/steer" to the model as a prompt.
		if (!running && parsed?.command.whileRunning) {
			return say(`${parsed.command.name} only works while the agent is running.`);
		}

		/*
		 * Typing while the agent works, which used to be impossible: `send`
		 * returned early for the whole of a turn and the composer was dead.
		 *
		 * **Enter is a follow-up, and steering needs the word.** Both put text in
		 * front of the model, but a steer lands *inside* the running turn and
		 * changes what it is doing — so a steer the user meant as a follow-up
		 * spoils a turn that was already correct, and nothing undoes that. A
		 * follow-up has no such failure, which is why it is the one you get for
		 * free.
		 */
		if (running) {
			const run = runRef.current;
			if (!run) {
				// Compaction. There is no run and therefore no queue, and it cannot be
				// stopped either — so the only honest answer is to keep what was typed
				// and say why it did not go.
				return say('Summarising. Nothing can be queued until it finishes.');
			}
			/*
			 * A command that is not `/steer` is refused rather than queued. Queueing
			 * it would send the literal word "/compact" to the model as if it were an
			 * instruction — a command silently becoming prose is worse than a command
			 * that does not run, because nothing tells you it happened.
			 *
			 * The list says which commands survive a running turn, so a second one
			 * needs no change here.
			 */
			if (parsed && !parsed.command.whileRunning) {
				return say(`${parsed.command.name} only works when nothing is running.`);
			}
			if (parsed?.command.name === '/steer') {
				// An empty `/steer` is not a steer. Sending it would put a bare
				// command in front of the model as if it were an instruction.
				if (!parsed.args) {
					return say('/steer needs something to say.');
				}
				setPrompt('');
				run.steer(parsed.args);
				onAnnounce?.('Steering the current turn');
				return;
			}
			setPrompt('');
			setAttachments([]);
			run.follow(text);
			onAnnounce?.('Queued for after this turn');
			return;
		}

		setPrompt('');
		setAttachments([]);

		if (parsed?.command.name === '/compact') {
			setCompacting(true);
			onAnnounce?.('Summarising the conversation');
			provider.compact(beginTurn(text));
			return;
		}

		/*
		 * `/reload`, which is what makes hand-authored files usable.
		 *
		 * Without it the only way to see an edited profile or tool manifest is to
		 * restart the app — and since there is deliberately no editor, editing the
		 * file *is* the interface. Restarting after every typo is the cost of not
		 * building one, and it is not a cost worth paying for four lines.
		 *
		 * The install path already handles being run twice: profiles re-resolve
		 * the active one by name, and the tool store replaces its set and tells
		 * the harness. Nothing here is a first-load special case.
		 */
		if (parsed?.command.name === '/reload') {
			const emit = beginTurn(text);
			void loadProfileFiles()
				.then((loaded) => {
					const answer =
						loaded.problems.length > 0
							? loaded.problems.join('\n')
							: `Reloaded. ${listProfiles().length} profiles, ${userTools().length} of your tools, ` +
								`${allTemplates().length} of your commands.`;
					emit({ kind: 'text', text: answer });
					emit({ kind: 'complete' });
					onAnnounce?.(answer);
				})
				// `loadProfileFiles` now awaits the skill loader as well, so this is
				// a wider surface than the one that never rejected. Without a
				// handler a rejection leaves the turn running for ever and the
				// composer disabled, with nothing said.
				.catch((cause: unknown) => {
					emit({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
					emit({ kind: 'complete' });
				});
			return;
		}

		/*
		 * `/profile`, which is the whole profile UI for now. A switch is a local
		 * state change rather than a run, so it answers into a turn of its own and
		 * closes it immediately.
		 *
		 * That is *not* ticket 14's transcript divider, and should not be mistaken
		 * for it: this turn lives in React state and disappears on reload, where a
		 * divider is a session entry. What it does give is the same thing a divider
		 * gives a reader mid-conversation — the switch is visible where it happened.
		 */
		/*
		 * `/skill <name> [text]` — the user half of skills.
		 *
		 * A real turn, so it goes through `provider.skill` and keeps a run to
		 * cancel. Everything after the name is `additionalInstructions`, appended
		 * after the skill body exactly as pi's `/skill:name args` does.
		 *
		 * Space-separated rather than pi's `/skill:name`, matching `/profile
		 * <name>`. The two formats complete equally well — an autocomplete list can
		 * hold whole strings either way — and one separator is one rule. Completion
		 * itself is ticket 21.
		 */
		if (parsed?.command.name === '/skill') {
			const [name, ...words] = parsed.args.split(/\s+/);
			const emit = beginTurn(text);
			if (!name) {
				// Not an error: it is the discoverable half of a command whose
				// argument nothing yet completes.
				const answer = skillList(activeProfile());
				emit({ kind: 'text', text: answer });
				emit({ kind: 'complete' });
				onAnnounce?.(answer);
				return;
			}
			runRef.current = provider.skill(name, words.join(' ') || undefined, emit);
			return;
		}

		/*
		 * `/skills`, which lists them and says why one is missing.
		 *
		 * Separate from `/profile` because the interesting failures are different:
		 * a skill can be on disk and unpermitted, permitted and shadowed by a name
		 * clash, or dropped for having no description. None of that is visible
		 * anywhere else — `loadSkills` reports it as diagnostics and this is the
		 * only thing that reads them.
		 */
		if (parsed?.command.name === '/skills') {
			const emit = beginTurn(text);
			const answer = skillList(activeProfile());
			emit({ kind: 'text', text: answer });
			emit({ kind: 'complete' });
			onAnnounce?.(answer);
			return;
		}

		if (parsed?.command.name === '/profile') {
			const emit = beginTurn(text);
			const result = parsed.args ? activateProfile(parsed.args) : undefined;
			const answer = result
				? result.ok
					? `Switched to "${result.profile.name}". It applies from the next turn; nothing already said is changed.`
					: result.reason
				: [
						...listProfiles().map(
							(profile) =>
								`${profile.name === activeProfile().name ? '●' : '○'} ${profile.name} — ` +
								`${profile.model.id || 'no model'}, ${profile.gatePolicy}, ` +
								`thinking ${profile.thinkingLevel}${profile.rtk ? ', rtk' : ''}` +
								// Whether an agent may spawn this one — asked of the rule
								// itself rather than re-derived from the two fields, so
								// this cannot drift from what the parent model is
								// actually offered. A profile marked `subagent` but
								// missing its description is not delegable, and `/reload`
								// has already said so.
								`${delegable([profile]).length > 0 ? ', subagent' : ''}` +
							// The one place a user finds out that a thinking level is
							// not going to happen. `getSupportedThinkingLevels` returns
							// `["off"]` for a model that does not reason, so pi clamps
							// every level to `off` and nothing errors — a profile asking
							// for `high` reads identically whether it gets it or not.
							//
							// Both cases say so, and they are not the same case: an
							// unknown model is a gap in our table with an escape hatch,
							// where a known non-reasoning one is simply a profile asking
							// for something that model cannot do. Warning only on the
							// first missed the second, which is a profile the user wrote
							// and would never find out about. See ticket 19.
							thinkingUnavailable(profile.model.id, profile.thinkingLevel)
						),
						// Said out loud because a declared tool is *not* armed — a
						// profile has to name it (ticket 13), so a user who wrote a
						// manifest and saw nothing happen needs the other half.
						...(userTools().length > 0
							? [
									`\nYour tools: ${userTools()
										.map((tool) => tool.name)
										.join(', ')}. A profile must name one in "tools" to enable it.`,
								]
							: []),
						// Where to write one. There is no profile editor, so a user
						// who is not told this has no way to find out.
						`\nDefined in ${profileSources().projectFile} (this project)` +
							`${profileSources().globalPath ? ` and ${profileSources().globalPath} (global)` : ''}.` +
							` Edit either and run /reload.`,
					].join('\n');
			emit({ kind: 'text', text: answer });
			emit({ kind: 'complete' });
			// After `complete`, deliberately: the sink announces "Agent finished" on
			// it, which is the wrong sentence for a command that never ran the
			// agent. Announcing last is what a screen-reader user is left with.
			onAnnounce?.(result ? answer : `${listProfiles().length} profiles listed`);
			return;
		}

		/*
		 * One of the user's own commands.
		 *
		 * Anything parsed that is not a built-in came from `.agents/commands`, and
		 * identity is the test because the built-ins are the same objects in both
		 * lists — a template is whatever the composer appended. It has to be last:
		 * every branch above matches by name, and this one matches by exhaustion.
		 *
		 * `parseCommandArgs` is pi's, and it is the reason this is not
		 * `args.split(/\s+/)`: a template fills `$1` and `${@:2}` from these words,
		 * so `/deploy "the staging box"` has to be one argument and not three.
		 */
		if (parsed) {
			runRef.current = provider.template(
				parsed.command.name.slice(1),
				parseCommandArgs(parsed.args),
				beginTurn(text)
			);
			return;
		}

		runRef.current = provider.start(text, beginTurn(text));
	}, [attachments, beginTurn, commands, onAnnounce, prompt, provider, running, say]);

	const resolve = useCallback(
		(approved: boolean) => {
			setTurns((current) => resolveApproval(current, approved));
			setAwaiting(false);
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

	// The same shape as `resolve`, and the same reason for each line — the focus
	// move included, since the Answer button is replaced by static text too.
	const answer = useCallback(
		(chosen: readonly string[]) => {
			setTurns((current) => answerQuestion(current, chosen));
			setAwaiting(false);
			onAnnounce?.(`Answered: ${chosen.join(', ')}`);
			runRef.current?.answerQuestion(chosen);
			promptRef.current?.focus();
		},
		[onAnnounce]
	);

	/** What the context ring shows: the most recent turn that reported usage. */
	const usage = useMemo(
		() => [...turns].reverse().find((turn) => turn.usage)?.usage,
		[turns]
	);

	const attach = useCallback(
		(path: string) => {
			setAttachments((current) => (current.includes(path) ? current : [...current, path]));
			onAnnounce?.(`Attached ${path}`);
		},
		[onAnnounce]
	);

	/**
	 * A file dropped on the composer.
	 *
	 * The payload is a root-relative path from a row inside this app, and it is
	 * checked against the same file list the explorer drew from — a drop can only
	 * ever attach something that exists. A file dragged from the operating system
	 * carries no path this app is allowed to resolve (`workspace.rs` is
	 * root-confined and the UI never sees an absolute path), so it is refused with
	 * the reason rather than silently ignored.
	 */
	const drop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			setDragging(false);
			const path = event.dataTransfer.getData('text/plain');
			if (files.includes(path)) {
				attach(path);
				return;
			}
			say(
				event.dataTransfer.files.length > 0
					? 'Files from outside the workspace cannot be attached. Open the folder as your workspace first.'
					: 'That is not a file in this workspace.'
			);
		},
		[attach, files, say]
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
						{/*
						 * The Guide removes the ADE heading and the avatar, which is right
						 * visually and removes the only thing distinguishing speaker. A
						 * card surface and a right-hand alignment are invisible to a
						 * screen reader, so the distinction is kept in the DOM and taken
						 * out in CSS: visually absent, structurally present.
						 */}
						<div className="ide-agent-prompt">
							<span className="ide-visually-hidden">You said: </span>
							<Markdown files={files} onOpenArtifact={onOpenArtifact}>
								{turn.prompt}
							</Markdown>
						</div>
						<span className="ide-visually-hidden">ADE replied:</span>
						{turn.parts.map((part, index) => (
							<PartView
								key={index}
								part={part}
								turn={turn}
								files={files}
								onResolve={resolve}
								onAnswer={answer}
								onOpenArtifact={onOpenArtifact}
							/>
						))}
						{turn.status === 'cancelled' ? (
							<p className="ide-agent-status">Stopped.</p>
						) : null}
						{/*
						 * Turn undo — the affordance only, per ticket 41.
						 *
						 * The Guide says activating Undo "removes the corresponding change
						 * event from the transcript", and that sentence describes what the
						 * mock did rather than what this app can do: pi's session is
						 * append-only JSONL. Ticket 28 owns the behaviour and it is
						 * deferred, so this button says so rather than pretending.
						 */}
						{turn.status === 'complete' ? (
							<div className="ide-agent-turn-actions">
								<button
									type="button"
									className="ide-agent-undo"
									onClick={() =>
										say('Undoing a turn is not decided yet — the session is append-only.')
									}
								>
									<Icon name="discard" />
									Undo
								</button>
							</div>
						) : null}
						{queuedLabel(turn) ? (
							<p className="ide-agent-status">{queuedLabel(turn)}</p>
						) : null}
						{turn.usage ? <UsageView usage={turn.usage} /> : null}
					</article>
				))}
			</div>

			{/*
			 * The Context Explorer: modeless, above the composer, never over it.
			 * In flow rather than absolutely positioned, which is what makes
			 * "never covering the input or toolbar" true by construction instead
			 * of true until someone resizes the window.
			 */}
			{explorerOpen ? (
				<ContextExplorer
					files={files}
					onClose={() => setExplorerOpen(false)}
					onAttach={attach}
					// A file is a Modal Workbench tab, which is exactly what an
					// artifact reference to a file already opens — same id, same
					// destination, and the controller stays the only thing that
					// decides where anything is shown.
					onOpenFile={(path) => onOpenArtifact?.(path)}
				/>
			) : null}

			<form
				className={dragging ? 'ide-agent-composer ide-agent-composer-drag' : 'ide-agent-composer'}
				onSubmit={(event) => {
					event.preventDefault();
					send();
				}}
				onDragOver={(event) => {
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={drop}
			>
				{attachments.length > 0 ? (
					<ul className="ide-attachments" aria-label="Attached files">
						{attachments.map((path) => (
							<li key={path} className="ide-attachment">
								<Icon name="file" />
								<span className="ide-attachment-name" title={path}>
									{path}
								</span>
								<button
									type="button"
									className="ide-attachment-remove"
									onClick={() =>
										setAttachments((current) => current.filter((item) => item !== path))
									}
									aria-label={`Remove ${path}`}
								>
									<Icon name="close" />
								</button>
							</li>
						))}
					</ul>
				) : null}
				{/*
				 * The completion menu, **above** the composer rather than below it —
				 * ticket 44. Below the input it opened downwards over the bottom bar
				 * and, at the foot of the window, over nothing at all. This is a
				 * restyle: `completion.ts` and its check are untouched, and Enter
				 * still inserts the selection because that is the landed behaviour
				 * the hands already know.
				 */}
				{completions.length > 0 ? (
					<ul className="ide-agent-completions" id="agent-completions" role="listbox">
						{completions.map((entry, index) => (
							<li
								key={entry.value}
								id={`agent-completion-${index}`}
								role="option"
								aria-selected={index === picked}
								className={
									index === picked
										? 'ide-agent-completion ide-agent-completion-picked'
										: 'ide-agent-completion'
								}
								// Pointer down rather than click: click fires after the
								// textarea has already lost focus, and blur is what a
								// user reaching for the mouse should not be punished by.
								onMouseDown={(event) => {
									event.preventDefault();
									accept(index);
								}}
							>
								<span className="ide-agent-completion-value">{entry.value.trim()}</span>
								<span className="ide-agent-completion-summary">{entry.summary}</span>
							</li>
						))}
					</ul>
				) : null}
				<div className="ide-composer-row">
				<textarea
					className="ide-agent-input"
					ref={promptRef}
					rows={3}
					value={prompt}
					// The composer works during a turn now, and nothing else says so.
					// A user who was trained by the old behaviour will not try it.
					placeholder={
						running && !compacting
							? 'Enter queues it for after this turn. /steer changes this one…'
							: 'Ask the agent…'
					}
					aria-label="Prompt"
					// The combobox half of the pattern: the list below is the popup,
					// and the selected row is named rather than focused, so the caret
					// never leaves the text being typed.
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={completions.length > 0}
					aria-controls="agent-completions"
					aria-activedescendant={
						completions.length > 0 ? `agent-completion-${picked}` : undefined
					}
					onChange={(event) => {
						setPrompt(event.target.value);
						setPicked(0);
						// Typing reopens what Escape closed: the menu was dismissed for
						// the text it was showing, not for the rest of the session.
						setMenuOpen(true);
					}}
					onKeyDown={(event) => {
						if (completions.length > 0) {
							if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
								event.preventDefault();
								const step = event.key === 'ArrowDown' ? 1 : completions.length - 1;
								setPicked((current) => (current + step) % completions.length);
								return;
							}
							// Tab and Enter both take the entry. Enter is what the hands
							// already do, and Tab is what a completion menu means
							// everywhere else — neither reaches `send` while the menu is
							// open, which is why an entry equal to the typed text is
							// dropped rather than shown.
							if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
								event.preventDefault();
								accept(picked);
								return;
							}
							if (event.key === 'Escape') {
								event.preventDefault();
								setMenuOpen(false);
								return;
							}
						}
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							send();
						}
					}}
				/>
				{/*
				 * Send sits in the input row, per the Guide's `[prompt input][send]`.
				 * While a turn runs it is Stop in the same slot rather than a second
				 * button appearing beside it — the row never changes width, which is
				 * the non-shifting rule again.
				 */}
				{running && compacting ? (
					// Not a Stop button that quietly does nothing: pi's compaction
					// takes no abort signal, so there is nothing to offer.
					<button type="button" className="ide-composer-send" disabled aria-label="Summarising">
						<Icon name="loading" />
					</button>
				) : running ? (
					<button
						type="button"
						className="ide-composer-send ide-composer-send-stop"
						onClick={() => runRef.current?.cancel()}
						aria-label="Stop the agent"
					>
						<Icon name="primitive-square" />
					</button>
				) : (
					<button
						type="submit"
						className="ide-composer-send"
						disabled={!prompt.trim()}
						aria-label="Send"
					>
						<Icon name="send" />
					</button>
				)}
				</div>
				<ComposerBar
					attachOpen={explorerOpen}
					onAttach={() => setExplorerOpen((open) => !open)}
					usage={usage}
					spent={spent}
					onTranscript={() => setTranscriptOpen(true)}
					transcriptDisabled={turns.length === 0}
					onAnnounce={onAnnounce}
					onEditProfile={(picked) => setEditing({ profile: picked })}
				/>
				{awaiting ? (
					// Covers both, because from the composer they are the same thing:
					// the run is paused on something above that only you can settle.
					<p className="ide-agent-status">Waiting for your answer above.</p>
				) : null}
				{notice ? <p className="ide-agent-status">{notice}</p> : null}
			</form>

			<ProfileModal
				open={editing !== undefined}
				profile={editing?.profile}
				onClose={() => setEditing(undefined)}
				onAnnounce={onAnnounce}
			/>

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
