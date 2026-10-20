/**
 * PetSettingsPage — Codex "Mini & Pets"-style settings page rendered for the
 * pet extension's menu (id "pet"). Reads the save + species catalog from the
 * menu's serialized `data`, subscribes to live widget frames for mood, and
 * steers /pet commands for every action.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { RefreshCw, Plus, PenLine } from "lucide-react";
import { PetSprite, PetChatPill, SPECIES, petChipStyle, type Mood, type PetMeta } from "./pet-shared";
import {
	runExtensionMenuItem,
	sendCommandAwait,
	subscribeExtensionUi,
	type ExtensionMenuItemWire,
	type ExtensionMenuWire,
} from "@/lib/transport";
import { cn, isTauri, MAIN_CHAT_CWD } from "@/lib/utils";
import { loadDraft, saveDraft } from "@/lib/composer-drafts";

const PET_WIDGET_KEY = "pet-widget";

interface PetSaveData {
	name: string;
	speciesId: string;
	xp: number;
	level: number;
	mood: Mood;
	scale?: number;
	subtitle?: string;
	busy?: boolean;
	floating?: boolean | null;
	adoptedAt?: number;
}

interface SpeciesData {
	id: string;
	name: string;
	description?: string;
	frames?: Record<string, string[]>;
}

interface PetMenuData {
	pet: PetSaveData | null;
	species: SpeciesData[];
}

function steer(command: string, onDone?: () => void): void {
	void sendCommandAwait({ type: "steer", message: command })
		.catch(() => {})
		.finally(() => {
			if (onDone) window.setTimeout(onDone, 500);
		});
}

function transcribe(audioB64: string, mimeType: string): Promise<string> {
	return import("@tauri-apps/api/core").then(({ invoke }) =>
		invoke<string>("transcribe_audio", { audioB64, mimeType }),
	);
}

/** Species card art: the cartoon face for built-ins, ASCII frame for user packs. */
function SpeciesArt({ species, mood = "idle", scale = 1, busy = false }: { species: SpeciesData; mood?: Mood; scale?: number; busy?: boolean }) {
	if (SPECIES[species.id]) {
		return <PetSprite species={species.id} mood={mood} look={{ x: 0, y: 0 }} scale={scale} busy={busy} />;
	}
	const frame = species.frames?.[mood]?.[0] ?? species.frames?.idle?.[0] ?? "( ? )";
	return (
		<pre
			className="whitespace-pre font-mono text-[11px] leading-tight text-muted"
			style={{ transform: `scale(${scale})`, transformOrigin: "center", margin: `${(scale - 1) * 22}px 0` }}
		>
			{frame}
		</pre>
	);
}

