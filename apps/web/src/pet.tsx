/**
 * pet.tsx — the detached floating pet window (pet.html).
 *
 * Codex-style desktop companion: a small cartoon creature floating on the
 * desktop, always-on-top, mirrored to the pet extension's mood via
 * `setWidget` frames (`widgetKey: "pet-widget"`, structured state in
 * `widgetMeta`; ASCII lines are the fallback for older builds).
 *
 * Interactions:
 *  - the eyes follow the cursor; drag the body to move the window
 *  - hover reveals the chat pill (type + Enter → prompt goes to the main
 *    window's session) and a round record button (MediaRecorder → Rust
 *    `transcribe_audio` / OpenAI whisper) plus the × dock button
 */

import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

const PET_WIDGET_KEY = "pet-widget";

type Mood = "idle" | "working" | "celebrating" | "happy" | "sad" | "sleepy" | "eating";

interface PetMeta {
	species: string;
	name: string;
	level: number;
	xp?: number;
	mood: Mood;
	busy?: boolean;
	floating?: boolean | null;
}

type UiRequest = Record<string, unknown>;

/** Mirrors state.ts levelForXp so the window can label the pet from the raw
 * save file before any widget frame arrives. */
const levelForXp = (xp: number) => Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 10)) + 1);

function PetFloat() {
	const [meta, setMeta] = useState<PetMeta | null>(null);
	const [saveMeta, setSaveMeta] = useState<PetMeta | null>(null);
	const [lines, setLines] = useState<string[] | null>(null);
	const [hover, setHover] = useState(false);
	const [chatOpen, setChatOpen] = useState(false);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [look, setLook] = useState({ x: 0, y: 0 });
	const shellRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; y: number } | null>(null);
	const justDraggedRef = useRef(false);

	// Bootstrap from the pet save so the real critter renders even when no
	// workspace session has pushed a widget frame yet this run.
	useEffect(() => {
		void invoke<Record<string, unknown> | null>("get_pet_state")
			.then((save) => {
				if (!save || typeof save !== "object") return;
				const species = save.speciesId;
				const name = save.name;
				if (typeof species !== "string" || typeof name !== "string") return;
				const xp = typeof save.xp === "number" ? save.xp : 0;
				setSaveMeta({ species, name, xp, level: levelForXp(xp), mood: "idle" });
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		const un = listen<UiRequest>("extension_ui_request", (ev) => {
			const req = ev.payload;
			if (req.method !== "setWidget" || req.widgetKey !== PET_WIDGET_KEY) return;
			const m = req.widgetMeta as PetMeta | undefined;
			if (m && m.species) setMeta(m);
			setLines((req.widgetLines as string[] | undefined) ?? null);
		});
		return () => {
			void un.then((f) => f());
		};
	}, []);

	// Eyes follow the cursor: poll the global cursor position while hovered.
	useEffect(() => {
		if (!hover) return;
		let alive = true;
		const win = getCurrentWindow();
		const tick = async () => {
			try {
				const [pos, origin, sf] = await Promise.all([
					cursorPosition(),
					win.innerPosition(),
					win.scaleFactor(),
				]);
				const el = shellRef.current;
				if (!alive || !el) return;
				const rect = el.getBoundingClientRect();
				const cx = origin.x / sf + rect.left + rect.width / 2;
				const cy = origin.y / sf + rect.top + rect.height / 2;
				const dx = pos.x / sf - cx;
				const dy = pos.y / sf - cy;
				const len = Math.hypot(dx, dy) || 1;
				const m = Math.min(1, len / 120) * 3.2;
				setLook({ x: (dx / len) * m, y: (dy / len) * m });
			} catch { /* window gone */ }
		};
		const id = setInterval(() => void tick(), 50);
		return () => {
			alive = false;
			clearInterval(id);
			setLook({ x: 0, y: 0 });
		};
	}, [hover]);

	const sendPrompt = useCallback(async () => {
		const text = input.trim();
		if (!text || busy) return;
		setBusy(true);
		try {
			await invoke("rpc_command", { command: { type: "prompt", message: text } });
			setInput("");
		} catch (e) {
			console.error("prompt failed:", e);
		} finally {
			setBusy(false);
		}
	}, [input, busy]);

	const effectiveMeta = meta ?? saveMeta;
	const noPet = !effectiveMeta && (!lines || lines.length === 0);
	const showChat = chatOpen || hover;
	const mood: Mood = effectiveMeta?.mood ?? "idle";

	return (
		<div
			ref={shellRef}
			style={shellStyle}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => {
				setHover(false);
				dragRef.current = null;
			}}
			onMouseDown={(e) => {
				justDraggedRef.current = false;
				if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
				dragRef.current = { x: e.clientX, y: e.clientY };
			}}
			onMouseMove={(e) => {
				const d = dragRef.current;
				if (!d) return;
				if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
					dragRef.current = null;
					justDraggedRef.current = true;
					void getCurrentWindow().startDragging();
				}
			}}
			onMouseUp={() => {
				dragRef.current = null;
			}}
		>
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
				<button
					type="button"
					onClick={() => {
						if (justDraggedRef.current) {
							justDraggedRef.current = false;
							return;
						}
						setChatOpen((v) => !v);
					}}
					title={effectiveMeta ? `${effectiveMeta.name} — click to chat` : "pet"}
					style={{ all: "unset", cursor: "pointer" }}
				>
					<Critter
						species={effectiveMeta?.species ?? "slime"}
						mood={mood}
						look={look}
						busy={busy || effectiveMeta?.busy}
						noPet={noPet}
					/>
				</button>
				<div style={chipStyle}>
					{noPet ? "no pet · /pet adopt" : `${effectiveMeta?.name ?? "pet"} · Lv.${effectiveMeta?.level ?? 1}`}
				</div>
				{showChat && !noPet && (
					<ChatPill input={input} setInput={setInput} onSend={sendPrompt} busy={busy} />
				)}
				{!meta && lines && lines.length > 0 && (
					<pre style={asciiStyle}>{lines.join("\n")}</pre>
				)}
			</div>
			{hover && <DockButton />}
		</div>
	);
}

