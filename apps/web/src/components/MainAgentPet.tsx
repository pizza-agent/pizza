import { memo, useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Cookie, Info, PictureInPicture2, Settings, Sparkles, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { MainAgentProfile } from "@/lib/main-agent-profile";
import { PET_SETTINGS_PATH, type PetState } from "@/lib/pet";
import { Z } from "@/lib/z-index";
import { cn, isTauri } from "@/lib/utils";
import { PetFigure } from "./PetFigure";
import { PetMenu, petPluginItems, type PetMenuItem } from "./PetMenu";

type Position = { x: number; y: number };
const KEY = "pizza:main-agent-pet-position";
/** Pet box size and the grip offset (its visual centre) used for desktop hand-off. */
const BOX_W = 84;
const GRIP = { x: 42, y: 32 };

/** Overlay only. Dragging never updates parent state or message measurements. */
export const MainAgentPet = memo(function MainAgentPet({ profile, pet: petState, running, onOpen, onShowProfile, topInset = 0 }: {
	profile: MainAgentProfile | null;
	pet: PetState;
	running: boolean;
	/** Double-click: toggle the agent profile panel. */
	onOpen: () => void;
	/** Menu: show the agent profile panel. */
	onShowProfile: () => void;
	topInset?: number;
}) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { pet, species, floating, actions, act } = petState;
	const layer = useRef<HTMLDivElement>(null);
	const box = useRef<HTMLDivElement>(null);
	const position = useRef<Position | null>(null);
	const drag = useRef<{ id: number; startX: number; startY: number; left: number; top: number; moved: boolean; detached: boolean; gripX: number; gripY: number } | null>(null);
	const [error, setError] = useState("");
	const [look, setLook] = useState({ x: 0, y: 0 });
	const [menu, setMenu] = useState<{ x: number; y: number; screenX: number; screenY: number } | null>(null);
	const handoff = useRef<Promise<unknown> | null>(null);
	const lastPoint = useRef({ x: 0, y: 0 });
	const suppressDoubleClick = useRef(false);
	const lastClick = useRef(0);
	const place = useCallback((x?: number, y?: number) => {
		if (!layer.current || !box.current) return;
		const width = Math.max(0, layer.current.clientWidth - BOX_W);
		const height = Math.max(0, layer.current.clientHeight - 160);
		const next = position.current;
		const left = Math.min(width, Math.max(0, x ?? (next ? next.x * width : width / 2)));
		const top = Math.min(height, Math.max(topInset, y ?? (next ? next.y * height : 0)));
		box.current.style.transform = `translate3d(${left}px, ${top}px, 0)`;
		return { left, top, width, height };
	}, [topInset]);
	useEffect(() => {
		try {
			const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Position | null;
			if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) position.current = { x: Math.max(0, Math.min(1, value.x)), y: Math.max(0, Math.min(1, value.y)) };
		} catch { /* optional preference */ }
		const observer = new ResizeObserver(() => { place(); });
		if (layer.current) observer.observe(layer.current);
		place();
		return () => observer.disconnect();
	}, [place]);
	useEffect(() => { if (!floating && !drag.current) place(); }, [floating, place]);
	useEffect(() => { if (floating) setMenu(null); }, [floating]);
	const invoke = (command: string, args?: Record<string, unknown>) =>
		import("@tauri-apps/api/core").then(({ invoke }) => invoke(command, args));
	const down = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
		const rect = box.current!.getBoundingClientRect();
		const bounds = layer.current!.getBoundingClientRect();
		drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left - bounds.left, top: rect.top - bounds.top, moved: false, detached: false, gripX: event.clientX - rect.left - GRIP.x, gripY: event.clientY - rect.top - GRIP.y };
		setError("");
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const move = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
		if (Math.hypot(dx, dy) > 6) current.moved = true;
		if (!current.moved) return;
		suppressDoubleClick.current = true; lastClick.current = 0;
		lastPoint.current = { x: event.screenX - current.gripX, y: event.screenY - current.gripY };
		const outside = event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight;
		if (isTauri() && pet && outside && !current.detached) {
			current.detached = true;
			handoff.current = invoke("detach_pet_window", lastPoint.current)
				.catch((e) => { current.detached = false; setError(String(e)); });
		}
		if (current.detached) void handoff.current?.then(() => invoke("move_pet_window", lastPoint.current)).catch(() => {});
		else place(current.left + dx, current.top + dy);
	};
	const up = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		if (current.detached) {
			lastPoint.current = { x: event.screenX - current.gripX, y: event.screenY - current.gripY };
			void handoff.current?.then(() => invoke("move_pet_window", lastPoint.current)).catch(() => {});
		} else if (current.moved) {
			const placed = place(current.left + event.clientX - current.startX, current.top + event.clientY - current.startY);
			if (placed) {
				position.current = { x: placed.width ? placed.left / placed.width : 0, y: placed.height ? placed.top / placed.height : 0 };
				try { localStorage.setItem(KEY, JSON.stringify(position.current)); } catch { /* optional preference */ }
			}
		} else {
			const now = performance.now();
			if (!suppressDoubleClick.current && lastClick.current > 0 && now - lastClick.current < 400) { onOpen(); lastClick.current = 0; }
			else { suppressDoubleClick.current = false; lastClick.current = now; }
		}
		drag.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
	};
	const openMenu = (clientX: number, clientY: number, screenX: number, screenY: number) => {
		drag.current = null;
		setMenu({ x: clientX, y: clientY, screenX, screenY });
	};
	const name = profile?.soul.name || pet?.name || t("layout.agent");
	const fail = (e: unknown) => setError(String(e));
	const items: PetMenuItem[] = menu ? [
		{ id: "profile", label: t("pet.menu.profile"), icon: <UserRound strokeWidth={1.8} />, onSelect: onShowProfile },
		...(pet ? [
			{ id: "feed", label: t("pet.menu.feed"), icon: <Cookie strokeWidth={1.8} />, onSelect: () => { void act({ action: "feed" }).catch(fail); } },
			{ id: "play", label: t("pet.menu.play"), icon: <Sparkles strokeWidth={1.8} />, onSelect: () => { void act({ action: "play" }).catch(fail); } },
		] : []),
		...petPluginItems(actions),
		...(isTauri() && pet ? [{
			id: "float", label: t("pet.menu.float"), icon: <PictureInPicture2 strokeWidth={1.8} />, separator: true,
			onSelect: () => {
				const rect = box.current?.getBoundingClientRect();
				const origin = { x: menu.screenX - menu.x, y: menu.screenY - menu.y };
				void invoke("detach_pet_window", rect ? { x: origin.x + rect.left + GRIP.x, y: origin.y + rect.top + GRIP.y } : { x: menu.screenX, y: menu.screenY }).catch(fail);
			},
		}] : []),
		{ id: "settings", label: t(pet ? "pet.menu.settings" : "pet.menu.adopt"), icon: <Settings strokeWidth={1.8} />, separator: !(isTauri() && pet), onSelect: () => navigate(PET_SETTINGS_PATH) },
	] : [];
	return (
		<div ref={layer} data-main-agent-pet-layer className={cn("pointer-events-none absolute inset-0", Z.overlay)}>
			<div ref={box} aria-hidden={floating || undefined} className={cn("group/pet absolute left-0 top-0 flex touch-none select-none flex-col items-center rounded-xl cursor-grab active:cursor-grabbing", floating ? "pointer-events-none opacity-0" : "pointer-events-auto")}
				style={{ width: BOX_W }}
				onPointerEnter={(event) => { if (!drag.current) setLook({ x: (event.nativeEvent.offsetX - 32) / 18, y: (event.nativeEvent.offsetY - 32) / 20 }); }} onPointerLeave={() => setLook({ x: 0, y: 0 })} onPointerDown={down} onPointerMove={move} onPointerUp={up}
				onPointerCancel={() => { drag.current = null; suppressDoubleClick.current = true; lastClick.current = 0; place(); }}
				onContextMenu={(event) => { event.preventDefault(); openMenu(event.clientX, event.clientY, event.screenX, event.screenY); }}>
				<div role="button" tabIndex={floating ? -1 : 0} aria-label={t("mainAgent.openProfile")} aria-haspopup="menu" title={error || t(isTauri() ? "pet.desktopHint" : "pet.hint")}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); }
						if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
							event.preventDefault();
							const r = event.currentTarget.getBoundingClientRect();
							openMenu(r.left + r.width / 2, r.bottom, window.screenX + r.left + r.width / 2, window.screenY + r.bottom);
						}
					}}
					className="-mt-2 flex items-center justify-center rounded-xl focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none">
					<span className="pointer-events-none"><PetFigure species={pet?.speciesId ?? (petState.loaded ? undefined : profile?.pet?.speciesId)} mood={running ? "working" : pet?.mood ?? "idle"} look={look} busy={running} scale={pet?.scale ?? 1} frames={species?.frames} /></span>
				</div>
				<div className="flex max-w-full items-center gap-0.5 rounded bg-bg/80 px-1 text-[10px] text-muted opacity-0 transition-opacity group-hover/pet:opacity-100 group-focus-within/pet:opacity-100">
					<span className="truncate">{name}</span>
					<button type="button" tabIndex={floating ? -1 : 0} onClick={onOpen} aria-label={t("mainAgent.openProfile")} className="rounded p-0.5 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"><Info className="h-3 w-3" /></button>
				</div>
			</div>
			{menu && <PetMenu x={menu.x} y={menu.y} title={pet?.name ?? name} level={pet?.level} items={items} onDismiss={() => setMenu(null)} />}
		</div>
	);
});
