// SPIKE — delete with `rm -r src/spike`. See
// docs/wayfinder/pi-harness/tickets/06-credentials-and-http.md.
//
// A `fetch`-shaped function that routes the provider request through Rust, so
// the API key never enters JavaScript. pi accepts a custom `fetch` on its
// stream options, so this needs no changes inside pi at all — the injection
// point is `ProviderStreams`, which is exactly the seam ticket 06 named.

import { Channel, invoke } from '@tauri-apps/api/core';

type ProviderEvent =
	| { readonly kind: 'head'; readonly status: number; readonly headers: Record<string, string> }
	| { readonly kind: 'chunk'; readonly bytes: number[] }
	| { readonly kind: 'end' }
	| { readonly kind: 'error'; readonly message: string };

/**
 * Fetch through the Rust proxy.
 *
 * Returns as soon as the response head arrives, with a body that is still
 * streaming — the same contract as real `fetch`. Resolving only at `end` would
 * turn a streamed turn back into a blocking one and defeat the point.
 */
export const rustFetch: typeof fetch = async (input, init) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, name) => {
		headers[name] = value;
	});

	let onHead: (response: Response) => void;
	let onFailure: (error: Error) => void;
	const head = new Promise<Response>((resolve, reject) => {
		onHead = resolve;
		onFailure = reject;
	});

	/*
	 * The stream is built here rather than inside the channel callback because
	 * `start` gives us the controller, and events can arrive before any
	 * consumer has called `read`. A ReadableStream buffers for us; a hand-rolled
	 * queue would have to.
	 */
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(streamController) {
			controller = streamController;
		},
	});

	// Guards against a late chunk arriving after `end` or `error` and throwing
	// on a closed controller — which would surface as an unhandled rejection
	// rather than a stream error.
	let closed = false;
	const close = (error?: Error) => {
		if (closed) {
			return;
		}
		closed = true;
		if (error) {
			controller.error(error);
			onFailure(error);
		} else {
			controller.close();
		}
	};

	const channel = new Channel<ProviderEvent>();
	channel.onmessage = (event) => {
		if (event.kind === 'head') {
			onHead(
				new Response(body, {
					status: event.status,
					headers: event.headers,
				})
			);
		} else if (event.kind === 'chunk') {
			if (!closed) {
				controller.enqueue(new Uint8Array(event.bytes));
			}
		} else if (event.kind === 'end') {
			close();
		} else {
			close(new Error(event.message));
		}
	};

	// A rejected `invoke` here means the command never ran — a missing key, a
	// malformed argument. Failures *during* the stream arrive as an `error`
	// event instead, because by then the head has already been handed out.
	invoke('provider_stream', {
		request: { url, headers, body: typeof init?.body === 'string' ? init.body : undefined },
		onEvent: channel,
	}).catch((cause: unknown) => {
		close(cause instanceof Error ? cause : new Error(String(cause)));
	});

	return head;
};

/*
 * Reachable from the WebView2 debugging port, so the proxy can be exercised
 * without driving the chat UI. Dev-only, and it goes when the spike does.
 *
 * This exists because the interesting property — that chunks arrive
 * incrementally rather than in one lump at the end — is invisible in the
 * transcript. A stream and a buffered response render identically.
 */
if (import.meta.env.DEV) {
	(globalThis as unknown as { __spikeFetch?: typeof fetch }).__spikeFetch = rustFetch;
}