export function PetSettingsPage({ menu, onAction, workspace }: { menu: ExtensionMenuWire; onAction: () => void; workspace?: string }) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const data = (menu.data ?? {}) as Partial<PetMenuData>;
	const pet = data.pet ?? null;
	const species = data.species ?? [];

	// Live mood/meta from widget frames (the extension pushes ~1.25fps); a
	// cleared widget (widgetLines null) means the pet was released — refresh
	// the menu so data.pet drops too.
	const [liveMeta, setLiveMeta] = useState<PetMeta | null>(null);
	const onActionRef = useRef(onAction);
	onActionRef.current = onAction;
	useEffect(() => {
		let disposed = false;
		let un: (() => void) | undefined;
		void subscribeExtensionUi((req) => {
			if (disposed) return;
			if (req.method !== "setWidget" || req.widgetKey !== PET_WIDGET_KEY) return;
			if (req.widgetLines === null || req.widgetLines === undefined) {
				setLiveMeta(null);
				onActionRef.current();
				return;
			}
			const m = req.widgetMeta as PetMeta | undefined;
			if (m?.species) setLiveMeta(m);
		}).then((fn) => {
			if (disposed) fn();
			else un = fn;
		});
		return () => {
			disposed = true;
			un?.();
		};
	}, []);

	// Live meta wins over the (per-fetch) menu data so adopt/rename/level
	// changes reflect immediately without a refetch.
	const hasPet = pet !== null || liveMeta !== null;
	const displaySpeciesId = liveMeta?.species ?? pet?.speciesId ?? "slime";
	const displayName = liveMeta?.name ?? pet?.name ?? "pet";
	const displayLevel = liveMeta?.level ?? pet?.level ?? 1;
	const mood: Mood = liveMeta?.mood ?? pet?.mood ?? "idle";
	const busy = liveMeta?.busy ?? pet?.busy ?? false;
	const displayScale = liveMeta?.scale ?? pet?.scale ?? 1;
	const displaySubtitle = liveMeta?.subtitle ?? pet?.subtitle ?? "";
	const activeSpecies = species.find((item) => item.id === displaySpeciesId);

	// Chat pill → prompt into the session (main workspace, like the pet window).
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [chatError, setChatError] = useState("");
	const [chatSent, setChatSent] = useState(false);
	const [customizeOpen, setCustomizeOpen] = useState(false);
	const [customScale, setCustomScale] = useState(pet?.scale ?? 1);
	const [customSubtitle, setCustomSubtitle] = useState(pet?.subtitle ?? "");
	const [miniOpen, setMiniOpen] = useState(pet?.floating === true);
	useEffect(() => {
		setMiniOpen(pet?.floating === true);
	}, [pet?.floating]);
	useEffect(() => {
		if (!isTauri()) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void import("@tauri-apps/api/event").then(({ listen }) =>
			listen<{ open: boolean }>("pet_window_state", (event) => setMiniOpen(event.payload.open)),
		).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(() => {});
		return () => { disposed = true; unlisten?.(); };
	}, []);
	const sendPrompt = useCallback(async () => {
		const text = input.trim();
		if (!text || sending) return;
		setSending(true);
		setChatError("");
		setChatSent(false);
		try {
			await sendCommandAwait({ type: "prompt", message: text }, 60000, true);
			setInput("");
			setChatSent(true);
		} catch (e) {
			setChatError(String(e));
		} finally {
			setSending(false);
		}
	}, [input, sending]);

	const runItem = (item: ExtensionMenuItemWire) => {
		runExtensionMenuItem(item);
		window.setTimeout(onAction, 500);
	};

	const adopt = (speciesId: string) => steer(`/pet adopt ${speciesId}`, onAction);
	const openPicker = () => steer("/pet adopt", onAction);
	const saveCustomize = () => {
		steer(`/pet customize ${JSON.stringify({ scale: customScale, subtitle: customSubtitle })}`, onAction);
		setLiveMeta((current) => current ? { ...current, scale: customScale, subtitle: customSubtitle } : current);
		setCustomizeOpen(false);
	};
	const createCustomPet = () => {
		const targetWorkspace = workspace || MAIN_CHAT_CWD;
		const previousDraft = loadDraft(targetWorkspace);
		const prompt = `/skill:create-pet\n\n${previousDraft.input.trim()}\n\nHelp me create a custom Pizza pet. Ask me for its concept and visual style, then create a valid species JSON in ~/.pizza/agent/pets/. Do not overwrite existing pets. After creating it, explain how I can adopt it.`.trim();
		saveDraft(targetWorkspace, { ...previousDraft, input: prompt });
		navigate("/");
	};

	const floatItem = menu.items.find((i) => i.uiCommand === "toggle_pet_window");
	const actionItems = menu.items.filter(
		(i) => i.id !== "adopt" && (i.command || (i.uiCommand && i !== floatItem)),
	);

	return (
		<div className="pet-settings-page">
			<style>{`
				.pet-stage { background-image: radial-gradient(ellipse at 50% 18%, rgba(81, 169, 141, .13), transparent 48%), linear-gradient(145deg, rgba(255,255,255,.025), transparent 65%); }
				.pet-stage::before { content: ""; position: absolute; width: 230px; height: 130px; left: calc(50% - 115px); top: 24px; border-radius: 50%; background: radial-gradient(ellipse, rgba(88, 190, 154, .13), transparent 70%); filter: blur(18px); animation: petAura 5s ease-in-out infinite alternate; pointer-events: none; }
				.pet-stage-critter { position: relative; z-index: 1; animation: petHover 3.2s ease-in-out infinite; }
				.pet-species-card { transition: transform 220ms cubic-bezier(.2,.8,.2,1), border-color 220ms, box-shadow 220ms; }
				.pet-species-card:hover { transform: translateY(-3px); box-shadow: 0 10px 26px rgba(50, 90, 75, .10); }
				.pet-species-card:active { transform: translateY(-1px) scale(.99); }
				.pet-customize-preview { animation: petHover 2.4s ease-in-out infinite; }
				@keyframes petHover { 0%,100% { transform: translateY(0) rotate(-1deg); } 50% { transform: translateY(-5px) rotate(1deg); } }
				@keyframes petAura { from { opacity: .45; transform: scale(.88); } to { opacity: 1; transform: scale(1.12); } }
				@media (prefers-reduced-motion: reduce) { .pet-stage::before, .pet-stage-critter, .pet-customize-preview { animation: none !important; } .pet-critter, .pet-critter * { animation: none !important; } .pet-species-card { transition: none; } }
			`}</style>
			{/* Header mirrors Codex Mini & Pets: subtitle + Show mini toggle */}
			<div className="mb-6 flex items-start justify-between gap-4">
				<p className="text-sm text-muted">{menu.description ?? t("settings.pet.subtitle")}</p>
				{isTauri() && hasPet && floatItem && (
					<button
						type="button"
						onClick={() => runItem(floatItem)}
						className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
					>
						{miniOpen ? t("settings.pet.hideMini") : t("settings.pet.showMini")}
					</button>
				)}
			</div>

			{/* Preview card — the companion, its name/level/mood and the chat pill */}
			<div className="pet-stage relative mb-8 flex min-h-[260px] flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-border bg-surface px-6 py-8">
				{hasPet ? (
					<>
						<div className="pet-stage-critter">
							{activeSpecies
								? <SpeciesArt species={activeSpecies} mood={mood} busy={busy} scale={displayScale * 1.35} />
								: <PetSprite species={displaySpeciesId} mood={mood} look={{ x: 0, y: 0 }} busy={busy} scale={displayScale * 1.35} />}
						</div>
						<div style={petChipStyle}>
							{displayName} · Lv.{displayLevel} · {mood}
						</div>
						{displaySubtitle && <p className="max-w-sm text-center text-xs text-muted">{displaySubtitle}</p>}
						<PetChatPill
							input={input}
							setInput={setInput}
							onSend={sendPrompt}
							onTranscribe={isTauri() ? transcribe : undefined}
							voice={isTauri()}
							autoFocus={false}
							sending={sending}
							error={chatError}
							sent={chatSent}
						/>
						{actionItems.length > 0 && (
							<div className="mt-1 flex flex-wrap items-center justify-center gap-2">
								{actionItems.map((item) => (
									<button
										key={item.id}
										type="button"
										onClick={() => runItem(item)}
										title={item.description}
										className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
									>
										{item.label}
										{item.value ? ` · ${item.value}` : ""}
									</button>
								))}
							</div>
						)}
						<button
							type="button"
							onClick={() => {
								setCustomScale(displayScale);
								setCustomSubtitle(displaySubtitle);
								setCustomizeOpen(true);
							}}
							className="absolute bottom-4 right-4 flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-3 py-1.5 text-[13px] font-medium text-fg shadow-sm transition hover:-translate-y-0.5 hover:bg-surface-2 active:translate-y-0"
						>
							<PenLine className="h-3.5 w-3.5" />
							{t("settings.pet.customize")}
						</button>
					</>
				) : (
					<div className="flex flex-col items-center gap-3 py-6">
						<div className="pet-stage-critter">
							<PetSprite species="slime" mood="idle" look={{ x: 0, y: 0 }} noPet scale={1.25} />
						</div>
						<p className="text-sm text-muted">{t("settings.pet.noPet")}</p>
						<button
							type="button"
							onClick={openPicker}
							className="rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-surface"
						>
							{t("settings.pet.adoptCta")}
						</button>
					</div>
				)}
			</div>

			{/* My pets — species grid; click a card to adopt/switch */}
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-[15px] font-semibold tracking-tight text-fg">{t("settings.pet.myPets")}</h2>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onAction}
						title={t("settings.pet.refresh")}
						className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
					>
						<RefreshCw className="h-4 w-4" />
					</button>
					<button
						type="button"
						onClick={createCustomPet}
						className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[13px] font-medium text-fg transition-colors hover:-translate-y-0.5 hover:bg-surface-2 active:translate-y-0"
					>
						<Plus className="h-3.5 w-3.5" />
						{t("settings.pet.createPet")}
					</button>
				</div>
			</div>

			<div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
				{hasPet && (
					<button
						type="button"
						onClick={() => steer("/pet release", onAction)}
						className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-4 py-6 text-center transition-colors hover:bg-surface-2/60"
					>
						<span className="text-lg text-muted">×</span>
						<span className="text-[13px] font-medium text-fg">{t("settings.pet.none")}</span>
						<span className="text-xs text-muted">{t("settings.pet.noneDescription")}</span>
					</button>
				)}
				{species.map((s) => {
					const active = displaySpeciesId === s.id && hasPet;
					return (
						<button
							key={s.id}
							type="button"
							onClick={() => !active && adopt(s.id)}
							className={cn(
								"pet-species-card flex flex-col items-center justify-center gap-2 rounded-2xl border bg-surface px-4 py-6 text-center",
								active ? "border-accent ring-1 ring-accent/40" : "border-border hover:bg-surface-2/60",
							)}
						>
							<div className="flex h-[110px] items-center justify-center">
								<SpeciesArt species={s} mood={active ? mood : "idle"} scale={active ? displayScale : 1} busy={active && busy} />
							</div>
							<span className="text-[13px] font-medium text-fg">
								{active ? displayName : s.name}
							</span>
							{s.description && <span className="text-xs text-muted">{s.description}</span>}
							{active && (
								<span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
									{t("settings.pet.current")}
								</span>
							)}
						</button>
					);
				})}
			</div>

			{customizeOpen && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm"
					role="presentation"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) setCustomizeOpen(false);
					}}
				>
					<section
						role="dialog"
						aria-modal="true"
						aria-labelledby="pet-customize-title"
						className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl"
					>
						<div className="mb-5 flex items-center justify-between">
							<div>
								<h2 id="pet-customize-title" className="text-base font-semibold text-fg">{t("settings.pet.customize")}</h2>
								<p className="mt-1 text-xs text-muted">{t("settings.pet.customizeHint")}</p>
							</div>
							<div className="pet-customize-preview">
								<PetSprite species={displaySpeciesId} mood={mood} look={{ x: 0, y: 0 }} scale={customScale * 0.65} />
							</div>
						</div>
						<label className="mb-2 flex items-center justify-between text-[13px] font-medium text-fg" htmlFor="pet-scale">
							<span>{t("settings.pet.size")}</span>
							<span className="text-muted">{Math.round(customScale * 100)}%</span>
						</label>
						<input
							id="pet-scale"
							type="range"
							min="0.7"
							max="1.5"
							step="0.05"
							value={customScale}
							onChange={(event) => setCustomScale(Number(event.target.value))}
							className="mb-5 w-full accent-accent"
						/>
						<label className="mb-2 block text-[13px] font-medium text-fg" htmlFor="pet-subtitle">
							{t("settings.pet.subtitleLabel")}
						</label>
						<input
							id="pet-subtitle"
							value={customSubtitle}
							maxLength={80}
							onChange={(event) => setCustomSubtitle(event.target.value)}
							placeholder={t("settings.pet.subtitlePlaceholder")}
							className="mb-1 h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
						/>
						<p className="text-right text-[11px] text-muted">{customSubtitle.length}/80</p>
						<div className="mt-5 flex justify-end gap-2">
							<button type="button" onClick={() => setCustomizeOpen(false)} className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
								{t("settings.pet.cancel")}
							</button>
							<button type="button" onClick={saveCustomize} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-95 active:scale-[0.98]">
								{t("settings.pet.save")}
							</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}
