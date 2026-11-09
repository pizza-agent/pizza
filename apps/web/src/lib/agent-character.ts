import type { RpcPetMood } from "@tomsun28/pizza-protocol";

/** A code-defined rig. Future characters can replace the silhouette and face placement. */
export interface CharacterDefinition {
	label: string;
	accent: string;
	body: string;
	crust?: string;
	face: { left: number; right: number; eyeY: number; mouthY: number };
}

/** The Pizza character is entirely code-rendered. No baked shapes, images, GIFs or frame assets. */
export const CHARACTERS: Record<string, CharacterDefinition> = {
	pizza: {
		label: "Pizza", accent: "#ffae48",
		body: "M25 19 Q56 9 87 19 Q99 23 92 39 L67 92 Q56 110 45 92 L20 39 Q13 23 25 19Z",
		crust: "M24 24 Q56 12 88 24",
		face: { left: 40, right: 72, eyeY: 46, mouthY: 68 },
	},
};

/** Expression and motion are separate from identity. All values use a 112×112 view box. */
export interface CharacterExpression {
	eyeX: number;
	eyeY: number;
	eyeTilt: number;
	smileEyes: boolean;
	mouth: string;
	mouthOpen: number;
	lean: number;
}
const smile = "M-13 0 Q0 6 13 0 Q10 17 0 17 Q-10 17 -13 0Z";
const round = "M-8 5 C-8 -5 8 -5 8 5 C8 17 -8 17 -8 5Z";
const base: CharacterExpression = { eyeX: 1, eyeY: 1, eyeTilt: 0, smileEyes: false, mouth: smile, mouthOpen: .7, lean: 0 };
export const CHARACTER_EXPRESSIONS: Record<RpcPetMood, CharacterExpression> = {
	idle: base,
	thinking: { ...base, eyeY: .88, eyeTilt: -8, mouth: round, mouthOpen: .45, lean: -5 },
	working: { ...base, eyeY: .72, eyeTilt: -7, mouthOpen: .5, lean: 2 },
	speaking: { ...base, mouthOpen: 1 },
	waiting: { ...base, eyeX: 1.06, eyeY: 1.12, mouth: round, mouthOpen: .7, lean: 6 },
	celebrating: { ...base, smileEyes: true, mouthOpen: 1, lean: -3 },
	happy: { ...base, smileEyes: true, mouthOpen: .9, lean: 3 },
	sad: { ...base, eyeY: .8, eyeTilt: 13, mouth: "M-11 8 Q0 -3 11 8", mouthOpen: 0, lean: -6 },
	sleepy: { ...base, eyeY: .18, mouth: round, mouthOpen: .3, lean: -7 },
	eating: { ...base, eyeY: .8, mouth: round, mouthOpen: .8 },
};
