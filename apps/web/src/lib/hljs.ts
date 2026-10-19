/**
 * Shared lazy loader for highlight.js: the common bundle lands in its own
 * chunk and is fetched only once, the first time a code block wants syntax
 * highlighting. Both CodeViewer and markdown CodeBlocks share the promise.
 */
type Hljs = typeof import("highlight.js/lib/common")["default"];

let hljsPromise: Promise<Hljs> | null = null;

export function loadHljs(): Promise<Hljs> {
	hljsPromise ??= import("highlight.js/lib/common").then((m) => m.default);
	return hljsPromise;
}