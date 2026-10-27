/** Pure pet-frame logic (no React), shared by the client hook and tests. */
import type { RpcPetMood as PetMood, RpcPetSnapshot as PetSnapshot, RpcPetStatus } from "@tomsun28/pizza-protocol";

export type { PetMood, PetSnapshot };
export type PetStatus = RpcPetStatus;

/** Mirrors core/pet/state.ts levelForXp. */
export const levelForXp = (xp: number) => Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 10)) + 1);

export interface Frame { snapshot: PetSnapshot; at: number }

/** A busy flag nobody refreshed for this long is treated as stale (sidecar gone). */
const BUSY_STALE_MS = 5 * 60_000;

/**
 * Several local sidecars (one per workspace) report the same pet. Identity
 * comes from the newest frame; the pet works while any of them is busy.
 */
export function mergePetFrames(frames: ReadonlyMap<string, Frame>, now = Date.now()): PetSnapshot | undefined {
	let newest: Frame | undefined;
	for (const frame of frames.values()) {
		const revision = frame.snapshot.revision ?? 0;
		const previous = newest?.snapshot.revision ?? 0;
		if (!newest || revision > previous || (revision === previous && frame.at >= newest.at)) newest = frame;
	}
	const pet = newest?.snapshot.pet;
	if (!newest || !pet) return newest?.snapshot;
	const busy = [...frames.values()].some((f) => f.snapshot.pet?.busy && now - f.at < BUSY_STALE_MS);
	const mood: PetMood = busy ? "working" : pet.mood === "working" ? "idle" : pet.mood;
	return { ...newest.snapshot, pet: { ...pet, busy, mood } };
}
