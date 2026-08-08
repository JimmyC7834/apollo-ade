// The agent's filesystem authority, as pi's tools expect to find it.
//
// This is an adapter, which is why it may call Tauri directly — the same
// licence `workspace.ts`'s native provider has. Feature code above it sees only
// `ExecutionEnv`.
//
// Two implementations, deliberately: `createTauriEnv` for the real app, and
// `createMemoryEnv` so `npm run dev` runs the *real* harness and the *real*
// tools against fake files, rather than a parallel fiction that can drift.
// docs/wayfinder/pi-harness/tickets/10-browser-mode-env.md settled that shape.

import {
	ExecutionError,
	FileError,
	err,
	ok,
	type ExecutionEnv,
	type FileInfo,
	type Result,
} from '@earendil-works/pi-agent-core';

import { crop, cropNote } from './crop';

/*
 * The path namespace is workspace-root-relative, rooted at "/". The renderer
 * does not know the OS path of the root and must not learn it — Rust is the
 * only side that can name a real path. So "absolute" here means absolute
 * *within the workspace*, and a model asking for `C:\Users\...` gets a miss
 * rather than a read.
 */
const ROOT = '/';

/** Root-relative id, which is how every workspace command addresses a file. */
function toId(path: string): string {
	return path.replace(/^\/+/, '');
}

/** Scratch space, beside the session store and gitignored by the same rule. */
const TEMP_ROOT = '/.ade/tmp';

