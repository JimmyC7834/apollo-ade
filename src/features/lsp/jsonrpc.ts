// JSON-RPC over a pair of opaque strings — ticket 33.
//
// `lsp.rs` carries framing and nothing above it: it hands up one message body
// per event and writes one back down. This is the layer directly above, and it
// is deliberately the whole of the protocol machinery — correlating replies to
// requests, routing notifications, and failing every outstanding request when
// the peer dies.
//
// No Monaco, no Tauri, no LSP. A `Peer` is a request/response correlator over
// `write`, which is what lets `jsonrpc.check.ts` exercise the parts that lose
// work if they are wrong — a promise that never settles, or one settled twice —
// under bare `node` with a fake sink.

export type Json = unknown;

interface Pending {
	readonly resolve: (result: Json) => void;
	readonly reject: (error: Error) => void;
}

/** A JSON-RPC error object, as it arrives on the wire. */
interface RpcError {
	readonly code: number;
	readonly message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * One conversation with one server.
 *
 * Ids are numbers and monotonic per peer. They do not have to be globally
 * unique — the id space belongs to the side that issues the request — so a
 * counter is enough and a uuid would only be longer.
 */
export class Peer {
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private closed = false;

	private readonly write: (body: string) => void;
	/** Server-to-client requests and notifications. */
	private readonly onNotification: (method: string, params: Json) => void;

	// Written out rather than as constructor parameter properties, which the
	// `.check.ts` scripts cannot run: node strips types, it does not compile
	// them, so a parameter property is a syntax error under bare node.
	constructor(
		write: (body: string) => void,
		onNotification: (method: string, params: Json) => void
	) {
		this.write = write;
		this.onNotification = onNotification;
	}

	/** Fire and forget. A notification has no id and no reply, by definition. */
	notify(method: string, params?: Json): void {
		if (this.closed) {
			return;
		}
		this.write(JSON.stringify({ jsonrpc: '2.0', method, params }));
	}

	/**
	 * Ask, and settle when the reply arrives.
	 *
	 * There is no timeout. A language server that has stopped answering is a
	 * server that has stopped, and `fail` is how that is reported — a timeout
	 * here would turn a slow first request during indexing, which is normal and
	 * can take a minute on a large crate, into a spurious error.
	 */
	request(method: string, params?: Json): Promise<Json> {
		if (this.closed) {
			return Promise.reject(new Error('the language server is not running'));
		}
		const id = this.nextId++;
		return new Promise<Json>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
			} catch (error) {
				// The write threw, so no reply is ever coming for this id. Settling
				// here rather than leaving it pending is the difference between one
				// rejected promise and a caller that hangs forever.
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** One message body from the server. Malformed JSON is dropped, not thrown. */
	receive(body: string): void {
		let message: unknown;
		try {
			message = JSON.parse(body);
		} catch {
			return;
		}
		if (!isObject(message)) {
			return;
		}

		// A server-to-client *request* also has an id, and answering it is not
		// implemented — but it must not be mistaken for a reply to one of ours.
		// The discriminator is `method`: replies never carry one.
		if (typeof message.method === 'string') {
			this.onNotification(message.method, message.params);
			return;
		}

		if (typeof message.id !== 'number') {
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) {
			return; // A reply to a request this peer never made, or made twice.
		}
		this.pending.delete(message.id);
		if (isObject(message.error)) {
			const error = message.error as unknown as RpcError;
			pending.reject(new Error(error.message || `error ${error.code}`));
		} else {
			pending.resolve(message.result);
		}
	}

	/**
	 * The peer is gone. Every outstanding request fails, and nothing else is
	 * ever sent.
	 *
	 * Failing the pending requests is the point. A crashed server leaves them
	 * unsettled otherwise, and an unsettled `textDocument/definition` is a
	 * click that does nothing forever with no way to tell.
	 */
	fail(reason: string): void {
		this.closed = true;
		const outstanding = [...this.pending.values()];
		this.pending.clear();
		for (const { reject } of outstanding) {
			reject(new Error(reason));
		}
	}
}
