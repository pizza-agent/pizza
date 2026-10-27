/** Original soft volumes baked into SVG layers; no runtime GPU renderer. */
import { useEffect, useId, useRef, type CSSProperties } from "react";
import type { Mood } from "./pet-shared";
import { PET_SHAPES } from "./pet-shapes";
import "./pizza-pet.css";

export interface PetSpriteProps {
	species: string;
	mood: Mood;
	look: { x: number; y: number };
	busy?: boolean;
	noPet?: boolean;
	scale?: number;
	onReady?: () => void;
}
export const SPECIES: Record<string, { accent: string; label: string }> = {
	pip: { accent: "#FF9024", label: "PIP · Pizza slice" },
	mozz: { accent: "#F0C975", label: "MOZZ · Mozzarella" },
	pomo: { accent: "#EE4D43", label: "POMO · Tomato" },
	basi: { accent: "#49AF69", label: "BASI · Basil" },
};
interface GazeTarget {
	place(point: { x: number; y: number } | null): void;
	pause(hidden: boolean): void;
}
const gazeTargets = new Set<GazeTarget>();
let gazeFrame = 0,
	lastPointer: { x: number; y: number } | null = null;
function movePointer(event: PointerEvent) {
	lastPointer = { x: event.clientX, y: event.clientY };
	if (!gazeFrame)
		gazeFrame = requestAnimationFrame(() => {
			gazeFrame = 0;
			for (const target of gazeTargets) target.place(lastPointer);
		});
}
function leavePointer() {
	lastPointer = null;
	for (const target of gazeTargets) target.place(null);
}
function changeVisibility() {
	for (const target of gazeTargets) target.pause(document.hidden);
}
function followPointer(target: GazeTarget) {
	if (!gazeTargets.size) {
		window.addEventListener("pointermove", movePointer, { passive: true });
		document.documentElement.addEventListener("pointerleave", leavePointer);
		document.addEventListener("visibilitychange", changeVisibility);
	}
	gazeTargets.add(target);
	target.pause(document.hidden);
	return () => {
		gazeTargets.delete(target);
		if (!gazeTargets.size) {
			cancelAnimationFrame(gazeFrame);
			gazeFrame = 0;
			lastPointer = null;
			window.removeEventListener("pointermove", movePointer);
			document.documentElement.removeEventListener("pointerleave", leavePointer);
			document.removeEventListener("visibilitychange", changeVisibility);
		}
	};
}
const clamp = (n: number) => Math.max(-1, Math.min(1, n));
export function PetSprite({ species, mood, look, busy, noPet, scale = 1, onReady }: PetSpriteProps) {
	const shape = PET_SHAPES[species] ?? PET_SHAPES.pip;
	const root = useRef<HTMLSpanElement>(null),
		latest = useRef({ look, onReady });
	latest.current = { look, onReady };
	const instance = useId().replace(/:/g, ""),
		clip = `pizza-clip-${instance}`;
	const seed = [...(instance + species)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
	const down = useRef<{ x: number; y: number } | null>(null);
	useEffect(() => {
		const node = root.current;
		if (!node) return;
		let visible = true,
			hidden = document.hidden;
		const pause = () => {
			node.dataset.animate = String(visible && !hidden);
		};
		const target: GazeTarget = {
			pause(value) {
				hidden = value;
				pause();
			},
			place(point) {
				if (!visible || hidden) return;
				const r = node.getBoundingClientRect(),
					dx = point ? point.x - r.left - r.width / 2 : 0,
					dy = point ? point.y - r.top - r.height / 2 : 0,
					near = point && Math.hypot(dx, dy) < 420;
				node.style.setProperty("--pet-gx", String(clamp((near ? dx / 180 : 0) + latest.current.look.x * 0.12)));
				node.style.setProperty("--pet-gy", String(clamp((near ? dy / 200 : 0) + latest.current.look.y * 0.12)));
				node.dataset.petted = String(Boolean(point && Math.abs(dx) < r.width * 0.6 && Math.abs(dy) < r.height * 0.6));
			},
		};
		const stop = followPointer(target);
		const poke = () => {
			if (node.dataset.poked !== "true") node.dataset.poked = "true";
		};
		node.addEventListener("pizza:pet-poke", poke);
		const observer = new IntersectionObserver(([entry]) => {
			visible = entry.isIntersecting;
			pause();
		});
		observer.observe(node);
		// Inline SVG is ready even while the native floating window is hidden.
		latest.current.onReady?.();
		return () => {
			stop();
			observer.disconnect();
			node.removeEventListener("pizza:pet-poke", poke);
		};
	}, [species]);
	useEffect(() => {
		root.current?.style.setProperty("--pet-gx", String(clamp(look.x * 0.12)));
		root.current?.style.setProperty("--pet-gy", String(clamp(look.y * 0.12)));
	}, [look.x, look.y]);
	const style = {
		width: 112,
		height: 112,
		transform: `scale(${scale})`,
		transformOrigin: "center",
		margin: (112 * (scale - 1)) / 2,
		opacity: noPet ? 0.45 : 1,
		filter: noPet ? "grayscale(.65)" : undefined,
		"--pet-delay": `${-(seed % 520) / 100}s`,
		"--pet-fidget-delay": `${-(seed % 1000) / 100}s`,
		"--pet-eye": shape.eye,
	} as CSSProperties;
	return (
		<span
			ref={root}
			className="pizza-pet"
			role="img"
			aria-label={(SPECIES[species] ?? SPECIES.pip).label}
			data-renderer="layered-svg"
			data-mood={busy ? "working" : mood}
			data-fidget={seed % 2 ? "sway" : "stretch"}
			style={style}
			onPointerDown={(e) => {
				down.current = { x: e.clientX, y: e.clientY };
			}}
			onPointerUp={(e) => {
				if (!down.current || Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > 6) {
					down.current = null;
					return;
				}
				down.current = null;
				const node = root.current;
				if (node && e.button === 0 && node.dataset.poked !== "true") node.dataset.poked = "true";
			}}
			onAnimationEnd={(e) => {
				if (e.animationName === "pizzaPoke" && root.current) delete root.current.dataset.poked;
			}}
		>
			<svg viewBox="0 0 112 112" width="112" height="112" aria-hidden="true">
				<defs>
					<clipPath id={clip}>
						<path d={shape.body} />
					</clipPath>
				</defs>
				<g className="pizza-pet__motion">
					<g className="pizza-pet__attention">
						<path d={shape.body} fill={shape.color} />
						<g clipPath={`url(#${clip})`}>
							{shape.paints.map((paint, i) => (
								<path key={i} d={paint.path} fill={paint.color} />
							))}
							<path d={shape.shade} fill="#29190f" opacity=".18" />
							<path d={shape.light} fill="#fff8dd" opacity=".22" />
							{shape.eyes.map((eye, i) => (
								<ellipse
									key={i}
									className="pizza-pet__cheek"
									cx={eye.x + (i ? 1 : -1) * eye.width * 0.62}
									cy={eye.y + eye.height / 2 + 2.6}
									rx={eye.width * 0.42}
									ry={eye.width * 0.26}
									fill={shape.cheek}
								/>
							))}
						</g>
						<g className="pizza-pet__gaze" fill={shape.eye}>
							{shape.eyes.map((eye, i) => (
								<g key={i} transform={`translate(${eye.x} ${eye.y}) rotate(${eye.tilt})`}>
									<g className="pizza-pet__expression">
										<g className="pizza-pet__blink">
											<g className="pizza-pet__eye">
												<ellipse rx={eye.width / 2} ry={eye.height / 2} />
												<circle cx={eye.width * 0.17} cy={-eye.height * 0.2} r={eye.width * 0.2} fill="#fff" />
												<circle cx={-eye.width * 0.16} cy={eye.height * 0.2} r={eye.width * 0.085} fill="#fff" opacity=".85" />
											</g>
										</g>
									</g>
									<path
										className="pizza-pet__smile"
										d={`M${-eye.width * 0.5},1.5 Q0,${-eye.height * 0.42} ${eye.width * 0.5},1.5`}
										fill="none"
										stroke={shape.eye}
										strokeWidth={eye.width * 0.26}
										strokeLinecap="round"
									/>
								</g>
							))}
							{(() => {
								const [a, b] = shape.eyes, w = (a.width + b.width) / 2;
								return (
									<path
										className="pizza-pet__mouth"
										transform={`translate(${(a.x + b.x) / 2} ${(a.y + b.y) / 2 + a.height / 2 + 1.6}) rotate(${a.tilt})`}
										d={`M${-w * 0.26},0 Q0,${w * 0.26} ${w * 0.26},0`}
										fill="none"
										stroke={shape.eye}
										strokeWidth={w * 0.15}
										strokeLinecap="round"
									/>
								);
							})()}
						</g>
					</g>
				</g>
			</svg>
		</span>
	);
}
