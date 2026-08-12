// The protocol layer against a real `rust-analyzer` — tickets 33, 34 and 35.
//
// **`.smoke.ts`, not `.check.ts`, and the suffix is the point.** Everything
// named `.check.ts` is in `npm run check`: pure, fast, and true on any machine.
// This one spawns a language server and waits for it to index a crate, so it is
// neither fast nor machine-independent, and putting it in the suite would make
// the suite fail on a laptop that has not run
// `rustup component add rust-analyzer`.
//
//     node src/features/lsp/live.smoke.ts
//
// What it proves, and what it does not. It drives the *real* `Peer`,
// `protocol.ts` and `workspaceEdit.ts` against the real server, over this
// repo's own `src-tauri` crate: the handshake, capability negotiation,
// diagnostics, definition, hover, references and rename all happen for real.
// It does its own `Content-Length` framing, mirroring `lsp.rs`, because
// `client.ts` reaches for Tauri and cannot be imported under bare node — the
// framing itself is proven separately by `lsp::tests::speaks_to_a_real_language_server`.
//
// **It writes nothing.** A rename request asks the server what it *would*
// change and prints the count; applying is `applyReplacements`, which is not
// reached from here.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Peer } from './jsonrpc.ts';
import { fileIdFromUri, fileUri, toProblemSeverity, type LspDiagnostic } from './protocol.ts';
import { planWorkspaceEdit, toReplacement } from './workspaceEdit.ts';

const ROOT = resolve(import.meta.dirname, '../../../src-tauri');
const FILE = 'src/lsp.rs';
/** Indexing a crate cold is minutes on a bad day; this is a ceiling, not a wait. */
const TIMEOUT_MS = 240_000;

const server = spawn('rust-analyzer', {
	cwd: ROOT,
	stdio: ['pipe', 'pipe', 'ignore'],
});

/** Read `Content-Length` frames off stdout, the way `lsp.rs` does. */
let buffer = Buffer.alloc(0);
server.stdout.on('data', (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const header = buffer.indexOf('\r\n\r\n');
		if (header === -1) {
			return;
		}
		const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, header).toString())?.[1]);
		const start = header + 4;
		if (!Number.isFinite(length) || buffer.length < start + length) {
			return;
		}
		const body = buffer.subarray(start, start + length).toString();
		buffer = buffer.subarray(start + length);
		peer.receive(body);
	}
});

const diagnostics = new Map<string, readonly LspDiagnostic[]>();

const peer = new Peer(
	(body) => {
		server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`);
		server.stdin.write(body);
	},
	(method, params) => {
		if (method === 'textDocument/publishDiagnostics') {
			const payload = params as { uri: string; diagnostics: readonly LspDiagnostic[] };
			const id = fileIdFromUri(ROOT, payload.uri);
			if (id) {
				diagnostics.set(id, payload.diagnostics);
			}
		}
	}
);

/**
 * Retry until the server answers, or give up loudly.
 *
 * **Readiness is "it answered", not a progress notification.** rust-analyzer's
 * `$/progress` tokens are the obvious signal and they are the wrong one: they
 * only arrive if the client declared `window.workDoneProgress`, their names are
 * not part of the protocol, and none of that is what the caller actually needs
 * to know. Asking the real question until it has a real answer cannot go stale.
 */
async function settled<T>(what: string, ask: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + TIMEOUT_MS;
	for (;;) {
		const value = await ask().catch(() => undefined as T);
		if (value !== undefined && ready(value)) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out waiting for ${what}`);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
}

