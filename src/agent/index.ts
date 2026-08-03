// The agent seam. The chat UI talks to `AgentProvider` and never to a model, a
// network client, or a native command.
//
// The eleven kinds below are the contract settled in
// docs/wayfinder/pi-harness/tickets/05-event-contract.md and falsified against
// three live providers by the spike that preceded this slice. Providers adapt
// *down* to them; the contract does not widen to match whatever pi emits. That
// is what keeps a vocabulary which breaks in minor releases every couple of
// days from reaching the UI.

export type AgentEvent =
	/** One chunk of streamed prose. Chunks concatenate; they are not lines. */
	| { readonly kind: 'text'; readonly text: string }
	/**
	 * Reasoning, kept separate from prose. Folding it into `text` is a one-way
	 * door — the UI can collapse or hide it only if it arrives distinguishable.
	 */
	| { readonly kind: 'thinking'; readonly text: string }
	| {
			readonly kind: 'tool_start';
			readonly id: string;
			readonly name: string;
			readonly input: unknown;
	  }
	/** Progress for an in-flight tool. Correlated to `tool_start` by `id`. */
	| { readonly kind: 'tool_update'; readonly id: string; readonly partial: string }
	| {
			readonly kind: 'tool_end';
			readonly id: string;
			readonly result: string;
			readonly isError: boolean;
	  }
	/**
	 * The run is paused until `resolveApproval` is called. `id` is the tool call
	 * it belongs to, so an approval and its later `tool_end` are correlatable.
	 */
	| {
			readonly kind: 'approval';
			readonly id: string;
			readonly name: string;
			readonly input: unknown;
			/** Why this is being asked, when the reason is not simply the policy. */
			readonly reason?: string;
	  }
	/**
	 * Real provider numbers, not estimates. Surfaced because compaction anchors
	 * on them, so a context meter is free here and expensive to retrofit.
	 */
	| {
			readonly kind: 'usage';
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly contextTokens: number;
	  }
	/** History was summarised. Without this the transcript silently loses detail. */
	| { readonly kind: 'compacted'; readonly tokensBefore: number; readonly summary: string }
	/** A failure worth styling and acting on, rather than prose that reads like one. */
	| { readonly kind: 'error'; readonly message: string; readonly code?: string }
	| { readonly kind: 'complete' }
	| { readonly kind: 'cancelled' };

export interface AgentRun {
	cancel(): void;
	resolveApproval(approved: boolean): void;
}

export interface AgentProvider {
	start(prompt: string, onEvent: (event: AgentEvent) => void): AgentRun;
}

export { createAgentProvider } from './provider';
