// The profile configuration modal — ticket 43.
//
// **One modal, two entry points.** Create and Edit are the same surface with
// different starting values, because they are the same decision: a profile is
// its ten fields whether or not some of them already have values.
//
// Tools and Skills are *pages* rather than two long checkbox lists on the main
// page. A profile with forty tools would otherwise bury the four fields that
// decide what the model actually is.

import { useEffect, useMemo, useState } from 'react';

import * as Checkbox from '@radix-ui/react-checkbox';

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

import type { GatePolicy } from '../../agent/gate';
import { knownCapabilities, PROVIDER_IDS, type Profile, type ProviderId } from '../../agent/profile';
import { saveProfile } from '../../agent/profileFiles';
import { resolveRtk, RTK_VERSION, type RtkStatus } from '../../agent/rtk';
import { Icon, Overlay } from '../../ui';

const THINKING_LEVELS: readonly ThinkingLevel[] = [
	'off',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
] as ThinkingLevel[];

/**
 * The three policies, with what each one means where the choice is made.
 *
 * The wording is `gate.ts`'s, shortened. A dial whose third position is
 * described only in a source comment is a dial nobody can set safely.
 */
const POLICIES: readonly { readonly id: GatePolicy; readonly label: string; readonly note: string }[] =
	[
		{ id: 'ask', label: 'Ask', note: 'Prompts before anything that changes a file or runs a command.' },
		{
			id: 'auto',
			label: 'Auto',
			note: 'Never prompts, except for a short list of irreversible commands.',
		},
		{
			id: 'bypass',
			label: 'Bypass',
			note: 'Skips that list too. Writes outside the workspace are still refused, and the per-turn checkpoint still runs.',
		},
	];

export interface ProfileModalProps {
	readonly open: boolean;
	/** The profile being edited, or undefined to create one. */
	readonly profile?: Profile;
	readonly onClose: () => void;
	readonly onAnnounce?: (message: string) => void;
	/**
	 * The root whose project file is being written — the focused session's.
	 *
	 * Saving reloads, and a reload is scoped to a folder since ticket 49: without
	 * this the reload would look like it came from nowhere and reach every
	 * session's harness rather than the ones in this folder.
	 */
	readonly root?: string;
}

interface Draft {
	name: string;
	provider: ProviderId;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	gatePolicy: GatePolicy;
	tools: Record<string, boolean>;
	skills: string[];
	rtk: boolean;
	instructions: string;
}

function draftFrom(profile: Profile | undefined): Draft {
	return {
		name: profile?.name ?? '',
		provider: profile?.model.provider ?? PROVIDER_IDS[0],
		modelId: profile?.model.id ?? '',
		thinkingLevel: profile?.thinkingLevel ?? 'medium',
		gatePolicy: profile?.gatePolicy ?? 'auto',
		tools: { ...(profile?.tools ?? {}) },
		skills: [...(profile?.skills ?? [])],
		rtk: profile?.rtk ?? false,
		instructions: profile?.instructions ?? '',
	};
}

/**
 * One selection row.
 *
 * **No native checkbox, and real checkbox semantics anyway.** The Guide asks for
 * a bare row with a check glyph when it is on and nothing when it is off — a
 * state a sighted reader can see and nobody else can. Radix's Checkbox gives the
 * row `role="checkbox"`, `aria-checked` and Space to toggle, so the visual is
 * the Guide's and the semantics are the platform's. A click handler on a `div`
 * would have shipped the visual and lost the rest.
 */
function SelectionRow({
	label,
	note,
	on,
	onToggle,
}: {
	readonly label: string;
	readonly note?: string;
	readonly on: boolean;
	readonly onToggle: () => void;
}) {
	return (
		<Checkbox.Root className="ide-select-row" checked={on} onCheckedChange={onToggle}>
			<span className="ide-select-label">
				{label}
				{note ? <span className="ide-select-note">{note}</span> : null}
			</span>
			{/* Nothing at all when off, per the Guide — not a dimmed or hollow mark. */}
			{on ? <Icon name="check" /> : null}
		</Checkbox.Root>
	);
}

