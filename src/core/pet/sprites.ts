/** Runtime expressions and the code-defined character catalog. */
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

/** Metadata for characters implemented in code. */
export interface PetSpeciesDef {
	id: string;
	name: string;
	description?: string;
}

export const BUILTIN_SPECIES: readonly PetSpeciesDef[] = [
	{ id: "pizza", name: "Pizza", description: "A curious little companion. Big eyes, a big smile, and a face for every agent state." },
];
