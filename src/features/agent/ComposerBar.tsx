// The composer's bottom bar — ticket 42. Exactly 32px, and the height is the
// point: it sits *outside* the input surface, so the input can grow and the bar
// stays where the hand expects it.
//
//     [attach][profile summary][context ring]        [transcript][profile]
//
// The three left controls are independent transparent buttons rather than a
// segmented container: two of them do something and one is a label, and a
// segment around all three would say they are alternatives.

import { useSyncExternalStore } from 'react';

import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';

import { pressure } from '../../agent/compaction';
import { activateProfile, activeProfile, listProfiles, onProfileChange } from '../../agent/profile';
import { Icon } from '../../ui';
import { profileSummary, ringDash } from './composer';
import { formatCost, turnCost, type Usage } from './transcript';

const RING_RADIUS = 7;

export interface ComposerBarProps {
	/** Whether the Context Explorer is open, so Attach can say which it does. */
	readonly attachOpen: boolean;
	readonly onAttach: () => void;
	/** The most recent turn that reported usage, or nothing yet. */
	readonly usage: Usage | undefined;
	/** The conversation's cost so far, where the models were priced. */
	readonly spent: number | undefined;
	readonly onTranscript: () => void;
	readonly transcriptDisabled: boolean;
	readonly onAnnounce?: (message: string) => void;
}

/**
 * The context ring: an unlabelled circle, and a popover with the numbers.
 *
 * Unlabelled because it is the fourth thing on a 32px bar and a percentage in
 * text is the thing the popover is for. It is still announced — the button
 * carries the percentage as its accessible name, since a ring is not a shape a
 * screen reader can read.
 */
function ContextRing({ usage, spent }: { readonly usage: Usage | undefined; readonly spent: number | undefined }) {
	const meter = usage ? pressure(usage.contextTokens, usage.contextWindow) : undefined;
	const percent = meter?.percent ?? 0;
	// Undefined on a model with no known rates, which is not the same as zero —
	// the whole reason `costFor` answers undefined rather than a price.
	const lastCost = usage ? turnCost(usage) : undefined;
	const label = usage
		? meter
			? `Context: ${percent}% used`
			: `Context: ${usage.contextTokens.toLocaleString()} tokens, window unknown`
		: 'Context: nothing used yet';

	return (
		<Popover.Root>
			<Popover.Trigger
				className={meter?.warn ? 'ide-bar-button ide-bar-button-warn' : 'ide-bar-button'}
				aria-label={label}
			>
				<svg className="ide-ring" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
					<circle className="ide-ring-track" cx="9" cy="9" r={RING_RADIUS} />
					<circle
						className="ide-ring-fill"
						cx="9"
						cy="9"
						r={RING_RADIUS}
						strokeDasharray={ringDash(percent, RING_RADIUS)}
					/>
				</svg>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content className="ide-popover" side="top" sideOffset={6} aria-label="Context usage">
					<dl className="ide-usage-list">
						{usage ? (
							<>
								<dt>Context</dt>
								<dd>
									{usage.contextTokens.toLocaleString()}
									{meter ? ` of ${usage.contextWindow?.toLocaleString()} — ${percent}%` : ' — window unknown'}
								</dd>
								<dt>Last turn</dt>
								<dd>
									{usage.inputTokens.toLocaleString()} in · {usage.outputTokens.toLocaleString()} out
								</dd>
								{usage.cost && lastCost !== undefined ? (
									<>
										<dt>Last turn cost</dt>
										<dd>
											{formatCost(lastCost)} — input {formatCost(usage.cost.input)}, output{' '}
											{formatCost(usage.cost.output)}, cache read {formatCost(usage.cost.cacheRead)},
											cache write {formatCost(usage.cost.cacheWrite)}
										</dd>
									</>
								) : null}
							</>
						) : (
							<>
								<dt>Context</dt>
								<dd>Nothing used yet.</dd>
							</>
						)}
						{/* The session line ticket 26 landed, moved here rather than lost.
						    Still a floor rather than a bill: turns on models with no known
						    rates contribute nothing rather than zero. */}
						{spent !== undefined ? (
							<>
								<dt>Session so far</dt>
								<dd>{formatCost(spent)} — turns on models with no known rates are not counted.</dd>
							</>
						) : null}
					</dl>
					{meter?.warn ? <p className="ide-usage-warn">Close to the window. Run /compact.</p> : null}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

export function ComposerBar({
	attachOpen,
	onAttach,
	usage,
	spent,
	onTranscript,
	transcriptDisabled,
	onAnnounce,
}: ComposerBarProps) {
	/*
	 * The active profile, subscribed rather than read: `/profile <name>` and
	 * `/reload` both change it from somewhere this component cannot see, and a
	 * summary that quietly describes the profile from two minutes ago is worse
	 * than no summary. `onProfileChange` is the store the profile module already
	 * exposes for exactly this.
	 */
	const profile = useSyncExternalStore(onProfileChange, activeProfile);
	const profiles = listProfiles();

	return (
		<div className="ide-composer-bar">
			<button
				type="button"
				className={attachOpen ? 'ide-bar-button ide-bar-button-on' : 'ide-bar-button'}
				onClick={onAttach}
				aria-expanded={attachOpen}
				aria-label={attachOpen ? 'Close the file browser' : 'Attach a file'}
			>
				<Icon name="add" />
			</button>
			{/* Read-only, because each of the three is set somewhere else. */}
			<span className="ide-bar-summary" title="Model, reasoning effort, maximum context">
				{profileSummary(profile)}
			</span>
			<ContextRing usage={usage} spent={spent} />

			<span className="ide-bar-spacer" />

			{/*
			 * The plain-text transcript, on the right rather than gone.
			 *
			 * The Shell Guide names the three controls on the left and the profile
			 * selector on the right, and says nothing about this one — but it is the
			 * documented way out for anyone who cannot read a transcript of nested
			 * disclosures, so deleting it to match a mock's silence would remove an
			 * accessibility affordance to gain a pixel.
			 */}
			<button
				type="button"
				className="ide-bar-button ide-bar-button-text"
				onClick={onTranscript}
				disabled={transcriptDisabled}
			>
				Transcript
			</button>

			<Menu.Root>
				{/* No leading icon, per the Guide — the profile's name is the label. */}
				<Menu.Trigger className="ide-bar-button ide-bar-button-text" aria-label={`Profile: ${profile.name}`}>
					{profile.name}
					<Icon name="chevron-up" />
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Content className="ide-context-menu" side="top" align="end" sideOffset={6}>
						{profiles.map((candidate) => (
							<Menu.Item
								key={candidate.name}
								className="ide-context-menu-item"
								onSelect={() => {
									const result = activateProfile(candidate.name);
									onAnnounce?.(
										result.ok
											? `Switched to "${result.profile.name}". It applies from the next turn.`
											: result.reason
									);
								}}
							>
								<span className="ide-context-menu-mark">
									{candidate.name === profile.name ? <Icon name="check" /> : null}
								</span>
								{candidate.name}
							</Menu.Item>
						))}
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>
		</div>
	);
}
