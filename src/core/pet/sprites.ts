/**
 * Pet species + sprite definitions.
 *
 * A sprite is a set of animation frames per mood. Each frame is a single
 * multi-line string so species can also be authored as plain JSON in
 * ~/.pizza/agent/pets/<id>.json (see store.ts).
 */

export type PetMood = "idle" | "working" | "celebrating" | "happy" | "sad" | "sleepy" | "eating";

export const PET_MOODS: readonly PetMood[] = [
	"idle",
	"working",
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

const CAT: PetSpeciesDef = {
	id: "cat",
	name: "Cat",
	description: "A calm companion. Judges your diffs silently.",
	frames: {
		idle: [" /\\_/\\\n( o.o )\n > ^ <", " /\\_/\\\n( -.- )\n > ^ <"],
		working: [" /\\_/\\\n( o.o ) ~\n > ^ <", " /\\_/\\\n( o.o )\n > ^ <~"],
		celebrating: [" /\\_/\\\n( ^o^ )\n > ^ <", "\\ /\\_/\n( ^o^ )\n > ^ <"],
		happy: [" /\\_/\\\n( ^.^ )\n > ^ <"],
		sad: [" /\\_/\\\n( ;_; )\n > ^ <"],
		sleepy: [" /\\_/\\\n( -.- )z\n > ^ <", " /\\_/\\\n( -.- ) zZ\n > ^ <"],
		eating: [" /\\_/\\\n( omo )\n > = <"],
	},
};

const DOG: PetSpeciesDef = {
	id: "dog",
	name: "Dog",
	description: "Loyal. Gets excited every time a test passes.",
	frames: {
		idle: [" __\no o  __\n V  (_)\n ~~~~", " __\n- -  __\n V  (_)\n ~~~~"],
		working: [" __\no o  __!\n V  (_)\n ~~~~", " __\no o  __\n V  (_)!\n ~~~~"],
		celebrating: [" __\n^o^  __\n V  (_)\n ~~~~", "  __/\n^o^  _\n V  (_)\n ~~~~"],
		happy: [" __\n^.^  __\n V  (_)\n ~~~~"],
		sad: [" __\nu u  __\n V  (_)\n ~~~~"],
		sleepy: [" __\n- -  __z\n V  (_)\n ~~~~", " __\n- -  __ zZ\n V  (_)\n ~~~~"],
		eating: [" __\nomo  __\n V  (_)\n ~~~~"],
	},
};

const SLIME: PetSpeciesDef = {
	id: "slime",
	name: "Slime",
	description: "A blob of pure vibes. Immune to segfaults.",
	frames: {
		idle: [" .----.\n( o  o )\n `----'", " .----.\n( -  - )\n `----'"],
		working: [" .----.\n( o  o )~`=\n `----'", " .----.\n( o  o ) =`~\n `----'"],
		celebrating: ["  .----.\n\\( o  o )/\n  `----'", " .----.  \n/( ^  ^ )\\\n  `----'"],
		happy: [" .----.\n( ^  ^ )\n `----'"],
		sad: [" .----.\n( ;  ; )\n `----'"],
		sleepy: [" .----.\n( -  - )z\n `----'", " .----.\n( -  - ) Zz\n `----'"],
		eating: [" .----.\n( owo )\n `----'"],
	},
};

const MOCHI: PetSpeciesDef = {
	id: "pixel-mochi",
	name: "Mochi",
	description: "A squishy sakura rice cake in pixels, with a leaf on top.",
	frames: {
		idle: ["   ,\n .-'-.\n( o o )\n `-w-'", "   ,\n .-'-.\n( - - )\n `-w-'"],
		working: ["   ,\n .-'-.\n( o o )~\n `---'", "   ,\n .-'-.\n( o o ) ~\n `---'"],
		celebrating: [" \\ , /\n .-'-.\n( ^ ^ )\n `-o-'"],
		happy: ["   ,\n .-'-.\n( ^ ^ )\n `-w-'"],
		sad: ["   ,\n .-'-.\n( ; ; )\n `-n-'"],
		sleepy: ["   ,\n .-'-.\n( - - ) z\n `---'"],
		eating: ["   ,\n .-'-.\n( o o )\n `-o-'"],
	},
};

export const BUILTIN_SPECIES: readonly PetSpeciesDef[] = [CAT, DOG, SLIME, MOCHI];