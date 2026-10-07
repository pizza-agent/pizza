import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * highlight.js is loaded lazily (and only once) so it lands in its own chunk
 * instead of the main bundle. `lib/common` covers ~40 popular languages; an
 * unknown language falls back to plain text.
 */
type Hljs = typeof import("highlight.js/lib/common")["default"];
let hljsPromise: Promise<Hljs> | null = null;

function loadHljs(): Promise<Hljs> {
	hljsPromise ??= import("highlight.js/lib/common").then((m) => m.default);
	return hljsPromise;
}

/**
 * Highlighting a very large file blocks the main thread, so above these
 * thresholds we render plain text (still with line numbers).
 */
const MAX_HIGHLIGHT_BYTES = 400 * 1024;
const MAX_HIGHLIGHT_LINES = 8000;

/**
 * Read-only source viewer: a sticky line-number gutter beside syntax-highlighted
 * code in a single scroll container. Numbers stay aligned because both columns
 * share the same font and line-height, and the gutter is `sticky left-0` so it
 * stays visible while scrolling horizontally.
 */
export function CodeViewer({
	code,
	language,
	wrap = false,
	className,
}: {
	code: string;
	/** highlight.js language id; omit or use "plaintext" to disable highlighting. */
	language?: string;
	/** Soft-wrap long lines. Off by default so code alignment is preserved. */
	wrap?: boolean;
	className?: string;
}) {
	const [html, setHtml] = useState<string | null>(null);

	const lineCount = useMemo(() => {
		// A trailing newline shouldn't produce a phantom last line.
		const n = code.split("\n").length;
		return code.endsWith("\n") ? Math.max(1, n - 1) : n;
	}, [code]);

	const tooBig = code.length > MAX_HIGHLIGHT_BYTES || lineCount > MAX_HIGHLIGHT_LINES;
	const shouldHighlight = !!language && language !== "plaintext" && !tooBig && code.length > 0;

	useEffect(() => {
		if (!shouldHighlight) {
			setHtml(null);
			return;
		}
		let cancelled = false;
		void loadHljs()
			.then((hljs) => {
				if (cancelled) return;
				if (!hljs.getLanguage(language!)) {
					setHtml(null);
					return;
				}
				setHtml(hljs.highlight(code, { language: language!, ignoreIllegals: true }).value);
			})
			.catch(() => { if (!cancelled) setHtml(null); });
		return () => { cancelled = true; };
	}, [code, language, shouldHighlight]);

	// Gutter digits are rendered as one text block so they inherit the exact
	// same line-height as the code column.
	const gutter = useMemo(
		() => Array.from({ length: lineCount }, (_, i) => i + 1).join("\n"),
		[lineCount],
	);

	return (
		<div className={cn("flex h-full min-h-0 overflow-auto bg-bg font-mono text-[11px] leading-[1.6]", className)}>
			<pre
				aria-hidden
				className="sticky left-0 z-10 shrink-0 select-none border-r border-border bg-bg px-2 py-3 text-right text-muted/60"
			>
				{gutter}
			</pre>
			<pre className={cn("min-w-0 flex-1 select-text px-3 py-3 text-fg", wrap && "whitespace-pre-wrap break-words")}>
				{html !== null ? (
					<code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
				) : (
					<code>{code}</code>
				)}
			</pre>
		</div>
	);
}
