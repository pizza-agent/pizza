/**
 * Pet — the app's companion, built into the core (not a plugin).
 *
 * One process-wide service owns the shared save (<agentDir>/pet.json), the
 * mood/XP state machine and the species catalog. Sessions feed it agent
 * activity (session.ts), RPC serves it to the desktop app (`pet_get`,
 * `pet_action`, `pet_state` frames), and plugins extend it through
 * `pizza.pet` — extra species, menu actions and reactions.
 */

import { applyEvent, applyReaction, effectiveMood, initialPetState, levelForXp, type PetEventKind, type PetState } from "./state.js";
import { BUILTIN_SPECIES, DEFAULT_PET_SPECIES, LEGACY_PET_SPECIES, isValidSpecies, PET_MOODS, type PetMood, type PetSpeciesDef } from "./sprites.js";
import { deletePetSave, listUserSpecies, loadPetRecord, migratePetSpecies, savePet, savePetProgress, savePetProgressAsync, type PetSave } from "./store.js";

export type PetSpeciesSource = "builtin" | "plugin" | "user";

export interface PetSpeciesInfo extends PetSpeciesDef {
	source: PetSpeciesSource;
}

/** A plugin-contributed entry for the pet's right-click menu and settings page. */
export interface PetActionDef {
	/** Unique id; the first registration wins. */
	id: string;
	label: string;
	description?: string;
	/** Slash command (or prompt) steered into the session when picked. */
	command: string;
}

export interface PetStatus {
	speciesId: string;
	xp: number;
	level: number;
	mood: PetMood;
	busy: boolean;
	scale: number;
	adoptedAt: number;
	/** Owned by the desktop app: the floating window was open last run. */
	floating: boolean | null;
}

/** Live state pushed to UIs. `species` carries frames for custom (non-builtin) art. */
export interface PetSnapshot {
	/** Shared-save revision orders identity changes across workspace processes. */
	revision?: number;
	pet: PetStatus | null;
	species: PetSpeciesInfo | null;
}

export interface PetCatalog extends PetSnapshot {
	catalog: PetSpeciesInfo[];
	actions: PetActionDef[];
}

export type PetOperation =
	| { action: "adopt"; speciesId: string }
	| { action: "customize"; scale?: number }
	| { action: "release" }
	| { action: "feed" }
	| { action: "play" };

/** Where plugin contributions come from — one per session's extension runner. */
export interface PetContributionSource {
	species(): PetSpeciesDef[];
	actions(): PetActionDef[];
}

export type PetListener = (snapshot: PetSnapshot) => void;

const TICK_MS = 2000;
export const PET_SCALE_RANGE = [0.7, 1.5] as const;

export class PetService {
	private state: PetState = initialPetState();
	private save: PetSave | undefined;
	private revision = 0;
	private readonly busy = new Set<symbol>();
	private readonly listeners = new Set<PetListener>();
	private readonly sources = new Set<PetContributionSource>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastEmitted = "";
	/** Queued background XP writes, in order; never block session events on the save lock. */
	private progress: Promise<void> = Promise.resolve();
	/** XP granted here that may not have reached the shared save yet. */
	private pendingXp: number | undefined;

	// ── contributions ────────────────────────────────────────────────────

	addContributionSource(source: PetContributionSource): () => void {
		this.sources.add(source);
		return () => this.sources.delete(source);
	}

	/** Built-ins, then plugin species, then user packs (later ids override). */
	listSpecies(): PetSpeciesInfo[] {
		const byId = new Map<string, PetSpeciesInfo>();
		for (const s of BUILTIN_SPECIES) byId.set(s.id, { ...s, source: "builtin" });
		for (const source of this.sources) {
			for (const s of safe(() => source.species(), [])) if (isValidSpecies(s)) byId.set(s.id, { ...s, source: "plugin" });
		}
		for (const s of listUserSpecies()) byId.set(s.id, { ...s, source: "user" });
		return [...byId.values()];
	}

	findSpecies(id: string): PetSpeciesInfo | undefined {
		return this.listSpecies().find((s) => s.id === id);
	}

	listActions(): PetActionDef[] {
		const byId = new Map<string, PetActionDef>();
		for (const source of this.sources) {
			for (const a of safe(() => source.actions(), [])) {
				if (a?.id && a.label && a.command && !byId.has(a.id)) byId.set(a.id, { id: a.id, label: a.label, description: a.description, command: a.command });
			}
		}
		return [...byId.values()];
	}

	// ── state ────────────────────────────────────────────────────────────

