/**
 * pet-sprites.tsx — built-in pet artwork (SVG "companion bots").
 *
 * Every built-in shares one rig: hover underglow + ground shadow, a mood
 * driven float/hop/droop body animation, cursor parallax (head tilt + eye
 * tracking), a glass visor with a sweeping sheen, and mood FX (orbit ring
 * while working, particle burst when celebrating, Zz when sleepy, ...).
 * Mochi keeps its pixel-art identity with pixel-native FX instead.
 */

import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import type { Mood } from "./pet-shared";

type Look = { x: number; y: number };

export interface PetSpriteProps {
	species: string;
	mood: Mood;
	look: Look;
	busy?: boolean;
	noPet?: boolean;
	scale?: number;
}

export const SPECIES: Record<string, { accent: string; label: string }> = {
	cat: { accent: "#ffb547", label: "Cat, a soft graphite kitten" },
	dog: { accent: "#4fd2ff", label: "Dog, a warm caramel puppy" },
	slime: { accent: "#46f0b0", label: "Slime, a holographic gel blob" },
	"pixel-mochi": { accent: "#ff8fa3", label: "Mochi, a sakura rice-cake pixel pet" },
};

export function PetSprite(props: PetSpriteProps) {
	switch (props.species) {
		case "pixel-mochi":
			return <PixelMochi {...props} />;
		case "cat":
			return <Plush {...props} canine={false} />;
		case "dog":
			return <Plush {...props} canine />;
		default:
			return <Slime {...props} />;
	}
}

// --- mood tables -------------------------------------------------------------

type EyeKind = "open" | "focus" | "happy" | "closed" | "sad";
type MouthKind = "smile" | "open" | "nom" | "flat" | "frown";

const EYES: Record<Mood, EyeKind> = {
	idle: "open",
	working: "focus",
	celebrating: "happy",
	happy: "happy",
	sad: "sad",
	sleepy: "closed",
	eating: "happy",
};

const MOUTHS: Record<Mood, MouthKind> = {
	idle: "smile",
	working: "flat",
	celebrating: "open",
	happy: "smile",
	sad: "frown",
	sleepy: "flat",
	eating: "nom",
};

const MOTION: Record<Mood, { body: string; shadow: string }> = {
	idle: { body: "pzFloat 3.4s ease-in-out infinite", shadow: "pzShadow 3.4s ease-in-out infinite" },
	working: { body: "pzHum 2.2s ease-in-out infinite", shadow: "pzShadow 2.2s ease-in-out infinite" },
	celebrating: { body: "pzHop 0.8s cubic-bezier(.3,.7,.4,1) infinite", shadow: "pzShadowHop 0.8s cubic-bezier(.3,.7,.4,1) infinite" },
	happy: { body: "pzSway 2.2s ease-in-out infinite", shadow: "pzShadow 2.2s ease-in-out infinite" },
	sad: { body: "pzDroop 3.8s ease-in-out infinite", shadow: "pzShadowLow 3.8s ease-in-out infinite" },
	sleepy: { body: "pzDoze 4.2s ease-in-out infinite", shadow: "pzShadowLow 4.2s ease-in-out infinite" },
	eating: { body: "pzChomp 0.7s ease-in-out infinite", shadow: "pzShadow 0.7s ease-in-out infinite" },
};

const lively = (mood: Mood) => mood === "happy" || mood === "celebrating";

// --- shared rig ----------------------------------------------------------------

const BOX = 112;

interface Face {
	cx: number;
	cy: number;
	gap: number;
	mouthY: number;
}

function Rig({
	species,
	mood,
	busy,
	noPet,
	scale = 1,
	look,
	face,
	children,
}: PetSpriteProps & { face: Face; children: (id: string) => ReactNode }) {
	const id = useId().replace(/:/g, "");
	const spec = SPECIES[species] ?? SPECIES.slime;
	const accent = spec.accent;
	const dim = mood === "sleepy" || mood === "sad";
	const tilt: CSSProperties = {
		transform: `translate(${look.x * 0.6}px, ${look.y * 0.4}px) rotate(${look.x * 0.8}deg)`,
		transformOrigin: "60px 72px",
		transformBox: "view-box",
		transition: "transform 140ms ease-out",
	};
	const orbit = mood === "working" || Boolean(busy);

	return (
		<div
			className="pet-critter pz-pet"
			role="img"
			aria-label={spec.label}
			style={{
				width: BOX,
				height: BOX,
				transform: `scale(${scale})`,
				transformOrigin: "center",
				margin: `${(BOX * (scale - 1)) / 2}px`,
				opacity: noPet ? 0.45 : 1,
				filter: noPet ? "grayscale(0.85)" : undefined,
				transition: "opacity 200ms, filter 200ms",
			}}
		>
			<PetStyles />
			<svg viewBox="0 0 120 120" width={BOX} height={BOX} overflow="visible" style={{ display: "block", overflow: "visible" }}>
				<defs>
					<filter id={`${id}-glow`} x="-60%" y="-60%" width="220%" height="220%">
						<feGaussianBlur stdDeviation="1.4" result="b" />
						<feMerge>
							<feMergeNode in="b" />
							<feMergeNode in="SourceGraphic" />
						</feMerge>
					</filter>
					<filter id={`${id}-soft`} x="-50%" y="-200%" width="200%" height="500%">
						<feGaussianBlur stdDeviation="2.4" />
					</filter>
					<radialGradient id={`${id}-under`}>
						<stop offset="0" stopColor={accent} stopOpacity="0.9" />
						<stop offset="1" stopColor={accent} stopOpacity="0" />
					</radialGradient>
					<clipPath id={`${id}-back`}>
						<rect x="-20" y="-40" width="160" height="112" />
					</clipPath>
					<clipPath id={`${id}-front`}>
						<rect x="-20" y="72" width="160" height="80" />
					</clipPath>
				</defs>

				<ellipse
					className="pz-o"
					style={{ animation: MOTION[mood].shadow }}
					cx="60"
					cy="114"
					rx="27"
					ry="3.6"
					fill="#04070b"
					opacity="0.2"
					filter={`url(#${id}-soft)`}
				/>
				<ellipse
					className="pz-o pz-under"
					cx="60"
					cy="110"
					rx="30"
					ry="5.5"
					fill={`url(#${id}-under)`}
					style={{ opacity: dim ? 0.08 : 0.16 }}
				/>

				<g className="pz-float" style={{ animation: MOTION[mood].body }}>
					{orbit && <Orbit id={id} part="back" accent={accent} />}
					<g style={tilt}>
						{children(id)}
						<FaceFx id={id} mood={mood} face={face} accent={accent} />
					</g>
					{orbit && <Orbit id={id} part="front" accent={accent} />}
					<MoodFx mood={mood} accent={accent} />
				</g>
			</svg>
		</div>
	);
}