/** Enough to not collide; not a security property. */
function scratchName(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type ExecChunk =
	| { readonly kind: 'stdout'; readonly chunk: string }
	| { readonly kind: 'stderr'; readonly chunk: string };

interface ExecOutcome {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly truncated: boolean;
}

/** pi's fixed vocabulary; Rust returns one of these and nothing else. */
type ExecutionErrorCode = ConstructorParameters<typeof ExecutionError>[0];

interface PathMeta {
	readonly name: string;
	readonly path: string;
	readonly kind: FileInfo['kind'];
	readonly size: number;
	readonly mtimeMs: number;
}

function unsupported(method: string): Result<never, FileError> {
	return err(
		new FileError(
			'not_supported',
			`${method} is not implemented — this slice wires the read tool only`
		)
	);
}

/**
 * Everything the two implementations share: the path namespace, and the
 * methods no wired tool calls.
 *
 * They fail rather than pretend, because a silent empty answer to `listDir`
 * would read to the model as "the directory is empty" and send it down a wrong
 * path. `not_supported` is a fact the model can act on.
 */
function unimplementedRest() {
	return {
		cwd: ROOT,
		async absolutePath(path: string) {
			// Syntactic only, per the interface: the path need not exist.
			return ok<string, FileError>(path.startsWith(ROOT) ? path : ROOT + toId(path));
		},
		async readTextLines(path: string) {
			return unsupported(`readTextLines(${path})`);
		},
		async appendFile(path: string) {
			return unsupported(`appendFile(${path})`);
		},
		/**
		 * Purely syntactic, and shared by both environments because there is
		 * nothing environment-specific about joining strings. Forward slashes
		 * only: this namespace is the workspace's, not the OS's.
		 */
		async joinPath(parts: string[]) {
			const joined = parts
				.flatMap((part) => part.split('/'))
				.filter((segment) => segment !== '' && segment !== '.')
				.join('/');
			return ok<string, FileError>(ROOT + joined);
		},
		async listDir(path: string) {
			return unsupported(`listDir(${path})`);
		},
		async createDir(path: string) {
			return unsupported(`createDir(${path})`);
		},
		async remove(path: string) {
			return unsupported(`remove(${path})`);
		},
		async createTempDir() {
			return unsupported('createTempDir');
		},
		async createTempFile() {
			return unsupported('createTempFile');
		},
		async exec(): Promise<
			Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
		> {
			return err(
				new ExecutionError('shell_unavailable', 'the shell is not wired in this slice')
			);
		},
		async cleanup() {
			// Nothing to release. Must not throw.
		},
	};
}

/**
 * `canonicalPath` refuses to resolve outside the root.
 *
 * A symlink out of the workspace is the obvious escape from root confinement,
 * and Rust's resolver refuses symlinks outright — so there is nothing here to
 * canonicalise that is not already the canonical answer. Returning the input
 * would be a lie the moment Rust's policy softens; refusing is honest and
 * matches the boundary the repo already enforces.
 */
function canonicalPath(path: string): Promise<Result<string, FileError>> {
	return Promise.resolve(
		err(new FileError('not_supported', 'symlinks are not resolved inside the workspace', path))
	);
}

export function createTauriEnv(): ExecutionEnv {
	const core = () => import('@tauri-apps/api/core');

	/*
	 * The single conversion point. `invoke` *rejects* on `Err` and pi requires a
	 * `Result`, so no method below may call `invoke` directly. This is also the
	 * cheapest way to keep the never-throw invariant true as methods are added.
	 *
	 * Worth knowing: pi's own tools convert back, wrapping `absolutePath` and
	 * `exists` in `getOrThrow`. The invariant binds *this* adapter, not pi's
	 * internals — we still may not throw, but a `Result` does not travel all the
	 * way up.
	 */
	async function attempt<T>(path: string, run: () => Promise<T>): Promise<Result<T, FileError>> {
		try {
			return ok(await run());
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			// Rust says "not found" for both an absent file and one the resolver
			// refused. Mapping it to `not_found` is right for the first and
			// close enough for the second, which the model cannot act on
			// differently anyway.
			const code = message === 'not found' ? 'not_found' : 'unknown';
			return err(new FileError(code, message, path));
		}
	}

	const stat = async (path: string) =>
		attempt(path, async () =>
			(await core()).invoke<PathMeta | null>('stat_path', { id: toId(path) })
		);

	const readText = async (path: string) =>
		attempt(path, async () => (await core()).invoke<string>('read_file', { id: toId(path) }));

	return {
		...unimplementedRest(),
		canonicalPath,

		async exists(path) {
			const result = await stat(path);
			// A miss is `false`; other failures stay errors. The interface is
			// explicit about that distinction, and `stat_path` preserves it by
			// returning null for absent rather than rejecting.
			return result.ok ? ok(result.value !== null) : result;
		},

		async fileInfo(path) {
			const result = await stat(path);
			if (!result.ok) {
				return result;
			}
			return result.value
				? ok({ ...result.value, path: ROOT + result.value.path })
				: err(new FileError('not_found', 'not found', path));
		},

		readTextFile: readText,

		/*
		 * The four below exist for the session store rather than for a tool. They
		 * are what `JsonlSessionRepo` needs on top of read and write, and they are
		 * deliberately the *only* four added — `remove` stays unsupported, so the
		 * repo's `delete` fails loudly rather than the app growing a way to erase
		 * files nothing asks it to erase.
		 */
		async readTextLines(path, options) {
			return attempt(path, async () =>
				(await core()).invoke<string[]>('read_text_lines', {
					id: toId(path),
					maxLines: options?.maxLines ?? null,
				})
			);
		},

		async appendFile(path, content) {
			if (typeof content !== 'string') {
				return err(new FileError('not_supported', 'binary appends are not supported', path));
			}
			return attempt(path, async () =>
				(await core()).invoke<void>('agent_append_file', { id: toId(path), content })
			);
		},

		async createDir(path) {
			return attempt(path, async () =>
				(await core()).invoke<void>('agent_create_dir', { id: toId(path) })
			);
		},

		async listDir(path) {
			const result = await attempt(path, async () =>
				(await core()).invoke<PathMeta[]>('agent_list_dir', { id: toId(path) })
			);
			return result.ok
				? ok(result.value.map((meta) => ({ ...meta, path: ROOT + meta.path })))
				: result;
		},

		/*
		 * Temporary files live *inside* the workspace, under the same gitignored
		 * directory as the session store. pi's bash tool writes overflow output to
		 * one and then hands the model its path — and the model will try to `read`
		 * it, which only works if the path obeys the same containment the read
		 * tool does. An OS temp path would be refused by the resolver.
		 */
		async createTempDir(prefix = 'tmp-') {
			const path = `${TEMP_ROOT}/${prefix}${scratchName()}`;
			const created = await this.createDir(path);
			return created.ok ? ok(path) : created;
		},

		async createTempFile(options) {
			const path = `${TEMP_ROOT}/${options?.prefix ?? ''}${scratchName()}${options?.suffix ?? ''}`;
			const created = await this.writeFile(path, '');
			return created.ok ? ok(path) : created;
		},

		/**
		 * Run one command.
		 *
		 * pi owns capture, truncation, throttled progress and overflow on top of
		 * this — `executeShellWithCapture` does all of it — so the only jobs here
		 * are streaming chunks through and translating a rejection back into the
		 * fixed error vocabulary pi expects.
		 */
		async exec(command, options) {
			const { Channel, invoke } = await core();
			const id = crypto.randomUUID();

			const channel = new Channel<ExecChunk>();
			channel.onmessage = (event) => {
				if (event.kind === 'stdout') {
					options?.onStdout?.(event.chunk);
				} else {
					options?.onStderr?.(event.chunk);
				}
			};

			// Cancellation is a second command rather than anything on the first:
			// an in-flight `invoke` cannot be withdrawn, so Rust has to be told
			// separately which child to kill.
			const stop = () => void invoke('agent_exec_cancel', { id }).catch(() => {});
			options?.abortSignal?.addEventListener('abort', stop, { once: true });

			try {
				const outcome = await invoke<ExecOutcome>('agent_exec', {
					id,
					request: {
						command,
						cwd: options?.cwd ? toId(options.cwd) : null,
						env: options?.env ?? {},
						inheritEnv: options?.inheritEnv ?? true,
						timeout: options?.timeout ?? null,
					},
					onEvent: channel,
				});

				/*
				 * The crop goes here, and the position is the decision.
				 *
				 * Above it, `onStdout` has already streamed the raw chunks to the
				 * UI, so the human sees everything and only the model sees less —
				 * which is the asymmetry worth having. Below it, pi's bash tool
				 * applies its own 2000-line / 50 KB cap. Semantic first, then
				 * positional: crop the noise and the cap rarely fires, cap first
				 * and the interesting last thirty lines are already gone.
				 */
				const cropped = crop(command, outcome.stdout);
				const note = cropNote(outcome.stdout, cropped);
				if (note) {
					// The measurement, and the only one there is. Every crop leaves
					// its numbers somewhere a person can read them, so which rule to
					// write next stops being an argument. See ticket 11.
					console.debug(`crop ${JSON.stringify(command)} ${note}`);
				}

				return ok({
					stdout: cropped.text,
					// Both said out loud rather than left as a silent short read:
					// the model has to know its output stops early or arrives
					// filtered, or it will draw conclusions from a partial log.
					stderr: [outcome.stderr, note, outcome.truncated && '[output truncated at 8 MiB]']
						.filter(Boolean)
						.join('\n'),
					exitCode: outcome.exitCode,
				});
			} catch (cause) {
				const failure = cause as { code?: string; message?: string };
				return err(
					new ExecutionError(
						(failure?.code as ExecutionErrorCode) ?? 'unknown',
						failure?.message ?? String(cause)
					)
				);
			} finally {
				options?.abortSignal?.removeEventListener('abort', stop);
			}
		},

		async writeFile(path, content) {
			// pi hands `string | Uint8Array`. Rust takes text, so binary writes
			// are refused rather than silently mangled through a lossy decode —
			// the edit and write tools only ever produce text.
			if (typeof content !== 'string') {
				return err(
					new FileError('not_supported', 'binary writes are not supported', path)
				);
			}
			return attempt(path, async () =>
				(await core()).invoke<void>('agent_write_file', { id: toId(path), content })
			);
		},

		async readBinaryFile(path) {
			/*
			 * Text only. `read_file` refuses non-UTF-8, so pi's image handling in
			 * the read tool cannot fire and an image reads as an error rather
			 * than as a picture. That is a real gap, and it is deliberate: the
			 * fix is a Rust command returning bytes, which belongs with the
			 * slice that wants images rather than this one.
			 */
			const result = await readText(path);
			return result.ok ? ok(new TextEncoder().encode(result.value)) : result;
		},
	};
}

/**
 * An in-memory environment over a fixed file map, for `npm run dev`.
 *
 * The point is that the browser runs the *real* harness and the *real* read
 * tool — only the disk is fake. A hand-written script pretending to be an agent
 * would drift from the native path silently; this cannot, because it is the
 * same code above the seam.
 */
export function createMemoryEnv(seed: Readonly<Record<string, string>>): ExecutionEnv {
	// Copied, and writes land in the copy. Browser mode has to be able to
	// demonstrate an edit, and mutating the shared fixture would leak one
	// session's changes into the explorer's view of the same files.
	const files: Record<string, string> = { ...seed };
	const get = (path: string) => files[toId(path)];

	return {
		...unimplementedRest(),
		canonicalPath,

		async exists(path) {
			return ok(get(path) !== undefined);
		},

		async fileInfo(path) {
			const content = get(path);
			if (content === undefined) {
				return err(new FileError('not_found', 'not found', path));
			}
			const id = toId(path);
			return ok({
				name: id.split('/').pop() ?? id,
				path: ROOT + id,
				kind: 'file',
				size: content.length,
				mtimeMs: 0,
			});
		},

		async readTextFile(path) {
			const content = get(path);
			return content === undefined
				? err(new FileError('not_found', 'not found', path))
				: ok(content);
		},

		async readBinaryFile(path) {
			const content = get(path);
			return content === undefined
				? err(new FileError('not_found', 'not found', path))
				: ok(new TextEncoder().encode(content));
		},

		async writeFile(path, content) {
			if (typeof content !== 'string') {
				return err(
					new FileError('not_supported', 'binary writes are not supported', path)
				);
			}
			files[toId(path)] = content;
			return ok(undefined);
		},
	};
}
