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
import { activateProfile, activeProfile, listProfiles } from '../../agent/profile';
import { loadProfileFiles, profileSources } from '../../agent/profileFiles';
import { delegable } from '../../agent/subagent';
import { allSkills, permittedSkills, skillList } from '../../agent/skills';
import { userTools } from '../../agent/userTools';
import { Icon, Overlay } from '../../ui';
import { OTHER } from '../../agent/ask';
import { thinkingUnavailable } from '../../agent/models';
import {
	answerQuestion,
	applyEvent,
	approvalLabel,
	asPlainText,
	canAnswer,
	questionLabel,
	queuedLabel,
	resolveApproval,
	formatCost,
	sessionCost,
	toolLabel,
	turnCost,
	type Part,
	type QuestionPart,
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
	onResolve,
	onAnswer,
}: {
	readonly part: Part;
	readonly turn: Turn;
	readonly onResolve: (approved: boolean) => void;
	readonly onAnswer: (chosen: readonly string[]) => void;
}) {
	if (part.kind === 'text') {
		return <p className="ide-agent-text">{part.text}</p>;
	}

	if (part.kind === 'thinking') {
		// A disclosure rather than prose: reasoning is usually noise, and it is
		// long. Collapsed by default so the answer stays the thing you read.
		return (
			<details className="ide-agent-thinking">
				<summary>Thinking</summary>
				<p>{part.text}</p>
			</details>
		);
	}

	if (part.kind === 'tool') {
		const status = toolLabel(part, turn.status);
		return (
			<div
				className="ide-agent-tool"
				data-state={part.state}
				// Carries its own outcome, so navigating group to group does not
				// require reading into each one to find out how it ended.
				aria-label={`Tool: ${part.name} — ${status}`}
				role="group"
			>
				<p className="ide-agent-tool-head">
					<Icon name="tools" />
					<span className="ide-agent-tool-name">{part.name}</span>
					<span className="ide-agent-tool-input">{JSON.stringify(part.input)}</span>
					<span className="ide-agent-tool-state">{status}</span>
				</p>
				{part.output ? <pre className="ide-agent-tool-output">{part.output}</pre> : null}
			</div>
		);
	}

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
			<details className="ide-agent-compacted">
				<summary>
					Earlier messages were summarised. Context was {part.tokensBefore.toLocaleString()}{' '}
					tokens.
				</summary>
				<p className="ide-agent-compacted-summary">{part.summary}</p>
			</details>
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

export function AgentChat({ provider, files = [], onAnnounce }: AgentChatProps) {
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

	/** What the conversation has cost, over the turns that reported a price. */
	const spent = useMemo(() => sessionCost(turns), [turns]);

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
		const text = prompt.trim();
		if (!text) {
			return;
		}
		/*
		 * The command list is data, in `agent/commands.ts`. What is matched here is
		 * the same list ticket 21's completion will read and pi's prompt templates
		 * will extend; what is *done* about each command stays here, because every
		 * body closes over the provider and this component's state.
		 */
		const parsed = parseCommand(text, commands);
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
			run.follow(text);
			onAnnounce?.('Queued for after this turn');
			return;
		}

		setPrompt('');

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
	}, [beginTurn, commands, onAnnounce, prompt, provider, running, say]);

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
						{turn.parts.map((part, index) => (
							<PartView
								key={index}
								part={part}
								turn={turn}
								onResolve={resolve}
								onAnswer={answer}
							/>
						))}
						{turn.status === 'cancelled' ? (
							<p className="ide-agent-status">Stopped.</p>
						) : null}
						{queuedLabel(turn) ? (
							<p className="ide-agent-status">{queuedLabel(turn)}</p>
						) : null}
						{turn.usage ? <UsageView usage={turn.usage} /> : null}
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
				<div className="ide-agent-composer-actions">
					<button
						type="button"
						className="ide-button"
						onClick={() => setTranscriptOpen(true)}
						disabled={turns.length === 0}
					>
						Plain text transcript
					</button>
					{/* The session total, which is a floor rather than a bill: a turn on
					    a model with no known rates contributes nothing rather than zero,
					    and the label says "so far" rather than naming a total the app
					    cannot stand behind. Absent entirely until something is priced. */}
					{spent !== undefined ? (
						<span className="ide-agent-usage" title="Turns on models with no known rates are not counted.">
							{formatCost(spent)} so far
						</span>
					) : null}
					{running && compacting ? (
						// Not a Stop button that quietly does nothing: pi's compaction
						// takes no abort signal, so there is nothing to offer.
						<button type="button" className="ide-button" disabled>
							Summarising…
						</button>
					) : running ? (
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
				{awaiting ? (
					// Covers both, because from the composer they are the same thing:
					// the run is paused on something above that only you can settle.
					<p className="ide-agent-status">Waiting for your answer above.</p>
				) : null}
				{notice ? <p className="ide-agent-status">{notice}</p> : null}
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