// --- chat pill (input + round record button) --------------------------------

function ChatPill({
	input,
	setInput,
	onSend,
	busy,
}: {
	input: string;
	setInput: (v: string) => void;
	onSend: () => void;
	busy: boolean;
}) {
	const [recording, setRecording] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const mimeRef = useRef("audio/webm");
	const streamRef = useRef<MediaStream | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => inputRef.current?.focus(), []);

	const stopStream = () => {
		streamRef.current?.getTracks().forEach((t) => t.stop());
		streamRef.current = null;
	};

	const startRecording = async () => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			streamRef.current = stream;
			const mime = MediaRecorder.isTypeSupported("audio/mp4")
				? "audio/mp4"
				: MediaRecorder.isTypeSupported("audio/webm")
					? "audio/webm"
					: "";
			const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
			mimeRef.current = rec.mimeType || mime || "audio/webm";
			chunksRef.current = [];
			rec.ondataavailable = (e) => {
				if (e.data.size > 0) chunksRef.current.push(e.data);
			};
			rec.onstop = () => {
				stopStream();
				const blob = new Blob(chunksRef.current, { type: mimeRef.current });
				chunksRef.current = [];
				if (blob.size === 0) return;
				const reader = new FileReader();
				reader.onload = async () => {
					const result = reader.result;
					if (typeof result !== "string") return;
					const b64 = result.slice(result.indexOf(",") + 1);
					setTranscribing(true);
					try {
						const text = await invoke<string>("transcribe_audio", {
							audioB64: b64,
							mimeType: mimeRef.current,
						});
						if (text) setInput((input ? input.trimEnd() + " " : "") + text);
					} catch (e) {
						console.error("transcribe failed:", e);
					} finally {
						setTranscribing(false);
					}
				};
				reader.readAsDataURL(blob);
			};
			recorderRef.current = rec;
			setRecording(true);
			rec.start(250);
		} catch (e) {
			console.error("mic failed:", e);
		}
	};

	const stopRecording = () => {
		recorderRef.current?.stop();
		recorderRef.current = null;
		setRecording(false);
	};

	return (
		<div data-nodrag style={chatBarStyle}>
			<input
				ref={inputRef}
				value={transcribing ? "transcribing…" : input}
				disabled={transcribing}
				placeholder={recording ? "listening…" : "say something"}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") onSend();
					if (e.key === "Escape") setInput("");
					e.stopPropagation();
				}}
				style={chatInputStyle}
			/>
			<button
				type="button"
				title={recording ? "Stop & transcribe" : "Hold a thought, speak it"}
				onClick={() => (recording ? stopRecording() : void startRecording())}
				style={{
					...recButtonStyle,
					background: recording ? "#e5484d" : "rgba(255,255,255,0.16)",
					animation: recording ? "petBlink 0.9s ease-in-out infinite" : undefined,
				}}
			>
				{recording ? "■" : transcribing ? "…" : "●"}
			</button>
		</div>
	);
}

