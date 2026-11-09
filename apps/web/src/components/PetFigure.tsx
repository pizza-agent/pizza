import type { CSSProperties } from "react";
import { PetSprite, type PetSpriteProps } from "./pet-shared";
import { CHARACTERS } from "@/lib/agent-character";
import "./pet-figure.css";

type PetFigureProps = Partial<Pick<PetSpriteProps, "mood" | "look" | "character" | "expression" | "speechLevel" | "onReady">> & {
	scale?: number;
	size?: number;
	halo?: boolean;
};

/** One procedural rig shared by the sidebar, profile, settings and desktop window. */
export function PetFigure({ mood = "idle", look = { x: 0, y: 0 }, scale = 1, size = 64, halo = true,
	character = CHARACTERS.pizza, expression, speechLevel, onReady }: PetFigureProps) {
	const dim = Math.round(size * Math.min(1.5, Math.max(.7, scale)));
	return <span className="pet-figure" style={{ width: dim, height: dim, "--pet-accent": character.accent } as CSSProperties}>
		{halo && <span className="pet-figure__aura" aria-hidden="true" />}
		<span className="pet-figure__art"><PetSprite mood={mood} look={look} scale={dim / 112}
			character={character} expression={expression} speechLevel={speechLevel} onReady={onReady} /></span>
	</span>;
}
