// SPIKE — delete with `rm -r src/spike`. See
// docs/wayfinder/pi-harness/tickets/12-walking-skeleton.md.
//
// An `ExecutionEnv` over the existing `WorkspaceProvider`, implementing only
// what `createReadTool` actually calls: `absolutePath`, `exists`,
// `readBinaryFile`, and `cwd`. Everything else returns a `FileError` so the
// first real caller of an unimplemented method shows up as a tool error in the
// transcript rather than as a crash — which is the never-throw invariant doing
// its job, and is exactly what this spike is here to observe.

import { ExecutionError, FileError, err, ok, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { WorkspaceProvider } from '../workspace';

/*
 * The path namespace is workspace-root-relative, rooted at "/". The renderer
 * does not know the OS path of the root and must not learn it — that is the
 * boundary commit 639ce9a established. So "absolute" here means absolute
 * *within the workspace*, and Rust remains the only side that can name a real
 * path. A model asking for `C:\Users\...` gets a miss rather than a read.
 */
const ROOT = '/';

/** Root-relative id for `WorkspaceProvider`, which addresses files without a leading slash. */
function toId(path: string): string {
	return path.replace(/^\/+/, '');
}

function notImplemented(method: string) {
	return err<never, FileError>(
		new FileError('not_supported', `SPIKE: ${method} is not implemented by the spike env`)
	);
}

export function createSpikeEnv(workspace: WorkspaceProvider): ExecutionEnv {
	// One conversion point. `invoke` rejects on `Err` and pi requires a
	// `Result`, so nothing below is allowed to call the provider directly.
	async function attempt<T>(path: string, run: () => Promise<T>) {
		try {
			return ok<T, FileError>(await run());
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			return err<T, FileError>(new FileError('unknown', message, path));
		}
	}

	return {
		cwd: ROOT,

		async absolutePath(path) {
			// Syntactic only, per the interface: the path need not exist.
			return ok(path.startsWith(ROOT) ? path : ROOT + toId(path));
		},

		async exists(path) {
			const result = await attempt(path, () => workspace.readFile(toId(path)));
			// A miss is `false`, not an error — the interface is explicit that
			// only *other* failures (permissions, backend faults) are errors.
			// The spike cannot tell the two apart through `readFile`, so it
			// reports every failure as "absent" and accepts the imprecision.
			return ok(result.ok);
		},

		async readBinaryFile(path) {
			const result = await attempt(path, () => workspace.readFile(toId(path)));
			return result.ok ? ok(new TextEncoder().encode(result.value.content)) : result;
		},

		// Unimplemented. `read` never reaches these; a caller that does is a
		// finding worth recording rather than a gap worth filling in advance.
		async readTextFile(path) {
			return notImplemented(`readTextFile(${path})`);
		},
		async readTextLines(path) {
			return notImplemented(`readTextLines(${path})`);
		},
		async writeFile(path) {
			return notImplemented(`writeFile(${path})`);
		},
		async appendFile(path) {
			return notImplemented(`appendFile(${path})`);
		},
		async joinPath() {
			return notImplemented('joinPath');
		},
		async fileInfo(path) {
			return notImplemented(`fileInfo(${path})`);
		},
		async listDir(path) {
			return notImplemented(`listDir(${path})`);
		},
		async canonicalPath(path) {
			return notImplemented(`canonicalPath(${path})`);
		},
		async createDir(path) {
			return notImplemented(`createDir(${path})`);
		},
		async remove(path) {
			return notImplemented(`remove(${path})`);
		},
		async createTempDir() {
			return notImplemented('createTempDir');
		},
		async createTempFile() {
			return notImplemented('createTempFile');
		},
		// `exec` carries its own error type, so it cannot share `notImplemented`.
		// No `bash` tool is registered in the spike; this exists to satisfy the
		// interface and to fail loudly if that stops being true.
		async exec() {
			return err(new ExecutionError('shell_unavailable', 'SPIKE: exec is out of scope'));
		},
		async cleanup() {
			// Nothing to release. Must not throw.
		},
	};
}
