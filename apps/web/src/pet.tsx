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
 *    `transcribe_audio` / OpenAI whisper); right-click opens pet actions
 */

import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
	PetSprite,
	PetChatPill,
	SPECIES,
	levelForXp,
	petAsciiStyle,
	petChipStyle,
	type Mood,
	type PetMeta,
} from "./components/pet-shared";

const PET_WIDGET_KEY = "pet-widget";

type UiRequest = Record<string, unknown>;

function PetFloat() {
	const [meta, setMeta] = useState<PetMeta | null>(null);
	const [saveMeta, setSaveMeta] = useState<PetMeta | null>(null);
	const [lines, setLines] = useState<string[] | null>(null);
	const [hover, setHover] = useState(false);
	const [chatOpen, setChatOpen] = useState(false);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [look, setLook] = useState({ x: 0, y: 0 });
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; y: number } | null>(null);
	const justDraggedRef = useRef(false);
	const petSpeciesId = (meta ?? saveMeta)?.species;

	useEffect(() => {
		if (!contextMenu) return;
		const dismiss = () => setContextMenu(null);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") dismiss();
		};
		window.addEventListener("mousedown", dismiss);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", dismiss);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [contextMenu]);

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
				setSaveMeta({
					species,
					name,
					xp,
					level: levelForXp(xp),
					mood: "idle",
					scale: typeof save.scale === "number" ? save.scale : 1,
					subtitle: typeof save.subtitle === "string" ? save.subtitle : "",
				});
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
		if (!hover || petSpeciesId === "pixel-mochi") return;
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
	}, [hover, petSpeciesId]);

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

	const transcribe = useCallback((audioB64: string, mimeType: string) => {
		return invoke<string>("transcribe_audio", { audioB64, mimeType });
	}, []);

	const effectiveMeta = meta ?? saveMeta;
	const noPet = !effectiveMeta && (!lines || lines.length === 0);
	const customSpecies = Boolean(effectiveMeta?.species && !SPECIES[effectiveMeta.species]);
	const showChat = chatOpen || hover;
	const mood: Mood = effectiveMeta?.mood ?? "idle";

	return (
		<div
			ref={shellRef}
			style={shellStyle}
			onContextMenu={(event) => {
				event.preventDefault();
				setContextMenu({ x: event.clientX, y: event.clientY });
			}}
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
					{customSpecies ? (
						<pre
							style={{
								...petAsciiStyle,
								transform: `scale(${effectiveMeta?.scale ?? 1})`,
								transformOrigin: "center",
							}}
						>
							{lines?.slice(0, -1).join("\n") ?? ""}
						</pre>
					) : (
						<PetSprite
							species={effectiveMeta?.species ?? "slime"}
							mood={mood}
							look={look}
							busy={busy || effectiveMeta?.busy}
							scale={effectiveMeta?.scale ?? 1}
							noPet={noPet}
						/>
					)}
				</button>
				<div style={petChipStyle}>
					{noPet ? "no pet · /pet adopt" : `${effectiveMeta?.name ?? "pet"} · Lv.${effectiveMeta?.level ?? 1}`}
				</div>
				{effectiveMeta?.subtitle && <div style={petSubtitleStyle}>{effectiveMeta.subtitle}</div>}
				{showChat && !noPet && (
					<PetChatPill input={input} setInput={setInput} onSend={sendPrompt} onTranscribe={transcribe} />
				)}
				{!effectiveMeta && lines && lines.length > 0 && (
					<pre style={petAsciiStyle}>{lines.join("\n")}</pre>
				)}
			</div>
			{contextMenu && <PetContextMenu x={contextMenu.x} y={contextMenu.y} onDismiss={() => setContextMenu(null)} />}
		</div>
	);
}

function PetContextMenu({ x, y, onDismiss }: { x: number; y: number; onDismiss: () => void }) {
	const width = 208;
	const height = 92;
	const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
	const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
	const run = (command: string) => {
		onDismiss();
		void invoke(command).catch((error) => console.error("pet menu action failed:", error));
	};

	return (
		<div
			role="menu"
			className="fixed z-50 min-w-52 rounded-xl border border-border bg-surface p-1 shadow-lg"
			style={{ left, top, width }}
			onMouseDown={(event) => event.stopPropagation()}
		>
			<button
				type="button"
				role="menuitem"
				onClick={() => run("close_pet_window")}
				className="flex w-full flex-col rounded-lg px-3 py-1.5 text-left text-[13px] text-fg hover:bg-surface-2"
			>
				<span>Hide pet</span>
				<span className="text-[11px] text-muted">Close the floating pet</span>
			</button>
			<button
				type="button"
				role="menuitem"
				onClick={() => run("open_pet_settings")}
				className="flex w-full flex-col rounded-lg px-3 py-1.5 text-left text-[13px] text-fg hover:bg-surface-2"
			>
				<span>Pet settings</span>
				<span className="text-[11px] text-muted">Open the Pet settings page</span>
			</button>
		</div>
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

const petSubtitleStyle: React.CSSProperties = {
	maxWidth: 190,
	fontSize: 10,
	lineHeight: 1.25,
	color: "rgba(255,255,255,0.78)",
	textAlign: "center",
	textShadow: "0 1px 4px rgba(0,0,0,0.65)",
};

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<PetFloat />
	</StrictMode>,
);