// --- the critter ------------------------------------------------------------

function Critter({
	species,
	mood,
	look,
	busy,
	noPet,
}: {
	species: string;
	mood: Mood;
	look: { x: number; y: number };
	busy?: boolean;
	noPet?: boolean;
}) {
	const s = SPECIES[species] ?? SPECIES.slime;
	const eye =
		mood === "happy" || mood === "celebrating" ? "happy" : mood === "sleepy" ? "closed" : "open";
	const mouth =
		mood === "sad" ? "frown" :
		mood === "celebrating" ? "open" :
		mood === "eating" ? "nom" :
		mood === "sleepy" ? "flat" : "smile";

	const anim =
		mood === "celebrating" ? "petBounce 0.55s ease-in-out infinite" :
		mood === "working" || busy ? "petWiggle 0.9s ease-in-out infinite" :
		mood === "eating" ? "petNom 0.7s ease-in-out infinite" :
		mood === "sleepy" ? "petBreath 3.4s ease-in-out infinite" :
		"petBreath 2.6s ease-in-out infinite";

	return (
		<div
			style={{
				width: 100,
				height: 96,
				borderRadius:
					species === "slime" ? "42% 42% 48% 48% / 56% 56% 40% 40%" : "50% 50% 46% 46% / 55% 55% 45% 45%",
				background: s.body,
				border: `2px solid ${s.edge}`,
				boxShadow:
					"0 8px 20px rgba(0,0,0,0.30), inset 0 -12px 20px rgba(0,0,0,0.15), inset 0 6px 10px rgba(255,255,255,0.25)",
				position: "relative",
				animation: anim,
				opacity: noPet ? 0.45 : 1,
				transition: "opacity 200ms",
			}}
		>
			<style>{`
				@keyframes petBreath { 0%,100% { transform: translateY(0) scale(1);} 50% { transform: translateY(-3px) scale(1.015);} }
				@keyframes petBounce { 0%,100% { transform: translateY(0);} 40% { transform: translateY(-12px) scale(1.02);} }
				@keyframes petWiggle { 0%,100% { transform: rotate(-2deg);} 50% { transform: rotate(2deg);} }
				@keyframes petNom { 0%,100% { transform: scaleY(1);} 50% { transform: scaleY(0.94);} }
				@keyframes petBlink { 0%,90%,100% { transform: scaleY(1);} 95% { transform: scaleY(0.08);} }
			`}</style>
			{s.ears}
			<Eye x={32} y={42} kind={eye} color={s.ink} look={look} />
			<Eye x={66} y={42} kind={eye} color={s.ink} look={look} />
			{/* blush */}
			<div style={{ position: "absolute", left: 14, top: 56, width: 10, height: 5, borderRadius: 5, background: s.blush, opacity: 0.8 }} />
			<div style={{ position: "absolute", right: 14, top: 56, width: 10, height: 5, borderRadius: 5, background: s.blush, opacity: 0.8 }} />
			<Mouth cx={49} cy={60} kind={mouth} color={s.ink} />
			{species === "cat" && <Whiskers color={s.ink} />}
			{mood === "sleepy" && <span style={zzzStyle}>z</span>}
			{mood === "celebrating" && <span style={sparkleStyle}>✦</span>}
			{busy && mood === "working" && <span style={sparkleStyle}>⌁</span>}
		</div>
	);
}

const SPECIES: Record<
	string,
	{ body: string; edge: string; ink: string; blush: string; ears: React.ReactNode }
