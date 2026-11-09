/** Procedural character: a silhouette, two big eyes and one expressive mouth. */
import { useEffect, useId, useRef, type CSSProperties } from "react";
import type { Mood } from "./pet-shared";
import { CHARACTERS, CHARACTER_EXPRESSIONS, type CharacterDefinition, type CharacterExpression } from "@/lib/agent-character";
import "./pizza-pet.css";

export interface PetSpriteProps {
	mood: Mood;
	look: { x: number; y: number };
	noPet?: boolean;
	scale?: number;
	onReady?: () => void;
	/** Extension points for another code-defined rig, expression or live audio envelope. */
	character?: CharacterDefinition;
	expression?: Partial<CharacterExpression>;
	speechLevel?: number;
}
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
export function PetSprite({ mood, look, noPet, scale = 1, onReady, character, expression, speechLevel }: PetSpriteProps) {
	const rig = character ?? CHARACTERS.pizza;
	const state = mood;
	const pose = { ...CHARACTER_EXPRESSIONS[state], ...expression };
	const root = useRef<HTMLSpanElement>(null);
	const latest = useRef({ look, onReady });
	latest.current = { look, onReady };
	const instance = useId().replace(/:/g, "");
	const clip = `pizza-mouth-${instance}`;
	useEffect(() => {
		const node = root.current;
		if (!node) return;
		let visible = true, hidden = document.hidden;
		let blinkTimer: ReturnType<typeof setTimeout>;
		let openTimer: ReturnType<typeof setTimeout>;
		let pokeTimer: ReturnType<typeof setTimeout>;
		const blink = () => {
			blinkTimer = setTimeout(() => {
				if (visible && !hidden) {
					node.dataset.blink = "true";
					openTimer = setTimeout(() => { delete node.dataset.blink; }, 140);
				}
				blink();
			}, 2800 + Math.random() * 4200);
		};
		blink();
		const target: GazeTarget = {
			pause(value) { hidden = value; node.dataset.animate = String(visible && !hidden); },
			place(point) {
				if (!visible || hidden) return;
				const r = node.getBoundingClientRect();
				const dx = point ? point.x - r.left - r.width / 2 : 0;
				const dy = point ? point.y - r.top - r.height / 2 : 0;
				const near = point && Math.hypot(dx, dy) < 420;
				node.style.setProperty("--pet-gx", String(clamp((near ? dx / 180 : 0) + latest.current.look.x * .12)));
				node.style.setProperty("--pet-gy", String(clamp((near ? dy / 200 : 0) + latest.current.look.y * .12)));
			},
		};
		const stop = followPointer(target);
		const poke = () => {
			clearTimeout(pokeTimer);
			node.dataset.poked = "true";
			pokeTimer = setTimeout(() => { delete node.dataset.poked; }, 650);
		};
		node.addEventListener("pizza:pet-poke", poke);
		const observer = new IntersectionObserver(([entry]) => {
			visible = entry.isIntersecting;
			node.dataset.animate = String(visible && !hidden);
		});
		observer.observe(node);
		latest.current.onReady?.();
		return () => {
			stop(); observer.disconnect();
			clearTimeout(blinkTimer); clearTimeout(openTimer); clearTimeout(pokeTimer);
			node.removeEventListener("pizza:pet-poke", poke);
		};
	}, [rig]);
	useEffect(() => {
		root.current?.style.setProperty("--pet-gx", String(clamp(look.x * .12)));
		root.current?.style.setProperty("--pet-gy", String(clamp(look.y * .12)));
	}, [look.x, look.y]);
	const mouthOpen = speechLevel === undefined ? pose.mouthOpen : .2 + Math.max(0, Math.min(1, speechLevel)) * .95;
	const style = {
		width: 112 * scale, height: 112 * scale,
		opacity: noPet ? .45 : 1,
		"--pet-lean": `${pose.lean}deg`, "--pet-mouth-open": mouthOpen,
		"--pet-eye-x": pose.eyeX, "--pet-eye-y": pose.eyeY,
	} as CSSProperties;
	const { left, right, eyeY, mouthY } = rig.face;
	return <span ref={root} className="pizza-pet" role="img" aria-label={`${rig.label}: ${state}`}
		data-renderer="procedural-svg" data-mood={state} data-smile-eyes={pose.smileEyes}
		data-audio-driven={speechLevel !== undefined || undefined} style={style}>
		<svg viewBox="0 0 112 112" aria-hidden="true">
			<defs><clipPath id={clip}><path d={pose.mouth} /></clipPath></defs>
			<g className="pizza-pet__motion"><g className="pizza-pet__attention">
				<path d={rig.body} fill={rig.accent} />
				{rig.crust && <path d={rig.crust} fill="none" stroke="#ee8134" strokeWidth="12" strokeLinecap="round" />}
				<g className="pizza-pet__gaze" fill="#302420">
					{[left, right].map((x, i) => <g key={i} transform={`translate(${x} ${eyeY}) rotate(${pose.eyeTilt * (i ? -1 : 1)})`}>
						<g className="pizza-pet__expression"><g className="pizza-pet__blink">
							<g className="pizza-pet__eye"><ellipse rx="10" ry="14" /><ellipse cx="3" cy="-5" rx="3.2" ry="4" fill="#fff" /></g>
							<path className="pizza-pet__smile" d="M-9 2 Q0 -12 9 2" fill="none" stroke="#302420" strokeWidth="5" strokeLinecap="round" />
						</g></g>
					</g>)}
					<g transform={`translate(${(left + right) / 2} ${mouthY})`}>
						<g className="pizza-pet__mouth">
							<path d={pose.mouth} fill={pose.mouthOpen ? "#302420" : "none"} stroke="#302420" strokeWidth={pose.mouthOpen ? 0 : 4} strokeLinecap="round" />
							{pose.mouthOpen > 0 && <ellipse cx="1" cy="16" rx="9" ry="6" fill="#f28c8b" clipPath={`url(#${clip})`} />}
						</g>
					</g>
				</g>
			</g></g>
		</svg>
	</span>;
}