/** Tools or Skills: a subpage with Back, search, a count, and the two bulk actions. */
function SelectionPage({
	title,
	items,
	isOn,
	onToggle,
	onAll,
	onBack,
}: {
	readonly title: string;
	readonly items: readonly string[];
	readonly isOn: (name: string) => boolean;
	readonly onToggle: (name: string) => void;
	readonly onAll: (on: boolean) => void;
	readonly onBack: () => void;
}) {
	const [query, setQuery] = useState('');
	const shown = items.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()));
	const enabled = items.filter(isOn).length;

	return (
		<>
			<div className="ide-subpage-bar">
				<button type="button" className="ide-bar-button" onClick={onBack}>
					<Icon name="arrow-left" />
					Back
				</button>
				<h3 className="ide-subpage-title">{title}</h3>
			</div>
			<div className="ide-subpage-search">
				<input
					type="search"
					className="ide-input"
					value={query}
					placeholder={`Search ${title.toLowerCase()}…`}
					aria-label={`Search ${title.toLowerCase()}`}
					onChange={(event) => setQuery(event.target.value)}
				/>
				{query ? (
					<button
						type="button"
						className="ide-bar-button"
						onClick={() => setQuery('')}
						aria-label="Clear the search"
					>
						<Icon name="close" />
					</button>
				) : null}
			</div>
			<p className="ide-subpage-count">
				{enabled} of {items.length} enabled
				{query ? ` · ${shown.length} shown` : ''}
			</p>
			<div className="ide-subpage-actions">
				<button type="button" className="ide-button" onClick={() => onAll(true)}>
					Enable all
				</button>
				<button type="button" className="ide-button" onClick={() => onAll(false)}>
					Disable all
				</button>
			</div>
			{items.length === 0 ? (
				<p className="ide-help-note">Nothing to choose from yet.</p>
			) : (
				<div className="ide-select-list">
					{shown.map((name) => (
						<SelectionRow
							key={name}
							label={name}
							on={isOn(name)}
							onToggle={() => onToggle(name)}
						/>
					))}
				</div>
			)}
		</>
	);
}