function Orbit({ id, part, accent }: { id: string; part: "back" | "front"; accent: string }) {
	return (
		<g clipPath={`url(#${id}-${part})`} opacity={part === "back" ? 0.55 : 1}>
			<ellipse cx="60" cy="72" rx="55" ry="14" fill="none" stroke={accent} strokeOpacity="0.2" strokeWidth="0.8" />
			{[0, -1.1].map((delay) => (
				<ellipse
					key={delay}
					className="pz-dash"
					style={{ animationDelay: `${delay}s` }}
					cx="60"
					cy="72"
					rx="55"
					ry="14"
					fill="none"
					stroke={accent}
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeDasharray="30 222"
					filter={`url(#${id}-glow)`}
				/>
			))}
		</g>
	);
}

const STAR = "M0 -5 Q0.8 -0.8 5 0 Q0.8 0.8 0 5 Q-0.8 0.8 -5 0 Q-0.8 -0.8 0 -5Z";

function MoodFx({ mood, accent }: { mood: Mood; accent: string }) {
	if (mood === "celebrating") {
		return (
			<g>
				{Array.from({ length: 10 }, (_, i) => {
					const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
					const d = i % 2 ? 44 : 54;
					return (
						<g key={i} transform="translate(60 58)">
							<g
								className="pz-o pz-burst"
								style={{ "--dx": `${Math.cos(a) * d}px`, "--dy": `${Math.sin(a) * d}px`, animationDelay: `${i * 0.07}s` } as CSSProperties}
							>
								<path d={i % 3 ? "M0 -3.2 L1.3 0 L0 3.2 L-1.3 0Z" : "M-1.6 -1.6h3.2v3.2h-3.2Z"} fill={i % 3 === 1 ? "#ffffff" : accent} />
							</g>
						</g>
					);
				})}
			</g>
		);
	}
	if (mood === "happy") {
		return (
			<g>
				{[
					[100, 26, 0, 1],
					[18, 38, 0.9, 0.75],
					[106, 54, 1.6, 0.55],
				].map(([x, y, delay, s]) => (
					<g key={x} transform={`translate(${x} ${y}) scale(${s})`}>
						<path className="pz-o pz-twinkle" style={{ animationDelay: `${delay}s` }} d={STAR} fill={accent} />
					</g>
				))}
			</g>
		);
	}
	if (mood === "sleepy") {
		return (
			<g fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontWeight="700" fill="#eaf2ff">
				{[0, 1, 2].map((i) => (
					<text
						key={i}
						className="pz-o pz-z"
						style={{ animationDelay: `${i * 1.1}s` }}
						x={90 + i * 3}
						y={36 - i * 2}
						fontSize={8 + i * 2}
						stroke={accent}
						strokeOpacity="0.35"
						strokeWidth="0.6"
					>
						z
					</text>
				))}
			</g>
		);
	}
	return null;
}

function FaceFx({ id, mood, face, accent }: { id: string; mood: Mood; face: Face; accent: string }) {
	if (mood === "sad") {
		return (
			<g transform={`translate(${face.cx - face.gap / 2 + 1} ${face.cy + 6})`}>
				<path className="pz-o pz-tear" d="M0 0 C2 3 2.6 5 0 6.4 C-2.6 5 -2 3 0 0Z" fill="#9ad8ff" />
			</g>
		);
	}
	if (mood === "eating") {
		return (
			<g transform={`translate(${face.cx} ${face.mouthY})`}>
				<g className="pz-o pz-feed">
					<rect x="-3" y="-3" width="6" height="6" rx="1.3" fill={accent} filter={`url(#${id}-glow)`} />
				</g>
			</g>
		);
	}
	return null;
}

// --- face parts ------------------------------------------------------------


