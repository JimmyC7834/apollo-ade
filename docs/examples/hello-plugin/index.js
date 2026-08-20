/*
 * The smallest plugin that uses all three of what tickets 72 and 73 built.
 *
 * It lives in `.ade/plugins/`, which makes it a **local** plugin: this repository
 * carries it, and it is listed and inert until somebody enables it for this root
 * in the Plugins artifact. That is the whole point of it being here rather than
 * in the app-data folder — cloning a repository is not the same act as running
 * its author's code, and the first plugin anybody meets should demonstrate that.
 *
 * A plugin is one ES module with one default export. The object it is handed is
 * the six messages; every one of them answers with a promise.
 */
export default async function activate(ade) {
	/*
	 * `claim` — the command centre draws this with our own component, so it looks
	 * like the ADE because it is the ADE. The id is namespaced by the plugin on
	 * our side, so nothing here can shadow `view.browser`.
	 */
	await ade.claim('command', {
		id: 'branch',
		title: 'Say Which Branch',
		run: async () => {
			// `invoke` — any Rust command the ADE has, on the same terms as every
			// other caller. `git_branch` reads; it changes nothing.
			const branch = await ade.invoke('git_branch');
			console.log(`[hello] the branch is ${branch ?? 'not a git repository'}`);
		},
	});

	/*
	 * `on` — a plugin may **add** a block and may never **lift** one.
	 *
	 * Returning `{ block: true, reason: '...' }` stops the call. Returning
	 * nothing, `{}`, or even `{ block: false }` is "no opinion": a call the
	 * permission gate refused stays refused whatever is returned here.
	 */
	await ade.on('tool_call', (call) => {
		console.log(`[hello] the model is calling ${call.tool}`, call.input);
		return undefined;
	});
}
