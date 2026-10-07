import { memo, useState, type ReactNode, type ReactElement, createElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { highlightNodes } from "@/lib/highlight";

import { isTauri } from "@/lib/utils";

/** Schemes the shell plugin's default open-scope permits (http(s)://, mailto:, tel:). */
const OPENABLE_SCHEME = /^(https?:|mailto:|tel:)/i;

function CodeBlock({
	code,
	lang,
	highlight,
	highlightActive,
}: {
	code: string;
	lang?: string;
	highlight?: string;
	highlightActive?: boolean;
}) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	const copy = () => {
		void navigator.clipboard.writeText(code);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return (
		<div className="group/code relative my-3 overflow-hidden rounded-lg border border-border bg-surface-2">
			<div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
				<span className="text-[11px] font-medium text-muted">
					{lang || t("markdown.code")}
				</span>
				<button
					type="button"
					onClick={copy}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface hover:text-fg"
					title={t("markdown.copyCode")}
				>
					{copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
					{copied ? t("markdown.copied") : t("markdown.copy")}
				</button>
			</div>
			<pre className="overflow-x-auto px-3 py-2.5">
				<code className="font-mono text-xs leading-relaxed text-fg">
					{highlight ? highlightNodes(code, highlight, highlightActive) : code}
				</code>
			</pre>
		</div>
	);
}

/**
 * Build react-markdown component overrides that highlight search matches inside
 * text-bearing elements. Returns an empty object when there is no active query,
 * so the normal render path is untouched.
 *
 * We render each element via createElement(tag, null, …) rather than spreading
 * props: react-markdown passes internal props (e.g. its `node`) that React
 * would warn about if forwarded to the DOM. The markdown CSS targets tags by
 * selector (.md p, .md li, …), so no className forwarding is needed here.
 *
 * `active` paints the matches in the "current match" color so the focused
 * search result stands out the same way it does in plain-text surfaces.
 */
function makeHighlightComponents(highlight: string, active: boolean): Components {
	const tags = ["p", "li", "td", "th", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"] as const;
	// A plain record here avoids the huge union that indexing Components by tag
	// would create; the final cast satisfies react-markdown's Components type.
	const out: Record<string, (props: { children?: ReactNode }) => ReactElement> = {};
	for (const tag of tags) {
		out[tag] = ({ children }) => createElement(tag, null, highlightNodes(children, highlight, active));
	}
	return out as unknown as Components;
}

function MarkdownImpl({
	children,
	className,
	highlight,
	highlightActive,
}: {
	children: string;
	className?: string;
	highlight?: string;
	highlightActive?: boolean;
}) {
	// When a search query is active, inline matches are highlighted inside
	// text-bearing elements via makeHighlightComponents. The custom renderers
	// (CodeBlock, inline code, links) read `highlight`/`highlightActive` here.
	const highlightComponents: Components = highlight ? makeHighlightComponents(highlight, !!highlightActive) : {};
	return (
		<div className={cn("md select-text", className)}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					...highlightComponents,
					pre: ({ children }) => <>{children}</>,
					code: ({ className: cls, children: c }) => {
						const raw = String(c ?? "");
						const match = /language-(\w+)/.exec(cls || "");
						const isBlock = !!match || raw.includes("\n");
						if (!isBlock) {
							return (
								<code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-fg">
									{highlight ? highlightNodes(c as ReactNode, highlight, !!highlightActive) : (c as ReactNode)}
								</code>
							);
						}
						return <CodeBlock code={raw.replace(/\n$/, "")} lang={match?.[1]} highlight={highlight} highlightActive={highlightActive} />;
					},
					a: ({ children: c, href }) => {
						const openExternal = (e: React.MouseEvent) => {
							// Tauri's webview can't navigate to external origins; route the click
							// through the shell plugin so the URL opens in the system browser.
							if (isTauri() && href && OPENABLE_SCHEME.test(href)) {
								e.preventDefault();
								void import("@tauri-apps/plugin-shell").then(({ open }) => open(href));
							}
							// Otherwise fall through to the default <a target="_blank"> behavior
							// (used when running as a plain web app).
						};
						return (
							<a href={href} target="_blank" rel="noreferrer" onClick={openExternal} className="text-link underline underline-offset-2 hover:opacity-80">
								{highlight ? highlightNodes(c as ReactNode, highlight, !!highlightActive) : (c as ReactNode)}
							</a>
						);
					},
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}

export const Markdown = memo(MarkdownImpl);