	/** The shared save owns identity and XP; this process owns transient mood. */
	private sync(): PetSave | undefined {
		const record = loadPetRecord();
		this.save = record.save;
		this.revision = record.revision;
		if (this.save && LEGACY_PET_SPECIES.has(this.save.speciesId) && !this.findSpecies(this.save.speciesId)) {
			migratePetSpecies(this.save.speciesId, DEFAULT_PET_SPECIES);
			const migrated = loadPetRecord();
			this.save = migrated.save;
			this.revision = migrated.revision;
		}
		if (this.save) {
			this.state.xp = Math.max(this.save.xp, this.pendingXp ?? 0);
			this.state.level = levelForXp(this.save.xp);
		}
		return this.save;
	}

	status(): PetStatus | null {
		const save = this.sync();
		if (!save) return null;
		return {
			speciesId: save.speciesId,
			xp: this.state.xp,
			level: this.state.level,
			mood: effectiveMood(this.state, { agentBusy: this.busy.size > 0 }),
			busy: this.busy.size > 0,
			scale: typeof save.scale === "number" ? clamp(save.scale, ...PET_SCALE_RANGE) : 1,
			adoptedAt: save.adoptedAt,
			floating: typeof save.floating === "boolean" ? save.floating : null,
		};
	}

	snapshot(): PetSnapshot {
		const pet = this.status();
		const species = pet ? this.findSpecies(pet.speciesId) : undefined;
		return { pet, revision: this.revision, species: species && species.source !== "builtin" ? species : null };
	}

	catalog(): PetCatalog {
		return { ...this.snapshot(), catalog: this.listSpecies(), actions: this.listActions() };
	}

	// ── live updates ─────────────────────────────────────────────────────

	subscribe(listener: PetListener): () => void {
		this.listeners.add(listener);
		if (!this.timer) {
			// Picks up time-based moods (reaction expiry, sleepy) and changes
			// made by other processes sharing the save.
			this.timer = setInterval(() => this.notify(), TICK_MS);
			this.timer.unref?.();
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0 && this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
		};
	}

	/** Push the snapshot to listeners when it changed (or always, when forced). */
	notify(force = false): PetSnapshot {
		const snapshot = this.snapshot();
		const key = JSON.stringify(snapshot);
		if (!force && key === this.lastEmitted) return snapshot;
		this.lastEmitted = key;
		for (const listener of this.listeners) safe(() => listener(snapshot), undefined);
		return snapshot;
	}

	// ── activity ─────────────────────────────────────────────────────────

	setBusy(session: symbol, busy: boolean): void {
		if (busy) this.busy.add(session);
		else this.busy.delete(session);
		this.notify();
	}

	dispatch(kind: PetEventKind): void {
		if (!this.sync()) return;
		this.state = applyEvent(this.state, kind);
		this.persistProgress();
	}

	/** Extension point: show a mood for a while and optionally grant XP. */
	react(mood: PetMood, options: { xp?: number } = {}): void {
		if (!PET_MOODS.includes(mood) || !this.sync()) return;
		this.state = applyReaction(this.state, mood, options.xp);
		this.persistProgress();
	}

	private persistProgress(): void {
		const xp = this.state.xp;
		this.pendingXp = Math.max(this.pendingXp ?? 0, xp);
		this.notify();
		const write: Promise<void> = this.progress
			.then(() => savePetProgressAsync(xp))
			.then(() => {}, () => {})
			.finally(() => { if (this.progress === write) this.pendingXp = undefined; });
		this.progress = write;
	}

	/** Resolves once queued background XP writes have reached the save. */
	flush(): Promise<void> {
		return this.progress;
	}

	// ── user operations ──────────────────────────────────────────────────

	perform(op: PetOperation): PetCatalog {
		const current = this.sync();
		if (op.action !== "adopt" && !current) throw new Error("No pet adopted yet.");
		switch (op.action) {
			case "adopt": {
				const species = this.findSpecies(op.speciesId);
				if (!species) throw new Error(`Unknown pet species "${op.speciesId}".`);
				// The pet shows the main agent's name; `name` stays in the save only
				// for older app versions that require it.
				savePet({ ...current, name: current?.name ?? species.name, speciesId: species.id, xp: current?.xp ?? 0, adoptedAt: current?.adoptedAt ?? Date.now() });
				this.state = applyEvent(this.state, "adopt");
				break;
			}
			case "customize": {
				const next: PetSave = { ...current! };
				if (typeof op.scale === "number" && Number.isFinite(op.scale)) next.scale = clamp(op.scale, ...PET_SCALE_RANGE);
				savePet(next);
				break;
			}
			case "release":
				deletePetSave();
				this.pendingXp = undefined;
				this.state = initialPetState();
				break;
			case "feed":
			case "play":
				this.state = applyEvent(this.state, op.action);
				savePetProgress(this.state.xp);
				break;
			default:
				throw new Error(`Unknown pet action "${(op as { action: string }).action}".`);
		}
		this.notify(true);
		return this.catalog();
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

/** The app's single pet. */
export const petService = new PetService();
