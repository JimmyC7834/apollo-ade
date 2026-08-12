// Which workspace file a Monaco model is showing.
//
// Markers arrive addressed by model URI, and a model's URI here is whatever
// Monaco auto-generated (`inmemory://model/3`) — it says nothing about the file.
// Giving models a URI built from the id would have been the obvious alternative
// and does not work: the same file can be open in the Modal Workbench and pinned
// in the dock at once, and `createModel` throws on a duplicate URI.
//
// So the mapping is recorded instead, by the one place that creates models.
// Many-to-one on purpose: two models over one path is the normal case above, and
// the duplicate markers it produces are deduplicated where they are grouped.

const idByUri = new Map<string, string>();

/** Called by `MonacoEditor` as it creates a model. */
export function registerModel(uri: string, fileId: string): void {
	idByUri.set(uri, fileId);
}

/**
 * Called as a model is disposed. Not optional: a WebView that never forgot a
 * model would keep reporting problems for files nobody has open.
 */
export function unregisterModel(uri: string): void {
	idByUri.delete(uri);
}

/** The file a model URI belongs to, or undefined if it is not a workspace file. */
export function fileIdForModel(uri: string): string | undefined {
	return idByUri.get(uri);
}
