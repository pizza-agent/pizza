/**
 * Pet persistence.
 *
 * Save file:  <agentDir>/pet.json           (which pet you have + progress)
 * User packs: <agentDir>/pets/<id>.json     (custom species, PetSpeciesDef shape)
 *
 * agentDir is normally ~/.pizza/agent (PIZZA_CODING_AGENT_DIR overridable).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import lockfile from "proper-lockfile";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import { BUILTIN_SPECIES, isValidSpecies, type PetSpeciesDef } from "./sprites.js";

export interface PetSave {
	name: string;
	speciesId: string;
	xp: number;
	adoptedAt: number;
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
		};
	} catch {
		return undefined;
	}
}

/** Serialize read/modify/write across workspace processes; readers see whole saves. */
function updatePetSave(update: (current: PetSave | undefined) => PetSave | undefined): PetSave | undefined {
	mkdirSync(getAgentDir(), { recursive: true });
	const path = petSavePath();
	let release: (() => void) | undefined;
	for (let attempt = 0; !release; attempt++) {
		try { release = lockfile.lockSync(path, { realpath: false }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt >= 9) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const next = update(loadPetSave());
		writeFileSync(temp, JSON.stringify(next ?? null, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(temp, path);
		return next;
	} finally { rmSync(temp, { force: true }); release(); }
}

/** Explicit user changes may update appearance. The desktop owns floating. */
export function savePet(save: PetSave): void {
	updatePetSave((current) => {
		const { floating: _floating, ...rest } = save;
		return { ...current, ...rest };
	});
}

/** Background XP updates must never restore an old appearance or released pet. */
export function savePetProgress(xp: number): PetSave | undefined {
	return updatePetSave((current) => current ? { ...current, xp: Math.max(current.xp, xp) } : undefined);
}

export function deletePetSave(): void {
	updatePetSave(() => undefined);
}

// ---------------------------------------------------------------------------
// Species lookup (built-ins + user packs)
// ---------------------------------------------------------------------------

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