import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A thin draggable divider. Emits a running size via `onResize`, given the
 * pointer delta from drag start applied to the size captured at drag start.
 *
 * - orientation "vertical": a vertical bar the user drags horizontally
 *   (used between the main pane and the right dock). Dragging left grows the
 *   dock, so the delta is inverted via `invert`.
 * - orientation "horizontal": a horizontal bar dragged vertically
 *   (used above the bottom dock).
 */
export function ResizeHandle({
	orientation,
	getSize,
	onResize,
	invert = false,
	className,
	subtle = false,
}: {
	orientation: "vertical" | "horizontal";
	/** Current size at the moment the drag begins. */
	getSize: () => number;
	/** Called with the new size (clamped by the caller if desired). */
	onResize: (next: number) => void;
	invert?: boolean;
	className?: string;
	/** A single hairline with a wider transparent drag target for outer docks. */
	subtle?: boolean;
}) {
	const startRef = useRef({ pos: 0, size: 0 });

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			startRef.current = {
				pos: orientation === "vertical" ? e.clientX : e.clientY,
				size: getSize(),
			};
		},
		[orientation, getSize],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!(e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) return;
			const cur = orientation === "vertical" ? e.clientX : e.clientY;
			let delta = cur - startRef.current.pos;
			if (invert) delta = -delta;
			onResize(startRef.current.size + delta);
		},
		[orientation, invert, onResize],
	);

	const onPointerUp = useCallback((e: React.PointerEvent) => {
		try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
	}, []);

	return (
		<div
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			className={cn(
				"group relative shrink-0 touch-none transition-colors",
				subtle ? "z-10 bg-border/60 hover:bg-accent/60" : "bg-transparent hover:bg-accent/30",
				orientation === "vertical"
					? subtle ? "w-px cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:w-[9px]" : "w-1 cursor-col-resize"
					: subtle ? "h-px cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:h-[9px]" : "h-1 cursor-row-resize",
				className,
			)}
		/>
	);
}
