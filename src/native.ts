// Whether the page is running inside the Tauri window.
//
// One line, and it was written seven times: four as `'__TAURI_INTERNALS__' in
// window` and three as the same test against `globalThis`. The two are not
// interchangeable — `in window` throws under Node, where the check scripts
// import these modules — so the surviving form is the safe one, and the sites
// that had it right no longer have to be found to know that.
//
// It is a *capability* test, not a platform test. Every caller uses it to pick
// between a real implementation and the browser stand-in, which is the whole
// reason `npm run dev` runs the workbench with no native process at all.

export function isTauri(): boolean {
	return '__TAURI_INTERNALS__' in globalThis;
}
