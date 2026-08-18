// The composer's bottom bar — ticket 42. Exactly 32px, and the height is the
// point: it sits *outside* the input surface, so the input can grow and the bar
// stays where the hand expects it.
//
//     [attach][profile summary][context ring]        [transcript][profile]
//
// The three left controls are independent transparent buttons rather than a
// segmented container: two of them do something and one is a label, and a
// segment around all three would say they are alternatives.

import { useRef, useSyncExternalStore } from 'react';

import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';

import { pressure } from '../../agent/compaction';
import { listProfiles, type Profile, type ProfileSelection } from '../../agent/profile';
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
	/**
	 * The focused conversation's profile — ticket 50.
	 *
	 * Passed in rather than read from the module store, because there is no
	 * longer one active profile in a window: the control shows and changes the
	 * profile of the session on screen, and a background session's harness is
	 * never retuned by anything done here.
	 */
	readonly profile: ProfileSelection;
	/** Open the configuration modal — on a profile to edit it, on nothing to create. */
	readonly onEditProfile: (profile?: Profile) => void;
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
				<svg className="ide-ring" viewBox="0 0 18 18" width="13" height="13" aria-hidden="true">
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
	onEditProfile,
	profile: selection,
}: ComposerBarProps) {
	/*
	 * This session's profile, subscribed rather than read: `/profile <name>` and
	 * `/reload` both change it from somewhere this component cannot see, and a
	 * summary that quietly describes the profile from two minutes ago is worse
	 * than no summary. The selection is the store, and it is the session's own.
	 */
	const profile: Profile = useSyncExternalStore(selection.subscribe, selection.current);
	const profiles = listProfiles();
	/**
	 * Whether the press that is about to select a row landed on its edit icon.
	 *
	 * A ref rather than state: it is read inside the same gesture that sets it and
	 * nothing renders differently for it, so a re-render would be work for nobody.
	 * Cleared when the menu closes as well as when it is used, so an abandoned
	 * press cannot make the *next* row open the modal.
	 */
	const editIntent = useRef(false);

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

			<Menu.Root
				onOpenChange={() => {
					editIntent.current = false;
				}}
			>
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
								className="ide-context-menu-item ide-profile-row"
								onSelect={() => {
									/*
									 * Which of the row's two actions this was.
									 *
									 * Radix's menu item **synthesises a click on itself** from
									 * `onPointerUp` whenever the pointer-down did not land on
									 * it — so stopping the event on the icon does not stop the
									 * selection, it only hides where the press came from. The
									 * icon therefore records the intent and the item acts on
									 * it, which leaves exactly one thing deciding what a press
									 * on this row means.
									 */
									if (editIntent.current) {
										editIntent.current = false;
										onEditProfile(candidate);
										return;
									}
									const result = selection.activate(candidate.name);
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
								{/*
								 * Overlaid, hover-only, and **absolutely positioned so its
								 * appearance cannot change the row's width** — the fifth
								 * appearance of the non-shifting rule.
								 *
								 * Not a button. It records which action the press meant and
								 * the menu item performs it; a nested control would be a
								 * second thing to press inside something already pressable,
								 * and a tab stop Radix's roving focus does not know about.
								 * `title` rather than `aria-label`, since it names the
								 * region of a row rather than a control of its own — the
								 * keyboard route is the item below.
								 */}
								<span
									className="ide-profile-edit"
									aria-hidden={true}
									title={`Edit ${candidate.name}`}
									onPointerDown={() => {
										editIntent.current = true;
									}}
								>
									<Icon name="edit" />
								</span>
							</Menu.Item>
						))}
						<Menu.Separator className="ide-context-menu-separator" />
						{/*
						 * The keyboard's way to the same modal. The overlaid edit icon is a
						 * hover affordance and hover is a pointer, so without this a
						 * keyboard user could create a profile and never edit one. It acts
						 * on the active profile, which is the one just above with the mark.
						 */}
						<Menu.Item
							className="ide-context-menu-item"
							onSelect={() => onEditProfile(selection.current())}
						>
							<span className="ide-context-menu-mark" />
							Edit “{profile.name}”…
						</Menu.Item>
						<Menu.Item className="ide-context-menu-item" onSelect={() => onEditProfile()}>
							<span className="ide-context-menu-mark" />
							New profile…
						</Menu.Item>
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>
		</div>
	);
}
