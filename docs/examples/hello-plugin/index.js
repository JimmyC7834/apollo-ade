/*
 * The smallest plugin that uses what tickets 72, 73 and 74 built.
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

	/*
	 * `claim('tool')` — a tool the model can call, once a profile says so.
	 *
	 * Two separate decisions: enabling this plugin is what runs the code above,
	 * and naming `which_branch` in a profile's tool list is what lets a model
	 * call it. It appears in the profile editor **off**, marked "from Hello".
	 *
	 * The parameters are the same short form a user tool manifest uses — a
	 * description on its own means a required string.
	 */
	await ade.claim('tool', {
		name: 'which_branch',
		description: 'The git branch the workspace is on.',
		parameters: {},
		run: async () => (await ade.invoke('git_branch')) ?? 'not a git repository',
	});

	/*
	 * `panel` and `relay` — the plugin's own page, in a dock tab.
	 *
	 * The path is relative to this plugin's folder and nothing outside it can be
	 * named. The page is its own origin: it cannot reach the ADE's DOM and holds
	 * none of its capabilities, and it links `plugin://ade/tokens.css` to get the
	 * ADE's palette without importing anything.
	 *
	 * `relay` carries an opaque payload between these two halves. The shape below
	 * — `{ ask: 'branch' }` out, `{ branch }` back — is this plugin's protocol.
	 * The ADE never parses it, which is why it never has to know about it.
	 */
	await ade.on('relay', async (payload) => {
		if (payload?.ask === 'branch') {
			await ade.relay({ branch: (await ade.invoke('git_branch')) ?? null });
		}
	});
	await ade.panel('panel.html');

	/*
	 * `theme` — values for tokens the ADE already has, and nothing else.
	 *
	 * No selectors, no rules, no stylesheet: a rule reaching the ADE's document
	 * would be component replacement by another route, and that is the one thing
	 * a plugin never does. Naming a token this ADE does not define is refused
	 * rather than ignored, so a plugin written against a token that has since
	 * gone says so instead of quietly doing nothing.
	 *
	 * Disabling this plugin puts the value back.
	 */
	await ade.theme({ '--ring': '#c26b3f' });

	/*
	 * `claim('layout')` — hide, rename and reorder what the ADE already draws,
	 * by public id.
	 *
	 * Only ids the ADE promises may be named; anything else fails loudly. So does
	 * anything that would hide the way back to the plugin list — which is how you
	 * turn this plugin off again.
	 */
	await ade.claim('layout', {
		rename: { 'artifact:terminal': 'Shell' },
		order: ['artifact:terminal'],
	});
}
