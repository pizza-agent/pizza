/**
 * Pet species + sprite definitions.
 *
 * A sprite is a set of animation frames per mood. Each frame is a single
 * multi-line string so species can also be authored as plain JSON in
 * ~/.pizza/agent/pets/<id>.json (see store.ts).
 */

export type PetMood = "idle" | "thinking" | "working" | "speaking" | "waiting" | "celebrating" | "happy" | "sad" | "sleepy" | "eating";

export type PetActivityMood = Extract<PetMood, "thinking" | "working" | "speaking" | "waiting">;

export const PET_MOODS: readonly PetMood[] = [
	"idle",
	"thinking",
	"working",
	"speaking",
	"waiting",
	"celebrating",
	"happy",
	"sad",
	"sleepy",
	"eating",
];

export interface PetSpeciesDef {
	/** Stable id (filename stem for user packs). */
	id: string;
	/** Display name. */
	name: string;
	/** Short description for the picker list. */
	description?: string;
	/** Frames per mood. Each entry is one animation frame (multi-line string). */
	frames: Partial<Record<PetMood, string[]>>;
}

/** Shape check for species authored outside the app (user packs, plugins). */
export function isValidSpecies(data: unknown): data is PetSpeciesDef {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id || typeof d.name !== "string") return false;
	if (typeof d.frames !== "object" || d.frames === null) return false;
	for (const [mood, frames] of Object.entries(d.frames as Record<string, unknown>)) {
		if (!PET_MOODS.includes(mood as PetMood)) return false;
		if (!Array.isArray(frames) || frames.length === 0 || !frames.every((f) => typeof f === "string")) return false;
	}
	return true;
}

/** Frames for a mood, falling back to idle, then to a placeholder. */
export function framesForMood(species: PetSpeciesDef, mood: PetMood): string[] {
	const frames = species.frames[mood] ?? species.frames.idle;
	return frames && frames.length > 0 ? frames : ["( ? )"];
}

// ---------------------------------------------------------------------------
// Built-in species
// ---------------------------------------------------------------------------

/** One code-rendered Pizza companion; retired builtins migrate without losing progress. */
export const DEFAULT_PET_SPECIES = "pip";
export const LEGACY_PET_SPECIES: ReadonlySet<string> = new Set(["cat", "dog", "slime", "pixel-mochi", "mozz", "pomo", "basi"]);

const pizzaFrames = (body: string): PetSpeciesDef["frames"] => ({
	idle: [body], working: [body + " ~"], happy: [body + " :)"],
	celebrating: [body + " *"], sad: [body + " ."], sleepy: [body + " z"], eating: [body + " o"],
});

export const BUILTIN_SPECIES: PetSpeciesDef[] = [
	{ id: "pip", name: "Pizza", description: "A curious little companion. Big eyes, a big smile, and a face for every agent state.", frames: pizzaFrames("( O O )") },
];
