// The explorer's file operations, minus the filesystem — ticket 29.
//
// Everything here is a pure decision about ids and prose, kept out of the React
// component for the usual reason: renaming a *folder* has to move every open
// editor underneath it, and that is a rule about strings that is much easier to
// get wrong than to assert.

import { basename, dirname } from '../../ids.ts';

/** What Rust's `delete_plan` reported about a path, before anything happens. */
export interface DeletePlan {
	readonly kind: 'file' | 'directory';
	/** Entries underneath, directories included. Zero for a file. */
	readonly entries: number;
	/** The count stopped early — `entries` is a floor. */
	readonly capped: boolean;
	/**
	 * Open editors under this path holding unsaved changes.
	 *
	 * **Not from Rust.** The workbench fills it in, because it is the only side
	 * that knows what is open — and the trash makes the *file* recoverable while
	 * an unsaved buffer is the one thing in this operation that is not.
	 */
	readonly unsaved?: number;
}

/**
 * Why a name cannot be used, or undefined when it can.
 *
 * A name, not a path: the explorer creates and renames *within* a directory, and
 * a field that quietly accepted `../` would be handing the renderer a way to
 * name a path outside the root. Rust refuses that too — this exists so the
 * refusal is a message next to the field rather than an error after the fact.
 */
export function nameProblem(name: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed === '') {
		return 'Give it a name.';
	}
	if (trimmed.includes('/') || trimmed.includes('\\')) {
		return 'A name cannot contain a slash.';
	}
	if (trimmed === '.' || trimmed === '..') {
		return 'That name is reserved.';
	}
	return undefined;
}

/** Where a new entry named `name` lands, given the directory it was invoked on. */
export function childId(parentId: string | undefined, name: string): string {
	const trimmed = name.trim();
	return parentId ? `${parentId}/${trimmed}` : trimmed;
}

/** The id `id` takes when its last segment is replaced. */
export function renamedId(id: string, name: string): string {
	return childId(dirname(id), name);
}

/**
 * Whether `id` is `ancestor` itself, or lives inside it.
 *
 * The prefix test is on `${ancestor}/` rather than on `ancestor`, so acting on
 * `src` does not also take `src-old/x.ts` — the bug this function exists to make
 * impossible, and the reason both callers go through it instead of writing
 * `startsWith` twice.
 */
export function isUnder(id: string, ancestor: string): boolean {
	return id === ancestor || id.startsWith(`${ancestor}/`);
}

/**
 * The id an open editor should now have, after `from` became `to`. Undefined
 * when the editor is unaffected.
 */
export function movedId(id: string, from: string, to: string): string | undefined {
	return isUnder(id, from) ? `${to}${id.slice(from.length)}` : undefined;
}

/**
 * What the confirmation says before a delete.
 *
 * It says where the entry is going, because that is the fact that decides
 * whether to click: this delete is recoverable, and a dialog that only warned
 * would be talking the user out of an action that is not actually final.
 */
export function deleteMessage(id: string, plan: DeletePlan, toTrash: boolean): string {
	const name = basename(id);
	/*
	 * Whether the delete is recoverable is a property of the workspace, not of
	 * this app: natively it goes to the OS trash, and the browser fixture has no
	 * trash to put anything in. Saying "you can put it back" where that is false
	 * would be the one sentence here that changes what someone decides.
	 */
	const trash = toTrash
		? 'It goes to the trash, so you can put it back from there.'
		: 'This workspace has no trash, so it is simply gone.';
	/*
	 * The one part of this that is not recoverable, so it is said last, where a
	 * warning is read, rather than folded into the count.
	 */
	const unsaved = plan.unsaved
		? ` ${plan.unsaved} open ${plan.unsaved === 1 ? 'editor has' : 'editors have'} unsaved changes, and those are lost.`
		: '';
	if (plan.kind === 'file') {
		return `Delete ${name}? ${trash}${unsaved}`;
	}
	const inside =
		plan.entries === 0
			? 'It is empty.'
			: `It has ${plan.capped ? 'more than ' : ''}${plan.entries} ${
					plan.entries === 1 ? 'item' : 'items'
				} inside it, and they go too.`;
	return `Delete the folder ${name}? ${inside} ${trash}${unsaved}`;
}