export function ProfileModal({ open, profile, onClose, onAnnounce, root }: ProfileModalProps) {
	const [draft, setDraft] = useState<Draft>(() => draftFrom(profile));
	const [page, setPage] = useState<'main' | 'tools' | 'skills'>('main');
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string>();

	// Opening is what resets it. Editing a second profile without this would show
	// the first one's values, which is the kind of bug that gets saved.
	useEffect(() => {
		if (open) {
			setDraft(draftFrom(profile));
			setPage('main');
			setProblem(undefined);
		}
	}, [open, profile]);

	/*
	 * Which rtk this machine has, asked only once the row is on.
	 *
	 * Deliberately *not* on `open`: resolving can mean downloading, and opening
	 * a settings dialog is not a request to reach the network. Ticking the row
	 * is, which makes this the third prefetch site after app open and the
	 * profile switch — and the one where the wait is least noticeable, because
	 * nobody is blocked on it.
	 */
	const [rtk, setRtk] = useState<RtkStatus>();
	useEffect(() => {
		if (open && draft.rtk) {
			void resolveRtk().then(setRtk);
		}
	}, [open, draft.rtk]);
	const rtkSource =
		rtk === undefined
			? `pinned at ${RTK_VERSION}`
			: rtk.source === 'unavailable'
				? `unavailable, so commands run unfiltered`
				: rtk.source === 'path'
					? `${rtk.version} from your PATH`
					: `${rtk.version}, fetched and cached`;

	const capabilities = knownCapabilities();
	const optIn = useMemo(() => capabilities.optIn ?? [], [capabilities.optIn]);
	// The map's third state: not mentioned means on, unless it is a tool someone
	// wrote — see `Capabilities.optIn`. The modal has to read it the same way the
	// harness does, or a row would lie about what is armed.
	const toolOn = (name: string) => draft.tools[name] ?? !optIn.includes(name);
	const enabledTools = capabilities.tools.filter(toolOn).length;

	async function save(): Promise<void> {
		const name = draft.name.trim();
		if (!name) {
			setProblem('A profile needs a name.');
			return;
		}
		setSaving(true);
		const result = await saveProfile(root, {
			name,
			model: { provider: draft.provider, id: draft.modelId.trim() },
			thinkingLevel: draft.thinkingLevel,
			gatePolicy: draft.gatePolicy,
			tools: draft.tools,
			skills: draft.skills,
			rtk: draft.rtk,
			...(draft.instructions.trim() ? { instructions: draft.instructions.trim() } : {}),
		});
		setSaving(false);
		if (result.problems.length > 0) {
			// Reported rather than swallowed, and the modal stays open: the
			// problems name fields, and closing would hide what to fix.
			setProblem(result.problems.join(' '));
			onAnnounce?.(result.problems.join(' '));
			return;
		}
		onAnnounce?.([`Saved "${name}".`, result.note].filter(Boolean).join(' '));
		onClose();
	}

	return (
		<Overlay
			open={open}
			title={profile ? `Edit ${profile.name}` : 'New profile'}
			onClose={onClose}
			className="ide-overlay-profile"
		>
			{page === 'tools' ? (
				<SelectionPage
					title="Tools"
					items={capabilities.tools}
					isOn={toolOn}
					onToggle={(name) =>
						setDraft((current) => ({
							...current,
							tools: { ...current.tools, [name]: !toolOn(name) },
						}))
					}
					onAll={(on) =>
						setDraft((current) => ({
							...current,
							tools: Object.fromEntries(capabilities.tools.map((name) => [name, on])),
						}))
					}
					onBack={() => setPage('main')}
				/>
			) : page === 'skills' ? (
				<SelectionPage
					title="Skills"
					items={capabilities.skills}
					isOn={(name) => draft.skills.includes(name)}
					onToggle={(name) =>
						setDraft((current) => ({
							...current,
							skills: current.skills.includes(name)
								? current.skills.filter((item) => item !== name)
								: [...current.skills, name],
						}))
					}
					onAll={(on) =>
						setDraft((current) => ({ ...current, skills: on ? [...capabilities.skills] : [] }))
					}
					onBack={() => setPage('main')}
				/>
			) : (
				<>
					<label className="ide-field">
						<span>Name</span>
						<input
							type="text"
							className="ide-input"
							value={draft.name}
							// Read-only while editing. Renaming would leave the old entry
							// behind as a second profile nobody asked for, and renaming is
							// not something this ticket was asked to support.
							readOnly={profile !== undefined}
							onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
						/>
					</label>
					<label className="ide-field">
						<span>Provider</span>
						<select
							className="ide-input"
							value={draft.provider}
							onChange={(event) =>
								setDraft((current) => ({ ...current, provider: event.target.value as ProviderId }))
							}
						>
							{PROVIDER_IDS.map((id) => (
								<option key={id} value={id}>
									{id}
								</option>
							))}
						</select>
					</label>
					<label className="ide-field">
						<span>Model</span>
						<input
							type="text"
							className="ide-input"
							value={draft.modelId}
							placeholder="deepseek-chat"
							onChange={(event) =>
								setDraft((current) => ({ ...current, modelId: event.target.value }))
							}
						/>
					</label>
					<label className="ide-field">
						<span>Reasoning effort</span>
						<select
							className="ide-input"
							value={draft.thinkingLevel}
							onChange={(event) =>
								setDraft((current) => ({
									...current,
									thinkingLevel: event.target.value as ThinkingLevel,
								}))
							}
						>
							{THINKING_LEVELS.map((level) => (
								<option key={level} value={level}>
									{level}
								</option>
							))}
						</select>
					</label>

					<fieldset className="ide-fieldset">
						<legend>Approval</legend>
						{POLICIES.map((policy) => (
							<label key={policy.id} className="ide-radio">
								<input
									type="radio"
									name="gate-policy"
									checked={draft.gatePolicy === policy.id}
									onChange={() => setDraft((current) => ({ ...current, gatePolicy: policy.id }))}
								/>
								<span>
									{policy.label}
									<span className="ide-select-note">{policy.note}</span>
								</span>
							</label>
						))}
					</fieldset>

					<fieldset className="ide-fieldset">
						<legend>Output</legend>
						{/*
						 * The pin is on the row on purpose. rtk is fetched at a
						 * version this app chooses (ticket 11, amendment 6), and
						 * upstream cuts releases weekly — so what we run is
						 * permanently a little behind, and the only honest place
						 * to admit that is where the feature is switched on.
						 * `rtkSource` says which binary actually answered, which
						 * is not always the pinned one: a machine with its own
						 * rtk on PATH keeps it.
						 */}
						<SelectionRow
							label="Route commands through rtk"
							note={`filters verbose output before the model pays for it — ${rtkSource}`}
							on={draft.rtk}
							onToggle={() => setDraft((current) => ({ ...current, rtk: !current.rtk }))}
						/>
					</fieldset>

					{/* Navigation rows, each saying how many are on — the number is the
					    reason the page is worth opening. */}
					<button type="button" className="ide-nav-row" onClick={() => setPage('tools')}>
						<span>Tools</span>
						<span className="ide-nav-row-value">
							{enabledTools} of {capabilities.tools.length}
							<Icon name="chevron-right" />
						</span>
					</button>
					<button type="button" className="ide-nav-row" onClick={() => setPage('skills')}>
						<span>Skills</span>
						<span className="ide-nav-row-value">
							{draft.skills.length} of {capabilities.skills.length}
							<Icon name="chevron-right" />
						</span>
					</button>

					<label className="ide-field">
						<span>Extra instructions</span>
						<textarea
							className="ide-input"
							rows={3}
							value={draft.instructions}
							placeholder="Appended to the system prompt, never substituted for it."
							onChange={(event) =>
								setDraft((current) => ({ ...current, instructions: event.target.value }))
							}
						/>
					</label>

					{problem ? <p className="ide-agent-error">{problem}</p> : null}

					<div className="ide-dialog-actions">
						<button type="button" className="ide-button" onClick={onClose}>
							Cancel
						</button>
						<button type="button" className="ide-button" disabled={saving} onClick={() => void save()}>
							{saving ? 'Saving…' : 'Save'}
						</button>
					</div>
				</>
			)}
		</Overlay>
	);
}