function Eyes({
	cx,
	cy,
	gap,
	kind,
	color,
	look,
	glowId,
	w = 9,
	h = 13,
	dim,
}: {
	cx: number;
	cy: number;
	gap: number;
	kind: EyeKind;
	color: string;
	look: Look;
	glowId?: string;
	w?: number;
	h?: number;
	dim?: boolean;
}) {
	const eye = (x: number, side: -1 | 1) => {
		switch (kind) {
			case "happy":
				return <path d={`M${x - 5} ${cy + 3} Q${x} ${cy - 6} ${x + 5} ${cy + 3}`} stroke={color} strokeWidth="3" strokeLinecap="round" fill="none" />;
			case "closed":
				return <path d={`M${x - 5} ${cy} Q${x} ${cy + 4} ${x + 5} ${cy}`} stroke={color} strokeWidth="2.6" strokeLinecap="round" fill="none" />;
			case "focus":
				// Concentrating: narrowed eyes under a flat lid, still bright.
				return (
					<g>
						<rect x={x - w / 2} y={cy - h * 0.2} width={w} height={h * 0.55} rx={w / 2.2} fill={color} />
						<path d={`M${x - w / 2 - 1.2} ${cy - h * 0.2} H${x + w / 2 + 1.2}`} stroke={color} strokeWidth="2.4" strokeLinecap="round" />
						<rect x={x - w / 2 + 2} y={cy - h * 0.2 + 1.6} width={2.4} height={2.4} rx={1.2} fill="#fff" opacity="0.7" />
					</g>
				);
			case "sad":
				return (
					<g>
						<rect x={x - w / 2} y={cy - 2} width={w} height={h - 4} rx={w / 2} fill={color} />
						<path d={side < 0 ? `M${x - 6} ${cy - 3} L${x + 5} ${cy - 7}` : `M${x - 5} ${cy - 7} L${x + 6} ${cy - 3}`} stroke={color} strokeWidth="2" strokeLinecap="round" />
					</g>
				);
			default:
				return (
					<g className="pz-o pz-blink">
						<rect x={x - w / 2} y={cy - h / 2} width={w} height={h} rx={w / 2} fill={color} />
						<rect x={x - w / 2 + 2} y={cy - h / 2 + 2.2} width={2.6} height={3.6} rx={1.3} fill="#fff" opacity="0.8" />
						<circle cx={x + w / 2 - 2.4} cy={cy + h / 2 - 3} r={1.1} fill="#fff" opacity="0.45" />
					</g>
				);
		}
	};
	const track = kind === "open" || kind === "focus" || kind === "sad";
	return (
		<g
			filter={glowId ? `url(#${glowId})` : undefined}
			opacity={dim ? 0.6 : 1}
			style={{ transform: track ? `translate(${look.x * 1.1}px, ${look.y * 0.9}px)` : undefined, transition: "transform 120ms ease-out" }}
		>
			{eye(cx - gap / 2, -1)}
			{eye(cx + gap / 2, 1)}
		</g>
	);
}

