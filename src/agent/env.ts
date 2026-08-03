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
		async writeFile(path: string) {
			return unsupported(`writeFile(${path})`);
		},
		async appendFile(path: string) {
			return unsupported(`appendFile(${path})`);
		},
		async joinPath() {
			return unsupported('joinPath');
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
export function createMemoryEnv(files: Readonly<Record<string, string>>): ExecutionEnv {
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
	};
}
