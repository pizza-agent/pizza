import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Z } from "@/lib/z-index";

/**
 * Minimal zero-dependency tooltip: a styled label that appears on hover,
 * portaled to <body> with fixed positioning. The portal matters — an inline
 * tooltip would be trapped inside ancestor stacking contexts (e.g. the
 * backdrop-blur header) and could paint under floating chrome like the
 * collapsed-sidebar flyout.
 *
 * `side` picks which edge of the trigger the bubble sits on; `align` picks
 * the bubble's horizontal anchor (center of the trigger, or its left edge —
 * use "start" when the trigger is near the left side of the window so the
 * bubble grows rightwards instead of sliding under the sidebar).
 *
 * Usage: <Tooltip label="Do a thing"><button>…</button></Tooltip>
 */
export function Tooltip({
	label,
	children,
	side = "bottom",
	align = "center",
	className,
}: {
	label: string;
	children: ReactNode;
	/** Which side of the trigger the bubble appears on. */
	side?: "top" | "bottom";
	/** Horizontal anchor of the bubble relative to the trigger. */
	align?: "center" | "start";
	/** Extra classes for the outer wrapper. */
	className?: string;
}) {
	const anchorRef = useRef<HTMLSpanElement>(null);
	const [rect, setRect] = useState<DOMRect | null>(null);

	return (
		<span
			ref={anchorRef}
			onMouseEnter={() => setRect(anchorRef.current?.getBoundingClientRect() ?? null)}
			onMouseLeave={() => setRect(null)}
			className={cn("relative inline-flex", className)}
		>
			{children}
			{rect &&
				createPortal(
					<span
						role="tooltip"
						style={{
							position: "fixed",
							left:
								align === "center"
									? rect.left + rect.width / 2
									: rect.left,
							top: side === "bottom" ? rect.bottom + 6 : undefined,
							bottom:
								side === "top"
									? window.innerHeight - rect.top + 6
									: undefined,
							transform:
								align === "center" ? "translateX(-50%)" : undefined,
							maxWidth: "min(70ch, 90vw)",
						}}
						className={cn(
							"pointer-events-none whitespace-normal break-words rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-fg shadow-md",
							Z.menu,
						)}
					>
						{label}
					</span>,
					document.body,
				)}
		</span>
	);
}
