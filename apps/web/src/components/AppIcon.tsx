import { AppWindow } from "lucide-react";
import { APP_ICONS } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/** Very light brand tiles need a dark glyph; everything else reads best in white. */
function glyphColor(hex: string): string {
	const n = parseInt(hex.slice(1), 16);
	if (Number.isNaN(n)) return "#ffffff";
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.72 ? "#1f2328" : "#ffffff";
}

/**
 * Brand icon tile for catalog apps and their installed connections. Falls back
 * to the generic app glyph for custom MCP servers without a known brand.
 */
export function AppIcon({ name, className }: { name?: string; className?: string }) {
	const def = name ? APP_ICONS[name] : undefined;
	if (!def)
		return (
			<span
				className={cn(
					"flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface",
					className,
				)}
			>
				<AppWindow className="h-5 w-5 text-accent" />
			</span>
		);
	const color = def.color ?? "#71717a";
	return (
		<span
			className={cn(
				"flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-black/5 dark:border-white/15",
				className,
			)}
			style={{ backgroundColor: color }}
			aria-hidden
		>
			{def.paths ? (
				<svg viewBox="0 0 24 24" className="h-5 w-5" fill={glyphColor(color)}>
					{def.paths.map((d) => (
						<path key={d.slice(0, 32)} d={d} />
					))}
				</svg>
			) : (
				<span className="text-sm font-bold" style={{ color: glyphColor(color) }}>
					{def.letter}
				</span>
			)}
		</span>
	);
}