try {
	const initialized = (await peer.request('initialize', {
		processId: null,
		rootUri: fileUri(ROOT, ''),
		workspaceFolders: [{ uri: fileUri(ROOT, ''), name: 'workspace' }],
		capabilities: {
			textDocument: {
				synchronization: { didSave: true },
				publishDiagnostics: {},
				definition: {},
				references: {},
				hover: { contentFormat: ['markdown', 'plaintext'] },
				rename: {},
			},
		},
	})) as { capabilities: Record<string, unknown> };
	peer.notify('initialized', {});

	const advertised = initialized.capabilities;
	for (const capability of ['definitionProvider', 'referencesProvider', 'hoverProvider', 'renameProvider']) {
		assert.ok(advertised[capability], `rust-analyzer should advertise ${capability}`);
	}
	console.log('initialize        ok — definition, references, hover and rename all advertised');

	const text = readFileSync(resolve(ROOT, FILE), 'utf8');
	peer.notify('textDocument/didOpen', {
		textDocument: { uri: fileUri(ROOT, FILE), languageId: 'rust', version: 1, text },
	});

	/*
	 * Diagnostics need something to complain about, and this crate compiles, so
	 * a mistake is introduced — **in the server's copy of the document only**.
	 * `didChange` is how an editor tells a server about unsaved text; nothing is
	 * written and the file on disk is untouched.
	 *
	 * **A syntax error, not a type error, and that is a finding rather than a
	 * convenience.** `fn broken() -> i32 { "not an i32" }` produces nothing here:
	 * rust-analyzer's type errors come from flycheck, which runs `cargo check`
	 * **on save**, so an unsaved type error is invisible by design. What arrives
	 * on every keystroke is the native syntax diagnostics. Both reach the
	 * Problems panel by the same route; only their timing differs.
	 *
	 * **This runs before the queries below because it can.** Native syntax
	 * diagnostics arrive within a second of `didOpen`, while everything after
	 * this waits for the crate to be indexed — measured at **3m32s cold** on
	 * this repo's own `src-tauri`. Ordering the cheap check first is the
	 * difference between a smoke that reports something in seconds and one that
	 * reports nothing for four minutes.
	 *
	 * Push was separately confirmed to keep working *after* indexing — an edit
	 * made once the crate was loaded produced its diagnostics in 92ms — so
	 * `client.ts` relying on `publishDiagnostics` is not a startup-only trick.
	 * rust-analyzer also advertises a pull `diagnosticProvider`; nothing here
	 * uses it, and it is the fallback if push ever proves unreliable.
	 */
	peer.notify('textDocument/didChange', {
		textDocument: { uri: fileUri(ROOT, FILE), version: 2 },
		contentChanges: [{ text: `${text}\nfn broken( {\n` }],
	});

	const problems = await settled(
		'diagnostics for a deliberate syntax error',
		async () =>
			[...diagnostics].flatMap(([id, list]) =>
				list.flatMap((d) =>
					toProblemSeverity(d.severity)
						? [`${id} ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message.split('\n')[0]}`]
						: []
				)
			),
		(found) => found.length > 0
	);
	console.log(`diagnostics       ok — ${problems.length} worth showing, from an unsaved edit`);
	for (const problem of problems.slice(0, 3)) {
		console.log(`                     ${problem}`);
	}

	// Put the server back on the real text before asking it anything.
	peer.notify('textDocument/didChange', {
		textDocument: { uri: fileUri(ROOT, FILE), version: 3 },
		contentChanges: [{ text }],
	});

	// `read_frame`, which every Rust test in that file is about.
	const line = text.split('\n').findIndex((row) => row.startsWith('fn read_frame('));
	assert.ok(line > 0, 'read_frame should be in lsp.rs');
	const position = { line, character: 3 };
	const document = { textDocument: { uri: fileUri(ROOT, FILE) }, position };

	const hover = await settled(
		'the crate to be indexed',
		() => peer.request('textDocument/hover', document) as Promise<{ contents: { value: string } } | null>,
		(value) => value !== null
	);
	assert.match(hover!.contents.value, /read_frame/);
	console.log('hover             ok —', hover!.contents.value.split('\n').find((l) => l.includes('fn '))?.trim());

	// `Location`, `Location[]` and `LocationLink[]` are all legal replies, which
	// is why `client.ts` has a `locations()` helper; this only needs the first.
	type AnyLocation = { targetUri?: string; uri?: string };
	const definition = (await peer.request('textDocument/definition', document)) as
		| AnyLocation
		| AnyLocation[];
	const target = Array.isArray(definition) ? definition[0] : definition;
	const definitionId = fileIdFromUri(ROOT, (target?.targetUri ?? target?.uri) as string);
	assert.equal(definitionId, FILE);
	console.log('definition        ok —', definitionId);

	const references = (await peer.request('textDocument/references', {
		...document,
		context: { includeDeclaration: true },
	})) as { uri: string }[];
	const ids = references.map((r) => fileIdFromUri(ROOT, r.uri));
	assert.ok(ids.length >= 2, 'read_frame is called from the reader thread and the tests');
	assert.ok(ids.every((id) => id !== undefined), 'every reference is inside the root');
	console.log(`references        ok — ${ids.length}, all inside the root`);

	// Nothing is written. This asks what a rename *would* change.
	const edit = await peer.request('textDocument/rename', { ...document, newName: 'read_one_frame' });
	const plan = planWorkspaceEdit(edit as never, ROOT);
	assert.equal(plan.ok, true, plan.ok ? '' : plan.reason);
	assert.ok(plan.ok && plan.files.length >= 1);
	const [first] = plan.ok ? plan.files : [];
	const replacement = toReplacement(first!.id, readFileSync(resolve(ROOT, first!.id), 'utf8'), first!.edits);
	assert.ok(replacement, 'the edits should change the file');
	assert.match(replacement.modified, /fn read_one_frame\(/);
	assert.doesNotMatch(replacement.modified, /fn read_frame\(/);
	console.log(
		`rename            ok — ${replacement.count} edits in ${plan.ok ? plan.files.length : 0} file(s), previewed, nothing written`
	);

	peer.notify('textDocument/didClose', { textDocument: { uri: fileUri(ROOT, FILE) } });

	console.log('\nlive.smoke.ts ok');
} finally {
	peer.notify('exit');
	server.kill();
}