> = {
	cat: {
		body: "linear-gradient(180deg,#ffd98e,#f2ab55)",
		edge: "#a35f1c",
		ink: "#54330e",
		blush: "#f0907a",
		ears: (
			<>
				<div style={{ position: "absolute", top: -13, left: 8, width: 0, height: 0, borderLeft: "13px solid transparent", borderRight: "13px solid transparent", borderBottom: "20px solid #f2ab55" }} />
				<div style={{ position: "absolute", top: -9, left: 14, width: 0, height: 0, borderLeft: "7px solid transparent", borderRight: "7px solid transparent", borderBottom: "11px solid #f7c98a" }} />
				<div style={{ position: "absolute", top: -13, right: 8, width: 0, height: 0, borderLeft: "13px solid transparent", borderRight: "13px solid transparent", borderBottom: "20px solid #f2ab55" }} />
				<div style={{ position: "absolute", top: -9, right: 14, width: 0, height: 0, borderLeft: "7px solid transparent", borderRight: "7px solid transparent", borderBottom: "11px solid #f7c98a" }} />
			</>
		),
	},
	dog: {
		body: "linear-gradient(180deg,#ecb478,#d1893f)",
		edge: "#8a5524",
		ink: "#4a2c10",
		blush: "#e8906a",
		ears: (
			<>
				<div style={{ position: "absolute", top: 4, left: -16, width: 22, height: 38, borderRadius: "12px 12px 14px 14px", background: "#96602c", transform: "rotate(16deg)", boxShadow: "inset 0 -6px 8px rgba(0,0,0,0.2)" }} />
				<div style={{ position: "absolute", top: 4, right: -16, width: 22, height: 38, borderRadius: "12px 12px 14px 14px", background: "#96602c", transform: "rotate(-16deg)", boxShadow: "inset 0 -6px 8px rgba(0,0,0,0.2)" }} />
			</>
		),
	},
	slime: {
		body: "linear-gradient(180deg,#9ae8b4,#4fc573)",
		edge: "#2d8048",
		ink: "#155a2e",
		blush: "#7adfa0",
		ears: null,
	},
};

function Eye({
	x,
	y,
	kind,
	color,
	look,
}: {
	x: number;
	y: number;
	kind: "open" | "closed" | "happy";
	color: string;
	look: { x: number; y: number };
}) {
	const base: React.CSSProperties = { position: "absolute", left: x - 8, top: y - 8 };
	if (kind === "closed") {
		return (
			<svg width="16" height="8" viewBox="0 0 16 8" style={{ ...base, top: y - 4 }}>
				<path d="M1 2 Q8 8 15 2" stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" />
			</svg>
		);
	}
	if (kind === "happy") {
		return (
			<svg width="16" height="10" viewBox="0 0 16 10" style={{ ...base, top: y - 5 }}>
				<path d="M1 9 Q8 0 15 9" stroke={color} strokeWidth="2.6" fill="none" strokeLinecap="round" />
			</svg>
		);
	}
	// open: white sclera + tracking pupil
	return (
		<div style={base}>
			<div
				style={{
					width: 16,
					height: 16,
					borderRadius: 8,
					background: "#fff",
					boxShadow: "inset 0 -1px 2px rgba(0,0,0,0.15)",
					overflow: "hidden",
					animation: "petBlink 4.4s linear infinite",
					position: "relative",
				}}
			>
				<div
					style={{
						position: "absolute",
						left: 4 + look.x,
						top: 4 + look.y,
						width: 8,
						height: 8,
						borderRadius: 4,
						background: color,
					}}
				>
					<div
						style={{
							position: "absolute",
							left: 1.4,
							top: 1.2,
							width: 2.6,
							height: 2.6,
							borderRadius: 2,
							background: "rgba(255,255,255,0.9)",
						}}
					/>
				</div>
			</div>
		</div>
	);
}

function Whiskers({ color }: { color: string }) {
	const line = (top: number, left: number, rot: number, flip = false): React.CSSProperties => ({
		position: "absolute",
		top,
		[left < 0 ? "right" : "left"]: Math.abs(left),
		width: 16,
		height: 1.6,
		borderRadius: 1,
		background: color,
		opacity: 0.55,
		transform: `rotate(${flip ? -rot : rot}deg)`,
	});
	return (
		<>
			<div style={line(54, -10, 8)} />
			<div style={line(60, -10, -6)} />
			<div style={line(54, -10, -8, true)} />
			<div style={line(60, -10, 6, true)} />
		</>
	);
}

