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

import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { EyeOff, MessageCircle, Settings } from "lucide-react";
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

import { sendCommandAwait } from "./lib/transport";

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
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	const [look, setLook] = useState({ x: 0, y: 0 });
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; y: number } | null>(null);
	const justDraggedRef = useRef(false);
	const petSpeciesId = (meta ?? saveMeta)?.species;

	const dismissMenu = useCallback(() => setContextMenu(null), []);
	useEffect(() => {
		if (!contextMenu) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") dismissMenu();
		};
		window.addEventListener("mousedown", dismissMenu);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", dismissMenu);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [contextMenu, dismissMenu]);

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
			else if (req.widgetLines == null) { setMeta(null); setSaveMeta(null); }
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
		setError("");
		setSent(false);
		try {
			await sendCommandAwait({ type: "prompt", message: text }, 60000, true);
			setInput("");
			setSent(true);
		} catch (e) {
			setError(String(e));
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
	const showChat = chatOpen || hover || Boolean(input) || busy || Boolean(error);
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
				if (e.button !== 0 || (e.target as HTMLElement).closest("[data-nodrag]")) return;
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
							{lines?.slice(0, -1).join("\n") || "( ? )"}
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
					<PetChatPill input={input} setInput={setInput} onSend={sendPrompt} onTranscribe={transcribe} sending={busy} error={error} sent={sent} autoFocus={chatOpen} onActive={() => setChatOpen(true)} />
				)}
				{!effectiveMeta && lines && lines.length > 0 && (
					<pre style={petAsciiStyle}>{lines.join("\n")}</pre>
				)}
			</div>
			{contextMenu && (
				<PetContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					title={noPet ? undefined : effectiveMeta?.name}
					level={effectiveMeta?.level}
					chatOpen={chatOpen}
					onToggleChat={noPet ? undefined : () => setChatOpen((v) => !v)}
					onDismiss={dismissMenu}
				/>
			)}
		</div>
	);
}

interface PetMenuProps {
	x: number;
	y: number;
	title?: string;
	level?: number;
	chatOpen: boolean;
	onToggleChat?: () => void;
	onDismiss: () => void;
}

/** Labeled glass menu at the cursor. Styles live in pet.html (`.pet-menu*`). */
function PetContextMenu({ x, y, title, level, chatOpen, onToggleChat, onDismiss }: PetMenuProps) {
	const menuRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState({ left: x, top: y, origin: "top left" });

	// Open toward the roomier side of the cursor, then clamp into the (small,
	// 220×210) pet window. Measured after mount so header/rows can vary.
	useLayoutEffect(() => {
		const el = menuRef.current;
		if (!el) return;
		const { width, height } = el.getBoundingClientRect();
		const m = 4;
		const flipX = x + width + m > window.innerWidth;
		const flipY = y + height + m > window.innerHeight;
		const left = Math.max(m, Math.min(flipX ? x - width : x, window.innerWidth - width - m));
		const top = Math.max(m, Math.min(flipY ? y - height : y, window.innerHeight - height - m));
		setPos({ left, top, origin: `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}` });
		el.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({ preventScroll: true });
	}, [x, y]);

	useEffect(() => {
		window.addEventListener("blur", onDismiss);
		return () => window.removeEventListener("blur", onDismiss);
	}, [onDismiss]);

	const run = (command: string) => {
		onDismiss();
		void invoke(command).catch((error) => console.error("pet menu action failed:", error));
	};

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
		const i = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === "ArrowDown" ? i + 1 : i - 1 + items.length;
		items[next % items.length]?.focus();
	};

	return (
		<div
			ref={menuRef}
			role="menu"
			aria-label={title ?? "Pet"}
			className="pet-menu"
			data-nodrag
			style={{ left: pos.left, top: pos.top, transformOrigin: pos.origin }}
			onMouseDown={(event) => event.stopPropagation()}
			onContextMenu={(event) => event.preventDefault()}
			onKeyDown={onKeyDown}
		>
			{title && (
				<>
					<div className="pet-menu__header">
						<span>{title}</span>
						{level != null && <span className="pet-menu__level">Lv.{level}</span>}
					</div>
					<div className="pet-menu__sep" role="separator" />
				</>
			)}
			{onToggleChat && (
				<button
					type="button"
					role="menuitem"
					className="pet-menu__item"
					onClick={() => {
						onDismiss();
						onToggleChat();
					}}
				>
					<MessageCircle strokeWidth={1.8} />
					{chatOpen ? "Close chat" : "Chat"}
				</button>
			)}
			<button type="button" role="menuitem" className="pet-menu__item" onClick={() => run("open_pet_settings")}>
				<Settings strokeWidth={1.8} />
				Settings
			</button>
			<div className="pet-menu__sep" role="separator" />
			<button
				type="button"
				role="menuitem"
				className="pet-menu__item pet-menu__item--danger"
				onClick={() => run("close_pet_window")}
			>
				<EyeOff strokeWidth={1.8} />
				Hide pet
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
