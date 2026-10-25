/**
 * pet.tsx — the detached floating pet window (pet.html).
 *
 * A small companion floating on the desktop, always-on-top, mirroring the core
 * pet service (`pet_state` frames forwarded by the desktop bridge).
 *
 * Interactions:
 *  - the eyes follow the cursor; drag the body to move the window
 *  - click toggles the chat pill (prompt goes to the main session); the round
 *    record button transcribes via Rust `transcribe_audio`
 *  - double-click docks the pet back into the app; right-click opens the menu
 */

import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Cookie, EyeOff, MessageCircle, PanelTop, Settings, Sparkles } from "lucide-react";
import "./i18n";
import { PetChatPill, petChipStyle } from "./components/pet-shared";
import { PetFigure } from "./components/PetFigure";
import { PetMenu, petPluginItems, type PetMenuItem } from "./components/PetMenu";
import { invokePetWindow, usePet } from "./lib/pet";
import { sendCommandAwait } from "./lib/transport";

function PetFloat() {
	const { t } = useTranslation();
	const { pet, species, loaded, actions, act } = usePet();
	const [hover, setHover] = useState(false);
	const [chatOpen, setChatOpen] = useState(false);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	const [look, setLook] = useState({ x: 0, y: 0 });
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; y: number } | null>(null);
	const justDraggedRef = useRef(false);
	const dismissMenu = useCallback(() => setMenu(null), []);
	useEffect(() => {
		if (loaded) void invoke("pet_window_ready").catch(() => {});
	}, [loaded]);
	useEffect(() => {
		if (!hover || pet?.speciesId === "pixel-mochi") return;
		let alive = true;
		const win = getCurrentWindow();
		const timer = setInterval(() => {
			void Promise.all([cursorPosition(), win.innerPosition(), win.scaleFactor()]).then(([cursor, origin, scale]) => {
				if (!alive || !bodyRef.current) return;
				const r = bodyRef.current.getBoundingClientRect();
				const dx = (cursor.x - origin.x) / scale - r.left - r.width / 2;
				const dy = (cursor.y - origin.y) / scale - r.top - r.height / 2;
				const length = Math.hypot(dx, dy) || 1, amount = Math.min(1, length / 100) * 3;
				setLook({ x: dx / length * amount, y: dy / length * amount });
			}).catch(() => {});
		}, 60);
		return () => { alive = false; clearInterval(timer); setLook({ x: 0, y: 0 }); };
	}, [hover, pet?.speciesId]);
	const sendPrompt = useCallback(async () => {
		if (!input.trim() || busy) return;
		setBusy(true); setError(""); setSent(false);
		try { await sendCommandAwait({ type: "prompt", message: input.trim() }, 60000, true); setInput(""); setSent(true); }
		catch (e) { setError(String(e)); } finally { setBusy(false); }
	}, [input, busy]);
	const transcribe = useCallback((audioB64: string, mimeType: string) => invoke<string>("transcribe_audio", { audioB64, mimeType }), []);
	const run = (command: Parameters<typeof invokePetWindow>[0]) => { void invokePetWindow(command).catch((e) => setError(String(e))); };
	const showChat = chatOpen || hover || Boolean(input) || busy || Boolean(error);

	const items: PetMenuItem[] = [
		{ id: "chat", label: t(chatOpen ? "pet.menu.closeChat" : "pet.menu.chat"), icon: <MessageCircle strokeWidth={1.8} />, onSelect: () => setChatOpen((v) => !v) },
		...(pet ? [
			{ id: "feed", label: t("pet.menu.feed"), icon: <Cookie strokeWidth={1.8} />, onSelect: () => { void act({ action: "feed" }).catch((e) => setError(String(e))); } },
			{ id: "play", label: t("pet.menu.play"), icon: <Sparkles strokeWidth={1.8} />, onSelect: () => { void act({ action: "play" }).catch((e) => setError(String(e))); } },
		] : []),
		...petPluginItems(actions),
		{ id: "dock", label: t("pet.menu.dock"), icon: <PanelTop strokeWidth={1.8} />, separator: true, onSelect: () => run("dock_pet_window") },
		{ id: "settings", label: t("pet.menu.settings"), icon: <Settings strokeWidth={1.8} />, onSelect: () => run("open_pet_settings") },
		{ id: "hide", label: t("pet.menu.hideFloat"), icon: <EyeOff strokeWidth={1.8} />, danger: true, separator: true, onSelect: () => run("close_pet_window") },
	];

	return <div style={shellStyle}>
		<div style={{ position: "absolute", left: 118, top: 24, width: 64, height: 64, cursor: "grab" }} ref={bodyRef}
			onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
			onContextMenu={(e) => { e.preventDefault(); dragRef.current = null; setMenu({ x: e.clientX, y: e.clientY }); }}
			onMouseDown={(e) => { if (e.button === 0) { justDraggedRef.current = false; dragRef.current = { x: e.clientX, y: e.clientY }; } }}
			onMouseMove={(e) => { const start = dragRef.current; if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) { dragRef.current = null; justDraggedRef.current = true; void getCurrentWindow().startDragging().catch(() => {}); } }}
			onMouseUp={() => { dragRef.current = null; }}
		>
			<button type="button" aria-label={pet?.name ?? t("pet.menu.adopt")} aria-haspopup="menu" title={t("pet.floatHint")}
				style={{ all: "unset", display: "flex", cursor: "inherit" }}
				onClick={() => { if (!justDraggedRef.current) setChatOpen((v) => !v); }}
				onKeyDown={(e) => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left + r.width / 2, y: r.bottom }); } }}
				onDoubleClick={() => run("dock_pet_window")}>
				<PetFigure species={pet?.speciesId} mood={pet?.mood} look={look} busy={busy || pet?.busy} scale={pet?.scale} frames={species?.frames} />
			</button>
		</div>
		{showChat && <div data-nodrag onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ position: "absolute", top: 96, left: 22, width: 256, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
			{pet && <span style={{ ...petChipStyle, fontSize: 10 }}>{pet.name}{pet.subtitle ? ` · ${pet.subtitle}` : ""}</span>}
			<PetChatPill input={input} setInput={setInput} onSend={sendPrompt} onTranscribe={transcribe} sending={busy} error={error} sent={sent} autoFocus={chatOpen} onActive={() => setChatOpen(true)} />
		</div>}
		{menu && <PetMenu x={menu.x} y={menu.y} title={pet?.name} level={pet?.level} items={items} onDismiss={dismissMenu} />}
	</div>;
}

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

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<PetFloat />
	</StrictMode>,
);