function Mouth({ cx, cy, kind, color, glowId }: { cx: number; cy: number; kind: MouthKind; color: string; glowId?: string }) {
	const stroke = { stroke: color, strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
	const shape =
		kind === "open" ? <ellipse cx={cx} cy={cy + 1} rx="4.2" ry="3.4" fill={color} /> :
		kind === "nom" ? <path className="pz-o pz-nom" d={`M${cx - 6} ${cy} L${cx - 3} ${cy + 3} L${cx} ${cy} L${cx + 3} ${cy + 3} L${cx + 6} ${cy}`} {...stroke} /> :
		kind === "flat" ? <path d={`M${cx - 4} ${cy + 1} H${cx + 4}`} {...stroke} /> :
		kind === "frown" ? <path d={`M${cx - 5} ${cy + 3} Q${cx} ${cy - 1.5} ${cx + 5} ${cy + 3}`} {...stroke} /> :
		<path d={`M${cx - 5} ${cy} Q${cx} ${cy + 4.5} ${cx + 5} ${cy}`} {...stroke} />;
	return <g filter={glowId ? `url(#${glowId})` : undefined} opacity="0.9">{shape}</g>;
}

// --- rounded plush characters: soft volume, glossy eyes, independent ears ---

function Plush(props: PetSpriteProps & { canine: boolean }) {
	const { canine, mood, look } = props;
	const face = { cx: 60, cy: 57, gap: 27, mouthY: 76 };
	const fur = canine ? ["#fff0d1", "#e1b980", "#b98958"] : ["#cbd2dd", "#8c99ae", "#59677e"];
	const ear = canine ? "#a16d43" : "#707e94";
	const tail = lively(mood) ? ".7s" : "3.2s";
	return <Rig {...props} face={face}>{id => <>
		<defs>
			<radialGradient id={`${id}-fur`} cx="35%" cy="22%" r="85%"><stop stopColor={fur[0]}/><stop offset=".55" stopColor={fur[1]}/><stop offset="1" stopColor={fur[2]}/></radialGradient>
			<radialGradient id={`${id}-cream`} cx="40%" cy="20%" r="90%"><stop stopColor="#fffdf1"/><stop offset="1" stopColor={canine ? "#edcf9e" : "#c9d0dc"}/></radialGradient>
			<radialGradient id={`${id}-nose`} cx="30%" cy="20%"><stop stopColor={canine ? "#677079" : "#f8b6bb"}/><stop offset="1" stopColor={canine ? "#29313c" : "#bf7f8d"}/></radialGradient>
			<filter id={`${id}-cheek`}><feGaussianBlur stdDeviation="1.2"/></filter>
		</defs>
		<g className="pz-tail" style={{animationDuration:tail}}>
			<path d={canine ? "M78 94 C101 102 107 78 98 74" : "M80 95 C110 103 111 79 105 72"} fill="none" stroke={fur[2]} strokeWidth={canine ? 10 : 8} strokeLinecap="round"/>
			<path d="M87 95 Q104 95 104 84" fill="none" stroke={fur[0]} strokeOpacity=".65" strokeWidth="3" strokeLinecap="round"/>
		</g>
		<g className="pz-breathe">
			<ellipse cx="60" cy="89" rx="25" ry="23" fill={`url(#${id}-fur)`}/>
			<ellipse cx="60" cy="92" rx="15" ry="17" fill={`url(#${id}-cream)`}/>
			<ellipse cx="41" cy="105" rx="13" ry="7.5" fill={`url(#${id}-fur)`}/><ellipse cx="79" cy="105" rx="13" ry="7.5" fill={`url(#${id}-fur)`}/>
			<path d="M37 106v3 M42 107v3 M77 107v3 M82 106v3" stroke={fur[2]} strokeOpacity=".45" strokeWidth="1.2" strokeLinecap="round"/>
		</g>
		{canine ? <>
			<g className="pz-flop-l" style={{animationDuration:"3.8s"}}><path d="M35 30 C20 24 9 34 10 53 C10 72 21 78 29 65 L40 38Z" fill={ear}/><path d="M24 37 Q15 47 21 63" stroke="#e1b28a" strokeOpacity=".55" strokeWidth="4" fill="none" strokeLinecap="round"/></g>
			<g className="pz-flop-r" style={{animationDuration:"4.1s"}}><path d="M85 30 C100 24 111 34 110 53 C110 72 99 78 91 65 L80 38Z" fill={ear}/><path d="M98 38 Q105 48 100 61" stroke="#e1b28a" strokeOpacity=".4" strokeWidth="3" fill="none" strokeLinecap="round"/></g>
		</> : <>
			<g className="pz-ear-l"><path d="M24 45 L25 17 Q27 9 34 16 L51 34Z" fill={`url(#${id}-fur)`}/><path d="M30 33 L31 21 L43 34Z" fill="#edb6c2"/></g>
			<g className="pz-ear-r"><path d="M96 45 L95 17 Q93 9 86 16 L69 34Z" fill={`url(#${id}-fur)`}/><path d="M90 33 L89 21 L77 34Z" fill="#edb6c2"/></g>
		</>}
		<path d="M22 49 C20 29 37 24 60 24 C83 24 100 29 98 49 C108 63 98 84 81 88 C67 92 52 92 38 87 C21 83 13 64 22 49Z" fill={`url(#${id}-fur)`}/>
		<path d="M31 35 Q45 26 60 28" stroke="#fff" strokeOpacity=".48" strokeWidth="2.6" strokeLinecap="round" fill="none"/>
		{!canine && <path d="M48 29l5 9 M60 27v10 M72 29l-5 9" stroke={fur[2]} strokeOpacity=".45" strokeWidth="3" strokeLinecap="round"/>}
		<ellipse cx="60" cy="75" rx={canine ? 23 : 20} ry="12" fill={`url(#${id}-cream)`}/>
		<ellipse cx="32" cy="68" rx="7" ry="3.4" fill="#efa7b5" opacity=".6" filter={`url(#${id}-cheek)`}/><ellipse cx="88" cy="68" rx="7" ry="3.4" fill="#efa7b5" opacity=".6" filter={`url(#${id}-cheek)`}/>
		<Eyes cx={face.cx} cy={face.cy} gap={face.gap} kind={EYES[mood]} color="#283343" look={look} w={11} h={15} dim={false}/>
		<path d="M55 69 Q60 66 65 69 Q64 74 60 74 Q56 74 55 69Z" fill={`url(#${id}-nose)`}/>
		<ellipse cx="58" cy="69.5" rx="1.5" ry=".8" fill="#fff" opacity=".7"/>
		<Mouth cx={face.cx} cy={face.mouthY} kind={MOUTHS[mood]} color={canine ? "#795336" : "#56627a"}/>
		{canine && (mood === "happy" || mood === "celebrating") && <path d="M57 78h6v4a3 3 0 0 1-6 0Z" fill="#ec98a6"/>}
		{!canine && <path d="M29 71l-10-2 M29 76l-11 2 M91 71l10-2 M91 76l11 2" stroke="#626f86" strokeOpacity=".6" strokeWidth="1" strokeLinecap="round"/>}
		{[35,42,78,85].map((x,i)=><path key={x} d={`M${x} ${81+i%2}l2 1.5`} stroke={fur[0]} strokeOpacity=".6" strokeWidth="1" strokeLinecap="round"/>)}
	</>}</Rig>;
}

// --- slime: holographic gel with a glowing core ------------------------------

const SLIME_SHAPES = [
	"M60 28 C84 28 102 48 104 74 C106 94 88 104 60 104 C32 104 14 94 16 74 C18 48 36 28 60 28 Z",
	"M60 31 C87 30 105 50 106 75 C106 95 87 104 60 104 C33 104 14 95 14 75 C15 50 33 32 60 31 Z",
	"M60 25 C82 26 100 47 102 73 C104 94 88 104 60 104 C32 104 16 94 18 73 C20 47 38 24 60 25 Z",
];

function useReducedMotion() {
	const query = "(prefers-reduced-motion: reduce)";
	const [reduced, setReduced] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
	useEffect(() => {
		const m = matchMedia(query);
		const on = () => setReduced(m.matches);
		m.addEventListener("change", on);
		return () => m.removeEventListener("change", on);
	}, []);
	return reduced;
}

function Slime(props: PetSpriteProps) {
	const { mood, look } = props;
	const accent = SPECIES.slime.accent;
	const reduced = useReducedMotion();
	const face = { cx: 60, cy: 66, gap: 26, mouthY: 80 };
	const [a, b, c] = SLIME_SHAPES;
	const wobble = lively(mood) || mood === "working" ? "1.4s" : mood === "sleepy" ? "6s" : "4s";
	const ink = "#073326";
	return (
		<Rig {...props} face={face}>
			{(id) => (
				<>
					<defs>
						<radialGradient id={`${id}-gel`} cx="0.4" cy="0.3" r="0.8">
							<stop offset="0" stopColor="#c8ffe8" />
							<stop offset="0.45" stopColor="#5fe8b2" />
							<stop offset="1" stopColor="#0f7a58" />
						</radialGradient>
						<linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0" stopColor="#fff" stopOpacity="0.7" />
							<stop offset="0.6" stopColor="#fff" stopOpacity="0" />
							<stop offset="1" stopColor={accent} stopOpacity="0.6" />
						</linearGradient>
						<pattern id={`${id}-lines`} width="4" height="3" patternUnits="userSpaceOnUse">
							<rect width="4" height="1" fill="#fff" opacity="0.05" />
						</pattern>
						<clipPath id={`${id}-body`}>
							<path d={a} />
						</clipPath>
					</defs>

					<path d={a} fill={`url(#${id}-gel)`} fillOpacity="0.93">
						{!reduced && (
							<animate attributeName="d" dur={wobble} repeatCount="indefinite" values={`${a};${b};${a};${c};${a}`} calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1" />
						)}
					</path>
					<g clipPath={`url(#${id}-body)`}>
						<circle className="pz-o pz-core" cx="62" cy="82" r="13" fill={accent} opacity="0.55" filter={`url(#${id}-soft)`} />
						<g className="pz-lines">
							<rect x="10" y="20" width="100" height="96" fill={`url(#${id}-lines)`} />
						</g>
						{[
							[38, 98, 0, 2],
							[74, 100, 1.2, 1.5],
							[56, 102, 2.1, 2.4],
							[86, 96, 0.6, 1.2],
						].map(([x, y, delay, r]) => (
							<circle key={x} className="pz-o pz-bubble" style={{ animationDelay: `${delay}s` }} cx={x} cy={y} r={r} fill="none" stroke="#fff" strokeOpacity="0.7" strokeWidth="0.8" />
						))}
					</g>
					<path d={a} fill="none" stroke={`url(#${id}-rim)`} strokeWidth="1.2">
						{!reduced && (
							<animate attributeName="d" dur={wobble} repeatCount="indefinite" values={`${a};${b};${a};${c};${a}`} calcMode="spline" keySplines=".45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1" />
						)}
					</path>
					<ellipse cx="41" cy="45" rx="12" ry="6.5" transform="rotate(-28 41 45)" fill="#fff" opacity="0.55" />
					<circle cx="54" cy="37" r="2" fill="#fff" opacity="0.8" />

					<rect x="28" y="76" width="11" height="4.4" rx="2.2" fill="#ff8fab" opacity="0.5" />
					<rect x="81" y="76" width="11" height="4.4" rx="2.2" fill="#ff8fab" opacity="0.5" />
					<Eyes cx={face.cx} cy={face.cy} gap={face.gap} kind={EYES[mood]} color={ink} look={look} w={10} h={14} />
					<Mouth cx={face.cx} cy={face.mouthY} kind={MOUTHS[mood]} color={ink} />
				</>
			)}
		</Rig>
	);
}

// --- mochi: pixel art with pixel-native FX ---------------------------------

/** A sakura mochi: squishy pink rice cake with a leaf sprout. */
const MOCHI_ROWS_RAW = [
	"........lLL.......",
	".......lLLLl......",
	"........l.........",
	".....oooooooo.....",
	"...ooBBBBBBBBoo...",
	"..oBHHBBBBBBBBBo..",
	".oBHHBBBBBBBBBBBo.",
	".oBHBBBBBBBBBBBBo.",
	"oBBBBEBBBBBBEBBBBo",
	"oBBBBEBBBBBBEBBBBo",
	"oBBPPBBBBBBBBPPBBo",
	"oBBBBBBBBBBBBBBBBo",
	"obBBBBBBBBBBBBBBbo",
	".obbBBBBBBBBBBbbo.",
	"..oobbbbbbbbbboo..",
	"....oooooooooo....",
];
const MOCHI_PALETTE: Record<string, string> = {
	o: "#6b3f52",
	B: "#ffd3de",
	b: "#f4a9bd",
	H: "#fff6f8",
	P: "#ff8fab",
	L: "#86cf8a",
	l: "#4f9d5c",
	E: "#3b2330",
	M: "#8a3f5a",
};
const MOCHI_COLS = Math.max(...MOCHI_ROWS_RAW.map((r) => r.length));
const MOCHI_ROWS = MOCHI_ROWS_RAW.map((row) => {
	const pad = MOCHI_COLS - row.length;
	return `${".".repeat(Math.floor(pad / 2))}${row}${".".repeat(Math.ceil(pad / 2))}`;
});
/** Horizontal runs of same-colored pixels (eyes painted as body; drawn on top separately). */
const MOCHI_RUNS = MOCHI_ROWS.flatMap((row, y) => {
	const runs: { x: number; y: number; w: number; c: string }[] = [];
	const cells = [...row].map((p) => (p === "E" ? "B" : p));
	for (let x = 0; x < cells.length; ) {
		let end = x;
		while (end < cells.length && cells[end] === cells[x]) end++;
		if (MOCHI_PALETTE[cells[x]]) runs.push({ x, y, w: end - x, c: cells[x] });
		x = end;
	}
	return runs;
});
const MOCHI_EYE_ROW = MOCHI_ROWS.findIndex((r) => r.includes("E"));
const MOCHI_EYE_COLS = [...MOCHI_ROWS[MOCHI_EYE_ROW]].flatMap((p, i) => (p === "E" ? [i] : []));
const MOCHI_MID = (MOCHI_EYE_COLS[0] + MOCHI_EYE_COLS[1]) / 2;
const MOCHI_MOUTH: [number, number] = [Math.floor(MOCHI_MID), Math.ceil(MOCHI_MID)];

/** A two-pixel mouth centred under the eyes; corners turn up or down with the mood. */
function mochiMouthCells(mood: Mood): [number, number][] {
	const [l, r] = MOCHI_MOUTH;
	const y = MOCHI_EYE_ROW + 2;
	switch (MOUTHS[mood]) {
		case "smile": return [[l - 1, y], [r + 1, y], [l, y + 1], [r, y + 1]];
		case "open": return [[l, y], [r, y], [l, y + 1], [r, y + 1]];
		case "nom": return [[l, y + 1], [r, y + 1]];
		case "frown": return [[l, y], [r, y], [l - 1, y + 1], [r + 1, y + 1]];
		default: return [[l, y + 1], [r, y + 1]];
	}
}

function mochiEyeCells(kind: EyeKind): [number, number, boolean][] {
	const r = MOCHI_EYE_ROW;
	return MOCHI_EYE_COLS.flatMap((c): [number, number, boolean][] => {
		if (kind === "happy") return [[c, r, false], [c - 1, r + 1, false], [c + 1, r + 1, false]];
		if (kind === "closed" || kind === "sad") return [[c - 1, r + 1, false], [c, r + 1, false], [c + 1, r + 1, false]];
		if (kind === "focus") return [[c - 1, r + 1, false], [c, r + 1, false]];
		return [[c, r, true], [c, r + 1, true]];
	});
}

function PixelMochi({ mood, busy, noPet, scale = 1 }: PetSpriteProps) {
	const cell = 6;
	const w = MOCHI_COLS * cell;
	const h = MOCHI_ROWS.length * cell;
	const pad = 14;
	const accent = SPECIES["pixel-mochi"].accent;
	const working = mood === "working" || Boolean(busy);
	const bob =
		mood === "celebrating" ? "pzPxHop 0.5s steps(1) infinite" :
		working ? "pzPxBob 0.5s steps(1) infinite" :
		mood === "eating" ? "pzPxBob 0.7s steps(1) infinite" :
		mood === "sleepy" || mood === "sad" ? "pzPxBob 2.4s steps(1) infinite" :
		"pzPxBob 1.2s steps(1) infinite";
	const px = (x: number, y: number, fill: string, key: string, className?: string, style?: CSSProperties) => (
		<rect key={key} className={className} style={style} x={x * cell} y={y * cell} width={cell} height={cell} fill={fill} />
	);

	return (
		<div
			className="pet-critter pz-pet"
			role="img"
			aria-label={SPECIES["pixel-mochi"].label}
			style={{
				width: w,
				height: h + pad,
				transform: `scale(${scale})`,
				transformOrigin: "center",
				margin: `${((h + pad) * (scale - 1)) / 2}px ${(w * (scale - 1)) / 2}px`,
				opacity: noPet ? 0.45 : 1,
				filter: noPet ? "grayscale(0.85)" : undefined,
			}}
		>
			<PetStyles />
			<svg viewBox={`0 -${pad - 6} ${w} ${h + pad}`} width={w} height={h + pad} shapeRendering="crispEdges" style={{ display: "block", overflow: "visible" }}>
				<rect x={w * 0.24} y={h + 1} width={w * 0.52} height={cell / 2} fill="#6b3f52" opacity="0.2" />
				<rect x={w * 0.32} y={h + 1 + cell / 2} width={w * 0.36} height={cell / 2} fill="#6b3f52" opacity="0.12" />

				<g style={{ animation: bob }}>
					<g
						style={{
							filter: "drop-shadow(0 4px 0 rgba(107, 63, 82, .22))",
							animation: working ? "pzPxGlitch 1.6s steps(1) infinite" : undefined,
						}}
					>
						{MOCHI_RUNS.map((r) => (
							<rect
								key={`${r.x}-${r.y}`}
								x={r.x * cell}
								y={r.y * cell}
								width={r.w * cell}
								height={cell}
								fill={MOCHI_PALETTE[r.c]}
							/>
						))}
						{mochiEyeCells(EYES[mood]).map(([x, y, blink]) =>
							px(x, y, MOCHI_PALETTE.E, `e${x}-${y}`, blink ? "pz-px-blink" : undefined),
						)}
						{mochiMouthCells(mood).map(([x, y]) => px(x, y, MOCHI_PALETTE.M, `m${x}-${y}`, mood === "eating" ? "pz-px-nom" : undefined))}
						{mood === "sad" && px(MOCHI_EYE_COLS[0], MOCHI_EYE_ROW + 2, "#8fd0ff", "tear", "pz-px-tear")}
					</g>
				</g>

				{mood === "celebrating" &&
					[
						[1, 2, 0],
						[MOCHI_COLS - 2, 4, 0.25],
						[2, 12, 0.12],
						[MOCHI_COLS - 3, 13, 0.37],
					].map(([x, y, d]) => (
						<g key={`s${x}`} className="pz-px-spark" style={{ animationDelay: `${d}s` }}>
							{px(x, y, "#fff6c2", "c")}
							{px(x - 1, y, accent, "l")}
							{px(x + 1, y, accent, "r")}
							{px(x, y - 1, accent, "t")}
							{px(x, y + 1, accent, "b")}
						</g>
					))}
				{(mood === "happy" || mood === "eating") &&
					[
						[2, 4, 0],
						[MOCHI_COLS - 3, 6, 0.6],
					].map(([x, y, d]) => (
						<g key={`h${x}`} className="pz-px-spark" style={{ animationDelay: `${d}s`, animationDuration: "1.2s" }}>
							{px(x, y, accent, "c")}
						</g>
					))}
				{mood === "sleepy" && (
					<g fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fontWeight="700" fill="#fff4e0" stroke="#352b21" strokeWidth="0.8" paintOrder="stroke">
						{[0, 1].map((i) => (
							<text key={i} className="pz-o pz-z" style={{ animationDelay: `${i * 1.4}s`, animationDuration: "2.8s" }} x={w - 30 + i * 6} y={22 - i * 6} fontSize={10 + i * 3}>
								z
							</text>
						))}
					</g>
				)}
				{working &&
					Array.from({ length: 5 }, (_, i) => (
						<rect
							key={`l${i}`}
							className="pz-px-load"
							style={{ animationDelay: `${i * 0.12}s` }}
							x={w / 2 - 2.5 * (cell - 1) + i * (cell - 1)}
							y={-pad + 6}
							width={cell - 2}
							height={cell - 2}
							fill={accent}
						/>
					))}
			</svg>
		</div>
	);
}

// --- keyframes ---------------------------------------------------------------

function PetStyles() {
	return <style>{PET_CSS}</style>;
}

const PET_CSS = `
.pz-pet .pz-o { transform-box: fill-box; transform-origin: center; }
.pz-pet .pz-float { transform-box: view-box; transform-origin: 60px 104px; }
.pz-pet .pz-under { transform-box: fill-box; transform-origin: center; animation: pzUnder 2.6s ease-in-out infinite; }
.pz-pet .pz-blink { animation: pzBlink 4.6s linear infinite; }
.pz-pet .pz-sheen { animation: pzSheen 6s cubic-bezier(.6,0,.3,1) infinite; }
.pz-pet .pz-scan { animation: pzScan 1.3s linear infinite; }
.pz-pet .pz-dash { animation: pzDash 2.2s linear infinite; }
.pz-pet .pz-pulse { animation: pzPulse 2.4s ease-in-out infinite; }
.pz-pet .pz-ping { animation: pzPing 2.4s ease-out infinite; }
.pz-pet .pz-burst { animation: pzBurst 1.1s cubic-bezier(.2,.7,.3,1) infinite; }
.pz-pet .pz-twinkle { animation: pzTwinkle 1.8s ease-in-out infinite; }
.pz-pet .pz-z { animation: pzZ 3.3s ease-out infinite; opacity: 0; }
.pz-pet .pz-tear { animation: pzTear 2.2s ease-in infinite; opacity: 0; }
.pz-pet .pz-feed { animation: pzFeed 1.4s cubic-bezier(.5,0,.6,1) infinite; opacity: 0; }
.pz-pet .pz-nom { animation: pzNom 0.35s ease-in-out infinite alternate; }
.pz-pet .pz-tail { transform-box: view-box; transform-origin: 86px 94px; animation: pzTail 2.6s ease-in-out infinite; }
.pz-pet .pz-ear-l { transform-box: view-box; transform-origin: 38px 42px; animation: pzEarL 5.5s ease-in-out infinite; }
.pz-pet .pz-ear-r { transform-box: view-box; transform-origin: 82px 42px; animation: pzEarR 5.5s ease-in-out 2.7s infinite; }
.pz-pet .pz-flop-l { transform-box: view-box; transform-origin: 24px 40px; animation: pzFlopL 3s ease-in-out infinite; }
.pz-pet .pz-flop-r { transform-box: view-box; transform-origin: 96px 40px; animation: pzFlopR 3s ease-in-out infinite; }
.pz-pet .pz-core { animation: pzCore 3.2s ease-in-out infinite; }
.pz-pet .pz-lines { animation: pzLines 1.2s linear infinite; }
.pz-pet .pz-bubble { animation: pzBubble 3s ease-in infinite; opacity: 0; }
.pz-pet .pz-px-blink { animation: pzPxBlink 3.8s steps(1) infinite; }
.pz-pet .pz-px-nom { animation: pzPxBlink 0.5s steps(1) infinite; }
.pz-pet .pz-px-tear { animation: pzPxTear 1.6s steps(4) infinite; }
.pz-pet .pz-px-spark { animation: pzPxSpark 0.5s steps(1) infinite; }
.pz-pet .pz-px-load { animation: pzPxLoad 0.9s steps(1) infinite; opacity: .2; }

.pz-pet .pz-breathe { transform-origin: 60px 107px; animation: pzBreathe 3.8s ease-in-out infinite; }
@keyframes pzBreathe { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.025,1.04); } }
@keyframes pzFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes pzHum { 0%,100% { transform: translateY(-2px) rotate(-1.2deg); } 50% { transform: translateY(-3.5px) rotate(1.2deg); } }
@keyframes pzHop { 0%,100% { transform: translateY(0) scale(1.07,.93); } 30% { transform: translateY(-13px) scale(.95,1.06); } 55% { transform: translateY(-15px) scale(1,1); } 85% { transform: translateY(0) scale(1.04,.96); } }
@keyframes pzSway { 0%,100% { transform: translateY(-2px) rotate(-3deg); } 50% { transform: translateY(-4px) rotate(3deg); } }
@keyframes pzDroop { 0%,100% { transform: translateY(3px) rotate(-1deg); } 50% { transform: translateY(4.5px) rotate(-1.5deg); } }
@keyframes pzDoze { 0%,100% { transform: translateY(4px) scale(1.015,.985); } 50% { transform: translateY(2.5px) scale(.99,1.01); } }
@keyframes pzChomp { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.03,.95); } }
@keyframes pzShadow { 0%,100% { transform: scale(1); opacity: .5; } 50% { transform: scale(.88); opacity: .34; } }
@keyframes pzShadowLow { 0%,100% { transform: scale(1.06); opacity: .55; } 50% { transform: scale(1.02); opacity: .5; } }
@keyframes pzShadowHop { 0%,100% { transform: scale(1.06); opacity: .55; } 30%,55% { transform: scale(.6); opacity: .2; } 85% { transform: scale(1.02); opacity: .5; } }
@keyframes pzUnder { 0%,100% { transform: scale(1,1); } 50% { transform: scale(1.14,.86); } }
@keyframes pzBlink { 0%,93%,100% { transform: scaleY(1); } 96% { transform: scaleY(.1); } }
@keyframes pzSheen { 0%,62% { transform: translateX(-12px); } 100% { transform: translateX(calc(var(--w) + 44px)); } }
@keyframes pzScan { 0% { transform: translateY(0); opacity: 0; } 15%,85% { opacity: .85; } 100% { transform: translateY(var(--h)); opacity: 0; } }
@keyframes pzDash { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -252; } }
@keyframes pzPulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@keyframes pzPing { 0% { transform: scale(1); opacity: .9; } 70%,100% { transform: scale(2.6); opacity: 0; } }
@keyframes pzBurst { 0% { transform: translate(0,0) scale(.2) rotate(0); opacity: 0; } 15% { opacity: 1; } 100% { transform: translate(var(--dx),var(--dy)) scale(1) rotate(120deg); opacity: 0; } }
@keyframes pzTwinkle { 0%,100% { transform: scale(.2) rotate(0); opacity: 0; } 50% { transform: scale(1) rotate(45deg); opacity: 1; } }
@keyframes pzZ { 0% { transform: translate(0,0) scale(.6); opacity: 0; } 25% { opacity: .95; } 100% { transform: translate(10px,-22px) scale(1.1); opacity: 0; } }
@keyframes pzTear { 0% { transform: translateY(0) scale(.6); opacity: 0; } 20% { opacity: .95; transform: translateY(1px) scale(1); } 100% { transform: translateY(16px); opacity: 0; } }
@keyframes pzFeed { 0% { transform: translate(30px,-8px) scale(1) rotate(0); opacity: 0; } 20% { opacity: 1; } 75% { transform: translate(0,0) scale(.45) rotate(180deg); opacity: 1; } 100% { transform: translate(0,0) scale(0) rotate(220deg); opacity: 0; } }
@keyframes pzNom { from { transform: scaleY(1); } to { transform: scaleY(.35); } }
@keyframes pzTail { 0%,100% { transform: rotate(-9deg); } 50% { transform: rotate(9deg); } }
@keyframes pzEarL { 0%,88%,100% { transform: rotate(0); } 92% { transform: rotate(-11deg); } 96% { transform: rotate(3deg); } }
@keyframes pzEarR { 0%,88%,100% { transform: rotate(0); } 92% { transform: rotate(11deg); } 96% { transform: rotate(-3deg); } }
@keyframes pzFlopL { 0%,100% { transform: rotate(0); } 50% { transform: rotate(9deg); } }
@keyframes pzFlopR { 0%,100% { transform: rotate(0); } 50% { transform: rotate(-9deg); } }
@keyframes pzCore { 0%,100% { transform: translate(0,0) scale(1); opacity: .45; } 50% { transform: translate(-6px,-5px) scale(1.2); opacity: .75; } }
@keyframes pzLines { from { transform: translateY(0); } to { transform: translateY(3px); } }
@keyframes pzBubble { 0% { transform: translateY(0) scale(.5); opacity: 0; } 20% { opacity: .9; } 100% { transform: translateY(-46px) scale(1); opacity: 0; } }
@keyframes pzPxBob { 0% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes pzPxHop { 0% { transform: translateY(0); } 25% { transform: translateY(-6px); } 50% { transform: translateY(-12px); } 75% { transform: translateY(-6px); } }
@keyframes pzPxBlink { 0% { opacity: 1; } 94% { opacity: 0; } 98% { opacity: 1; } }
@keyframes pzPxTear { 0% { transform: translateY(0); opacity: 1; } 100% { transform: translateY(24px); opacity: 0; } }
@keyframes pzPxSpark { 0% { opacity: 1; } 50% { opacity: 0; } }
@keyframes pzPxLoad { 0% { opacity: 1; } 30% { opacity: .2; } }
@keyframes pzPxGlitch {
	0%,100% { filter: drop-shadow(0 4px 0 rgba(107,63,82,.22)); transform: translateX(0); }
	82% { filter: drop-shadow(-2px 0 0 rgba(255,70,110,.7)) drop-shadow(2px 0 0 rgba(70,210,255,.7)); transform: translateX(1px); }
	88% { filter: drop-shadow(2px 0 0 rgba(255,70,110,.7)) drop-shadow(-2px 0 0 rgba(70,210,255,.7)); transform: translateX(-1px); }
	94% { filter: drop-shadow(0 4px 0 rgba(107,63,82,.22)); transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
	.pz-pet, .pz-pet * { animation: none !important; transition: none !important; }
	.pz-pet .pz-z, .pz-pet .pz-tear, .pz-pet .pz-feed, .pz-pet .pz-bubble { opacity: 0 !important; }
}
`;
