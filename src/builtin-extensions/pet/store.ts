/**
 * Pet persistence.
 *
 * Save file:  <agentDir>/pet.json           (which pet you have + progress)
 * User packs: <agentDir>/pets/<id>.json     (custom species, PetSpeciesDef shape)
 *
 * agentDir is normally ~/.pizza/agent (PIZZA_CODING_AGENT_DIR overridable).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import { BUILTIN_SPECIES, PET_MOODS, type PetMood, type PetSpeciesDef } from "./sprites.js";

export interface PetSave {
	name: string;
	speciesId: string;
	xp: number;
	adoptedAt: number;
	/** Whether the widget is shown below the editor (default true). */
	visible?: boolean;
	/** Written by the desktop app: floating window open across restarts. */
	floating?: boolean;
	[key: string]: unknown;
}

const PET_SAVE_FILE = "pet.json";
const USER_PACKS_DIR = "pets";

function petSavePath(): string {
	return join(getAgentDir(), PET_SAVE_FILE);
}

function userPacksDir(): string {
	return join(getAgentDir(), USER_PACKS_DIR);
}

// ---------------------------------------------------------------------------
// Save file
// ---------------------------------------------------------------------------

export function loadPetSave(): PetSave | undefined {
	try {
		const raw = readFileSync(petSavePath(), "utf-8");
		const data = JSON.parse(raw) as Partial<PetSave>;
		if (typeof data.name !== "string" || typeof data.speciesId !== "string") return undefined;
		return {
			...data,
			name: data.name,
			speciesId: data.speciesId,
			xp: typeof data.xp === "number" ? data.xp : 0,
			adoptedAt: typeof data.adoptedAt === "number" ? data.adoptedAt : Date.now(),
			visible: data.visible !== false,
		};
	} catch {
		return undefined;
	}
}

export function savePet(save: PetSave): void {
	mkdirSync(getAgentDir(), { recursive: true });
	// Merge over the on-disk file so fields written by other surfaces
	// (e.g. the desktop appʼs `floating` flag) are not clobbered.
	let onDisk: Record<string, unknown> = {};
	try {
		onDisk = JSON.parse(readFileSync(petSavePath(), "utf-8")) ?? {};
	} catch {
		/* first save */
	}
	// `floating` is owned by the desktop app (written on window open/close); the
	// extension's in-memory copy can be stale — strip it so we never clobber it.
	const { floating: _floating, ...rest } = save;
	writeFileSync(petSavePath(), JSON.stringify({ ...onDisk, ...rest }, null, 2), "utf-8");
}

export function deletePetSave(): void {
	try {
		if (existsSync(petSavePath())) writeFileSync(petSavePath(), "null", "utf-8");
	} catch {
		/* best effort */
	}
}

// ---------------------------------------------------------------------------
// Species lookup (built-ins + user packs)
// ---------------------------------------------------------------------------

function isValidSpecies(data: unknown): data is PetSpeciesDef {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || typeof d.name !== "string") return false;
	if (typeof d.frames !== "object" || d.frames === null) return false;
	for (const [mood, frames] of Object.entries(d.frames as Record<string, unknown>)) {
		if (!PET_MOODS.includes(mood as PetMood)) return false;
		if (!Array.isArray(frames) || frames.length === 0 || !frames.every((f) => typeof f === "string")) return false;
	}
	return true;
}

/** Load user-defined species from <agentDir>/pets/*.json. Invalid files are skipped. */
export function listUserSpecies(): PetSpeciesDef[] {
	const dir = userPacksDir();
	if (!existsSync(dir)) return [];
	const species: PetSpeciesDef[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
			if (isValidSpecies(data)) species.push({ ...data, id: data.id || file.replace(/\.json$/, "") });
		} catch {
			/* skip broken packs */
		}
	}
	return species;
}

/** All species: user packs override built-ins with the same id. */
export function listAllSpecies(): PetSpeciesDef[] {
	const byId = new Map<string, PetSpeciesDef>();
	for (const s of BUILTIN_SPECIES) byId.set(s.id, s);
	for (const s of listUserSpecies()) byId.set(s.id, s);
	return [...byId.values()];
}

export function findSpecies(id: string): PetSpeciesDef | undefined {
	return listAllSpecies().find((s) => s.id === id);
}