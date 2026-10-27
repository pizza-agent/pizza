/**
 * Pet persistence.
 *
 * Save file:  <agentDir>/pet.json           (which pet you have + progress)
 * User packs: <agentDir>/pets/<id>.json     (custom species, PetSpeciesDef shape)
 *
 * agentDir is normally ~/.pizza/agent (PIZZA_CODING_AGENT_DIR overridable).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fstatSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import { isValidSpecies, type PetSpeciesDef } from "./sprites.js";

export interface PetSave {
	/** Legacy display name, kept for older app versions; the UI uses the agent name. */
	name?: string;
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

type PetRecord = { save?: PetSave; revision: number };
let cachedRecord: { key: string; record: PetRecord } | undefined;

/**
 * Read data and revision from the same inode, even if another process
 * replaces it. Every process polls this, so an unchanged file (same inode,
 * size and mtime — atomic writes always swap the inode) is not re-parsed.
 */
export function loadPetRecord(): PetRecord {
	let fd: number | undefined;
	try {
		fd = openSync(petSavePath(), "r");
		const stat = fstatSync(fd);
		const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
		if (cachedRecord?.key === key) return cloneRecord(cachedRecord.record);
		const data = JSON.parse(readFileSync(fd, "utf-8")) as Partial<PetSave> | null;
		const revision = stat.mtimeMs;
		const record: PetRecord = !data || typeof data.speciesId !== "string" ? { revision } : { revision, save: { ...data, speciesId: data.speciesId,
			xp: typeof data.xp === "number" ? data.xp : 0,
			adoptedAt: typeof data.adoptedAt === "number" ? data.adoptedAt : Date.now() } };
		cachedRecord = { key, record };
		return cloneRecord(record);
	} catch { return { revision: 0 }; }
	finally { if (fd !== undefined) closeSync(fd); }
}

function cloneRecord(record: PetRecord): PetRecord {
	return record.save ? { revision: record.revision, save: { ...record.save } } : { revision: record.revision };
}

export function loadPetSave(): PetSave | undefined { return loadPetRecord().save; }

function writePetSave(path: string, update: (current: PetSave | undefined) => PetSave | undefined): PetSave | undefined {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const next = update(loadPetSave());
		writeFileSync(temp, JSON.stringify(next ?? null, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(temp, path);
		return next;
	} finally { rmSync(temp, { force: true }); }
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
	try { return writePetSave(path, update); }
	finally { release(); }
}

/** Same as updatePetSave, but waits for the lock without blocking the event loop. */
async function updatePetSaveAsync(update: (current: PetSave | undefined) => PetSave | undefined): Promise<PetSave | undefined> {
	await mkdir(getAgentDir(), { recursive: true });
	const path = petSavePath();
	const release = await lockfile.lock(path, { realpath: false, retries: { retries: 20, minTimeout: 10, maxTimeout: 100 } });
	try { return writePetSave(path, update); }
	finally { await release(); }
}

/** Explicit user changes may update appearance. The desktop owns floating. */
export function savePet(save: PetSave): void {
	updatePetSave((current) => {
		const { floating: _floating, ...rest } = save;
		return { ...current, ...rest };
	});
}

/** Background XP updates must never restore an old appearance or released pet. */
const progress = (xp: number) => (current: PetSave | undefined) => current ? { ...current, xp: Math.max(current.xp, xp) } : undefined;
export function savePetProgress(xp: number): PetSave | undefined {
	return updatePetSave(progress(xp));
}
/** Agent-activity XP: written off the event loop's critical path. */
export function savePetProgressAsync(xp: number): Promise<PetSave | undefined> {
	return updatePetSaveAsync(progress(xp));
}

/** Change only a still-selected legacy builtin, preserving all user progress. */
export function migratePetSpecies(expectedId: string, speciesId: string): PetSave | undefined {
	return updatePetSave(current => current?.speciesId === expectedId ? { ...current, speciesId } : current);
}

export function deletePetSave(): void {
	updatePetSave(() => undefined);
}

// ---------------------------------------------------------------------------
// Species lookup (built-ins + user packs)
// ---------------------------------------------------------------------------

let cachedPacks: { key: string; species: PetSpeciesDef[] } | undefined;

/**
 * Load user-defined species from <agentDir>/pets/*.json. Invalid files are
 * skipped. Polled by every process, so files are only re-read when the
 * directory listing or a file's size/mtime changes.
 */
export function listUserSpecies(): PetSpeciesDef[] {
	const dir = userPacksDir();
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
	const key = files.map((file) => {
		try { const stat = statSync(join(dir, file)); return `${file}:${stat.size}:${stat.mtimeMs}`; }
		catch { return `${file}:missing`; }
	}).join("|");
	if (cachedPacks?.key === key) return [...cachedPacks.species];
	const species: PetSpeciesDef[] = [];
	for (const file of files) {
		try {
			const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
			if (isValidSpecies(data)) species.push({ ...data, id: data.id || file.replace(/\.json$/, "") });
		} catch {
			/* skip broken packs */
		}
	}
	cachedPacks = { key, species };
	return [...species];
}
