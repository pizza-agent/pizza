/**
 * BrowserViewport — canvas mirror of the managed browser's active tab.
 *
 * Draws JPEG frames pushed over the frame channel and forwards DOM input
 * events as viewport-relative (CSS px) input to the managed browser. The
 * canvas keeps the frame's aspect ratio; coordinates are mapped through the
 * bounding rect so the panel can be any size.
 */

import { useEffect, useRef } from "react";
import type { RpcBrowserInputEvent } from "@tomsun28/pizza-protocol";
import { cn } from "@/lib/utils";
import type { PushedFrame } from "@/lib/browser-frame-client";

export default function BrowserViewport({
	frame,
	onInput,
	className,
}: {
	frame: PushedFrame | null;
	onInput: (event: RpcBrowserInputEvent) => void;
	className?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	// Latest frame kept in a ref so drawing isn't re-created on every frame.
	const frameRef = useRef<PushedFrame | null>(null);
	frameRef.current = frame;

	useEffect(() => {
		if (!frame) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		let cancelled = false;
		void (async () => {
			try {
				const bitmap = await createImageBitmap(new Blob([frame.data], { type: "image/jpeg" }));
				if (cancelled) {
					bitmap.close();
					return;
				}
				if (canvas.width !== frame.width || canvas.height !== frame.height) {
					canvas.width = frame.width;
					canvas.height = frame.height;
					canvas.style.aspectRatio = `${frame.width} / ${frame.height}`;
				}
				const ctx = canvas.getContext("2d");
				if (!ctx) return;
				ctx.drawImage(bitmap, 0, 0);
				bitmap.close();
			} catch {
				// Corrupt/partial frame — the next one replaces it.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [frame]);

	/** Map a mouse event to page-viewport CSS pixels. */
	const toViewport = (event: { clientX: number; clientY: number }) => {
		const canvas = canvasRef.current;
		if (!canvas || !frameRef.current) return undefined;
		const rect = canvas.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return undefined;
		const scaleX = frameRef.current.width / rect.width;
		const scaleY = frameRef.current.height / rect.height;
		return {
			x: (event.clientX - rect.left) * scaleX,
			y: (event.clientY - rect.top) * scaleY,
		};
	};

	const buttonOf = (button: number): "left" | "right" | "middle" =>
		button === 2 ? "right" : button === 1 ? "middle" : "left";

	/** Modifiers worth forwarding (Shift participates in typing; Meta/Ctrl/Alt
	 *  combinations are released to the host before we ever see them). */
	const modifiersOf = (e: { shiftKey: boolean }): string[] | undefined =>
		e.shiftKey ? ["Shift"] : undefined;

	return (
		<div className={cn("relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-black/40", className)}>
			<canvas
				ref={canvasRef}
				tabIndex={0}
				className={cn(
					"block h-auto w-full cursor-default outline-none",
					frame ? "" : "hidden",
				)}
				style={{ imageRendering: "auto" }}
				onMouseDown={(e) => {
					e.preventDefault();
					const pos = toViewport(e);
					if (pos) onInput({ kind: "mousedown", ...pos, button: buttonOf(e.button), modifiers: modifiersOf(e) });
				}}
				onMouseUp={(e) => {
					const pos = toViewport(e);
					if (pos) onInput({ kind: "mouseup", ...pos, button: buttonOf(e.button), modifiers: modifiersOf(e) });
				}}
				onClick={(e) => {
					const pos = toViewport(e);
					if (pos) onInput({ kind: "click", ...pos, button: buttonOf(e.button), modifiers: modifiersOf(e) });
				}}
				onDoubleClick={(e) => {
					const pos = toViewport(e);
					if (pos) onInput({ kind: "dblclick", ...pos, button: buttonOf(e.button), modifiers: modifiersOf(e) });
				}}
				onMouseMove={(e) => {
					const pos = toViewport(e);
					if (pos) onInput({ kind: "mousemove", ...pos });
				}}
				onWheel={(e) => {
					e.preventDefault();
					onInput({ kind: "wheel", deltaX: e.deltaX, deltaY: e.deltaY });
				}}
				onKeyDown={(e) => {
					// Host shortcuts (Cmd/Ctrl/Alt+R, F, …) must keep working —
					// only plain and Shift-modified keys are forwarded.
					if (e.metaKey || e.ctrlKey || e.altKey) return;
					e.preventDefault();
					onInput({ kind: "keydown", key: e.key, modifiers: modifiersOf(e) });
				}}
				onKeyUp={(e) => {
					if (e.metaKey || e.ctrlKey || e.altKey) return;
					onInput({ kind: "keyup", key: e.key, modifiers: modifiersOf(e) });
				}}
				onContextMenu={(e) => e.preventDefault()}
			/>
		</div>
	);
}
