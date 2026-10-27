/**
 * PetSettingsPage — the pet's first-class settings page (Settings › Pet).
 * The pet is a core app feature; this page reads and changes it through the
 * pet RPC (`pet_get` / `pet_action`) and lists plugin-contributed species and
 * actions next to the built-ins.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Cookie, PenLine, Plus, Puzzle, RefreshCw, Sparkles } from "lucide-react";
import { PetChatPill, petChipStyle } from "./pet-shared";
import { PetFigure } from "./PetFigure";
import { sendCommandAwait } from "@/lib/transport";
import { confirmDialog } from "@/lib/confirm";
import { invokePetWindow, PET_SCALE_MAX, PET_SCALE_MIN, runPetPluginAction, usePet, type PetOperation, type PetSpecies } from "@/lib/pet";
import { cn, isTauri, MAIN_CHAT_CWD } from "@/lib/utils";
import { loadDraft, saveDraft } from "@/lib/composer-drafts";

function transcribe(audioB64: string, mimeType: string): Promise<string> {
	return import("@tauri-apps/api/core").then(({ invoke }) =>
		invoke<string>("transcribe_audio", { audioB64, mimeType }),
	);
}

const chip = "rounded-lg border border-border px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50";

export function PetSettingsPage({ workspace }: { workspace?: string }) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const { pet, species: customArt, loaded, floating, catalog, actions, error: loadError, refresh, act } = usePet();
	const [actionError, setActionError] = useState("");
	const [pending, setPending] = useState(false);

	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [chatError, setChatError] = useState("");
	const [chatSent, setChatSent] = useState(false);
	const [customizeOpen, setCustomizeOpen] = useState(false);
	const [customScale, setCustomScale] = useState(1);

	const run = useCallback(async (op: PetOperation) => {
		setPending(true);
		setActionError("");
		try { await act(op); }
		catch (e) { setActionError(t("settings.pet.actionError", { error: e instanceof Error ? e.message : String(e) })); }
		finally { setPending(false); }
	}, [act, t]);

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

	const release = async () => {
		if (!pet) return;
		const ok = await confirmDialog({ message: t("settings.pet.releaseConfirm", { name: catalog.find((s) => s.id === pet.speciesId)?.name ?? pet.speciesId }), confirmLabel: t("settings.pet.release"), danger: true });
		if (ok) void run({ action: "release" });
	};
	const openCustomize = () => {
		if (!pet) return;
		setCustomScale(pet.scale);
		setCustomizeOpen(true);
	};
	const saveCustomize = async () => {
		if (!pet) return;
		setCustomizeOpen(false);
		await run({ action: "customize", scale: customScale });
	};
	const createCustomPet = () => {
		const targetWorkspace = workspace || MAIN_CHAT_CWD;
		const previousDraft = loadDraft(targetWorkspace);
		const prompt = `/skill:create-pet\n\n${previousDraft.input.trim()}\n\nHelp me create a custom Pizza pet. Ask me for its concept and visual style, then create a valid species JSON in ~/.pizza/agent/pets/. Do not overwrite existing pets. After creating it, explain how I can adopt it.`.trim();
		saveDraft(targetWorkspace, { ...previousDraft, input: prompt });
		navigate("/");
	};

	const mood = pet?.mood ?? "idle";
	const art = (s: PetSpecies) => (s.source === "builtin" ? undefined : s.frames);
	const error = actionError || (loaded ? "" : loadError);

	return (
		<div className="pet-settings-page">
			<style>{`
				.pet-stage { background-image: radial-gradient(ellipse at 50% 30%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 55%); }
				.pet-species-card { transition: transform 220ms cubic-bezier(.2,.8,.2,1), border-color 220ms, box-shadow 220ms; }
				.pet-species-card:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(40, 50, 70, .08); }
				.pet-species-card:active { transform: translateY(0) scale(.99); }
				@media (prefers-reduced-motion: reduce) { .pet-species-card { transition: none; } .pet-species-card:hover { transform: none; } }
			`}</style>
			<div className="mb-6 flex items-start justify-between gap-4">
				<p className="text-sm text-muted">{t("settings.pet.subtitle")}</p>
				{isTauri() && pet && (
					<button
						type="button"
						onClick={() => { void invokePetWindow("toggle_pet_window").catch((e) => setActionError(String(e))); }}
						className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
					>
						{floating ? t("settings.pet.hideMini") : t("settings.pet.showMini")}
					</button>
				)}
			</div>

			{error && <p role="alert" className="mb-4 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>}

			<div className="pet-stage relative mb-8 flex min-h-[280px] flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-border bg-surface px-6 py-8">
				{pet ? (
					<>
						<PetFigure species={pet.speciesId} mood={mood} busy={pet.busy} scale={pet.scale} size={128} frames={customArt?.frames} />
						<div style={petChipStyle}>
							{t("settings.pet.level", { level: pet.level })} · {t(`pet.moods.${mood}`)}
						</div>
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
						<div className="mt-1 flex flex-wrap items-center justify-center gap-2">
							<button type="button" disabled={pending} onClick={() => void run({ action: "feed" })} className={cn(chip, "flex items-center gap-1")}><Cookie className="h-3 w-3" />{t("pet.menu.feed")}</button>
							<button type="button" disabled={pending} onClick={() => void run({ action: "play" })} className={cn(chip, "flex items-center gap-1")}><Sparkles className="h-3 w-3" />{t("pet.menu.play")}</button>
							{actions.map((action) => (
								<button key={action.id} type="button" title={action.description} onClick={() => { void runPetPluginAction(action).catch((e) => setActionError(String(e))); }} className={cn(chip, "flex items-center gap-1")}>
									<Puzzle className="h-3 w-3" />{action.label}
								</button>
							))}
						</div>
						<button
							type="button"
							onClick={openCustomize}
							className="absolute bottom-4 right-4 flex items-center gap-1.5 rounded-lg border border-border bg-surface/80 px-3 py-1.5 text-[13px] font-medium text-fg shadow-sm transition hover:-translate-y-0.5 hover:bg-surface-2 active:translate-y-0"
						>
							<PenLine className="h-3.5 w-3.5" />
							{t("settings.pet.customize")}
						</button>
					</>
				) : (
					<div className="flex flex-col items-center gap-3 py-6">
						<div className="opacity-50 grayscale"><PetFigure species="pip" size={110} /></div>
						<p className="text-sm text-muted">{t("settings.pet.noPet")}</p>
					</div>
				)}
			</div>

			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-[15px] font-semibold tracking-tight text-fg">{t("settings.pet.myPets")}</h2>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => { void refresh(); }}
						title={t("settings.pet.refresh")}
						aria-label={t("settings.pet.refresh")}
						className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg"
					>
						<RefreshCw className="h-4 w-4" />
					</button>
					<button
						type="button"
						onClick={createCustomPet}
						className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2"
					>
						<Plus className="h-3.5 w-3.5" />
						{t("settings.pet.createPet")}
					</button>
				</div>
			</div>

			<div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
				{pet && (
					<button
						type="button"
						disabled={pending}
						onClick={() => void release()}
						className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-4 py-6 text-center transition-colors hover:bg-surface-2/60"
					>
						<span className="text-lg text-muted">×</span>
						<span className="text-[13px] font-medium text-fg">{t("settings.pet.none")}</span>
						<span className="text-xs text-muted">{t("settings.pet.noneDescription")}</span>
					</button>
				)}
				{catalog.map((s) => {
					const active = pet?.speciesId === s.id;
					return (
						<button
							key={s.id}
							type="button"
							disabled={pending}
							aria-pressed={active}
							onClick={() => { if (!active) void run({ action: "adopt", speciesId: s.id }); }}
							className={cn(
								"pet-species-card relative flex flex-col items-center justify-center gap-2 rounded-2xl border bg-surface px-4 py-6 text-center",
								active ? "border-accent ring-1 ring-accent/40" : "border-border hover:bg-surface-2/60",
							)}
						>
							{s.source !== "builtin" && (
								<span className="absolute left-3 top-3 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
									{t(s.source === "plugin" ? "settings.pet.sourcePlugin" : "settings.pet.sourceUser")}
								</span>
							)}
							<div className="flex h-[96px] items-center justify-center">
								<PetFigure species={s.id} mood={active ? mood : "idle"} scale={active ? pet!.scale : 1} busy={active && pet!.busy} size={88} frames={art(s)} />
							</div>
							<span className="text-[13px] font-medium text-fg">{s.name}</span>
							{active && (
								<span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
									{t("settings.pet.current")}
								</span>
							)}
						</button>
					);
				})}
			</div>

			{customizeOpen && pet && (
				<div
					className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm"
					role="presentation"
					onMouseDown={(event) => { if (event.target === event.currentTarget) setCustomizeOpen(false); }}
					onKeyDown={(event) => { if (event.key === "Escape") setCustomizeOpen(false); }}
				>
					<section role="dialog" aria-modal="true" aria-labelledby="pet-customize-title" className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl">
						<div className="mb-5 flex items-center justify-between">
							<div>
								<h2 id="pet-customize-title" className="text-base font-semibold text-fg">{t("settings.pet.customize")}</h2>
								<p className="mt-1 text-xs text-muted">{t("settings.pet.customizeHint")}</p>
							</div>
							<PetFigure species={pet.speciesId} mood={mood} scale={customScale} size={64} frames={customArt?.frames} />
						</div>
						<label className="mb-2 flex items-center justify-between text-[13px] font-medium text-fg" htmlFor="pet-scale">
							<span>{t("settings.pet.size")}</span>
							<span className="text-muted">{Math.round(customScale * 100)}%</span>
						</label>
						<input
							id="pet-scale"
							autoFocus
							type="range"
							min={PET_SCALE_MIN}
							max={PET_SCALE_MAX}
							step="0.05"
							value={customScale}
							onChange={(event) => setCustomScale(Number(event.target.value))}
							className="mb-5 w-full accent-accent"
						/>
						<div className="mt-5 flex justify-end gap-2">
							<button type="button" onClick={() => setCustomizeOpen(false)} className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:bg-surface-2 hover:text-fg">
								{t("settings.pet.cancel")}
							</button>
							<button type="button" onClick={() => void saveCustomize()} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-95 active:scale-[0.98]">
								{t("settings.pet.save")}
							</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}