function Mouth({ cx, cy, kind, color }: { cx: number; cy: number; kind: string; color: string }) {
	const base: React.CSSProperties = { position: "absolute", left: cx - 10, top: cy };
	if (kind === "frown") {
		return (
			<svg width="20" height="10" viewBox="0 0 20 10" style={base}>
				<path d="M2 8 Q10 1 18 8" stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" />
			</svg>
		);
	}
	if (kind === "open") {
		return (
			<div style={{ ...base, left: cx - 8, width: 16, height: 13, borderRadius: "0 0 10px 10px", background: color }}>
				<div style={{ position: "absolute", left: 3, bottom: 1, width: 10, height: 5, borderRadius: "0 0 6px 6px", background: "#e8695f" }} />
			</div>
		);
	}
	if (kind === "nom") {
		return (
			<svg width="20" height="10" viewBox="0 0 20 10" style={base}>
				<path d="M2 2 Q6 8 10 2 Q14 8 18 2" stroke={color} strokeWidth="2.2" fill="none" strokeLinecap="round" />
			</svg>
		);
	}
	if (kind === "flat") {
		return <div style={{ ...base, left: cx - 7, width: 14, height: 3, borderRadius: 2, background: color, top: cy + 4 }} />;
	}
	return (
		<svg width="20" height="10" viewBox="0 0 20 10" style={base}>
			<path d="M2 2 Q10 9 18 2" stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" />
		</svg>
	);
}

// --- dock (×) ---------------------------------------------------------------

function DockButton() {
	return (
		<button
			type="button"
			data-nodrag
			onClick={() => void invoke("close_pet_window")}
			title="Dock back into the app"
			style={{
				position: "absolute",
				top: 6,
				right: 6,
				width: 20,
				height: 20,
				borderRadius: 10,
				border: "none",
				background: "rgba(0,0,0,0.5)",
				color: "#fff",
				fontSize: 12,
				lineHeight: "20px",
				cursor: "pointer",
				padding: 0,
			}}
		>
			×
		</button>
	);
}

// --- styles -----------------------------------------------------------------

const shellStyle: React.CSSProperties = {
	position: "relative",
	width: "100vw",
	height: "100vh",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	userSelect: "none",
	WebkitUserSelect: "none",
};

const chipStyle: React.CSSProperties = {
	fontSize: 11,
	color: "#e8f4e8",
	background: "rgba(16,20,24,0.72)",
	borderRadius: 10,
	padding: "2px 10px",
	backdropFilter: "blur(6px)",
	border: "1px solid rgba(255,255,255,0.10)",
	whiteSpace: "nowrap",
};

const asciiStyle: React.CSSProperties = {
	margin: "4px 0 0",
	fontSize: 11,
	lineHeight: 1.25,
	color: "#d4f7d4",
	background: "rgba(20,24,28,0.82)",
	borderRadius: 12,
	padding: "8px 12px",
};

const chatBarStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 5,
	marginTop: 2,
	padding: "4px 5px 4px 12px",
	borderRadius: 16,
	background: "rgba(16,20,24,0.85)",
	border: "1px solid rgba(255,255,255,0.14)",
	backdropFilter: "blur(10px)",
	boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
};

const chatInputStyle: React.CSSProperties = {
	width: 118,
	border: "none",
	outline: "none",
	background: "transparent",
	color: "#e8f4e8",
	fontSize: 12,
};

const recButtonStyle: React.CSSProperties = {
	width: 24,
	height: 24,
	borderRadius: 12,
	border: "none",
	color: "#ffb3b5",
	fontSize: 10,
	cursor: "pointer",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	padding: 0,
};

const zzzStyle: React.CSSProperties = { position: "absolute", top: 4, right: 14, color: "#fff", fontSize: 14, opacity: 0.85 };
const sparkleStyle: React.CSSProperties = { position: "absolute", top: 6, right: 12, color: "#ffe066", fontSize: 14 };

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<PetFloat />
	</StrictMode>,
);
