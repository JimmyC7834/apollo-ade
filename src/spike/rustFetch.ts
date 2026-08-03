// SPIKE — delete with `rm -r src/spike`. See
// docs/wayfinder/pi-harness/tickets/06-credentials-and-http.md.
//
// A `fetch`-shaped function that routes the provider request through Rust, so
// the API key never enters JavaScript.
//
// Ticket 06 expected the injection point to be pi's stream options. It is not,
// or not only: the Google adapters refuse an injected `fetch` and accept
// `globalThis.fetch` alone, so interception has to be global and scoped by
// host. pi still needs no changes.

import { Channel, invoke } from '@tauri-apps/api/core';

/**
 * Which host belongs to which pi provider id.
 *
 * Interception is by host rather than by wrapping pi's stream options, because
 * **the stream-option seam does not generalise**. `google-generative-ai` and
 * `google-vertex` reject a custom `fetch` outright — they delegate to
 * `@google/genai`, which does its own fetching — and their check is
 * `options.fetch !== globalThis.fetch`, so the global is the one implementation
 * they will accept.
 *
 * The cost is a patched global, which is the kind of thing worth flinching at.
 * It is bounded two ways: only these hosts are diverted, and everything else
 * goes to the original `fetch` untouched.
 */
const PROVIDER_HOSTS: Readonly<Record<string, string>> = {
	'api.deepseek.com': 'deepseek',
	'api.anthropic.com': 'anthropic',
	'generativelanguage.googleapis.com': 'google',
};

/**
 * Route provider traffic through Rust, for every adapter regardless of whether
 * it accepts an injected `fetch`. Idempotent — HMR re-runs module bodies, and
 * wrapping a wrapper would nest the interception.
 */
export function installRustFetch(): void {
	const patched = globalThis as unknown as { __rustFetchInstalled?: boolean };
	if (patched.__rustFetchInstalled) {
		return;
	}
	patched.__rustFetchInstalled = true;

	const original = globalThis.fetch.bind(globalThis);
	globalThis.fetch = (input, init) => {
		const href =
			typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		let provider: string | undefined;
		try {
			provider = PROVIDER_HOSTS[new URL(href, location.href).hostname];
		} catch {
			// Not a URL we can parse — not ours to divert.
		}
		return provider ? rustFetchFor(provider)(input, init) : original(input, init);
	};
}

type ProviderEvent =
	| { readonly kind: 'head'; readonly status: number; readonly headers: Record<string, string> }
	| { readonly kind: 'chunk'; readonly bytes: number[] }
	| { readonly kind: 'end' }
	| { readonly kind: 'error'; readonly message: string };

/**
 * Fetch through the Rust proxy, for one provider.
 *
 * The provider id is a parameter because the credential differs by provider —
 * Anthropic wants `x-api-key`, Google `x-goog-api-key`, OpenAI-shaped APIs a
 * bearer token. The renderer names the provider; Rust chooses the key.
 *
 * Returns as soon as the response head arrives, with a body that is still
 * streaming — the same contract as real `fetch`. Resolving only at `end` would
 * turn a streamed turn back into a blocking one and defeat the point.
 */
export const rustFetchFor = (provider: string): typeof fetch => async (input, init) => {
	/*
	 * Normalise through `Request` rather than reading `input`/`init` directly.
	 * The two SDKs disagree on how they call `fetch`: the OpenAI one passes a
	 * string body in `init`, `@google/genai` does not. An earlier version only
	 * forwarded `init.body` when it was already a string, so Google requests
	 * went out with no body at all and came back as a 500 — a failure that
	 * looked like Google's fault and was not.
	 *
	 * `Request` also merges headers, resolves relative URLs, and carries the
	 * method, so none of those need handling separately.
	 */
	const request = new Request(input, init);
	const url = request.url;
	const method = request.method;
	const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text();

	const headers: Record<string, string> = {};
	request.headers.forEach((value, name) => {
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
	const responseBody = new ReadableStream<Uint8Array>({
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
				new Response(responseBody, {
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
		request: { provider, url, method, headers, body },
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
	(globalThis as unknown as { __spikeFetchFor?: (provider: string) => typeof fetch }).__spikeFetchFor =
		rustFetchFor;
}
