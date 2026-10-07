import { useMemo } from "react";
import { parseUnifiedDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";

/**
 * Unified-diff viewer with a two-column line-number gutter (old / new), tinted
 * add/remove rows and sticky hunk headers. The gutter is `sticky left-0` so
 * line numbers stay pinned while scrolling long lines horizontally.
 */
export function DiffViewer({
	text,
	wrap = false,
	className,
}: {
	text: string;
	/** Soft-wrap long lines instead of scrolling horizontally. */
	wrap?: boolean;
	className?: string;
}) {
	const rows = useMemo(() => parseUnifiedDiff(text), [text]);

	return (
		<div className={cn("h-full min-h-0 overflow-auto bg-bg font-mono text-[11px] leading-[1.6]", className)}>
			<table className="w-full border-collapse">
				<tbody>
					{rows.map((row, i) => (
						<tr
							key={i}
							className={cn(
								row.kind === "add" && "diff-add",
								row.kind === "del" && "diff-del",
								row.kind === "hunk" && "diff-hunk",
								row.kind === "meta" && "text-muted",
							)}
						>
							{/* Gutter: old + new line numbers, pinned during h-scroll. */}
							<td className="sticky left-0 z-10 w-[3.25rem] select-none border-r border-border bg-bg px-1 text-right align-top text-muted/60">
								{row.oldNo ?? ""}
							</td>
							<td className="sticky left-[3.25rem] z-10 w-[3.25rem] select-none border-r border-border bg-bg px-1 text-right align-top text-muted/60">
								{row.newNo ?? ""}
							</td>
							{/* Marker column so +/- is readable without relying on color alone. */}
							<td
								className={cn(
									"w-3 select-none pl-1.5 text-center align-top",
									row.kind === "add" && "text-success",
									row.kind === "del" && "text-danger",
								)}
							>
								{row.kind === "add" ? "+" : row.kind === "del" ? "-" : ""}
							</td>
							<td
								className={cn(
									"select-text pl-1 pr-3 align-top",
									wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
									row.kind === "hunk" ? "font-semibold" : "text-fg",
								)}
							>
								{row.text || " "}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
