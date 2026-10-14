/**
 * Pet state machine — pure logic, no I/O.
 *
 * Mood is derived from a base mood + a timed "reaction" mood + agent busy
 * state + idle timeout. Reactions (celebrating / sad / happy / eating)
 * expire back to idle after REACTION_TTL_MS.
 */

import type { PetMood } from "./sprites.js";

export type PetEventKind =
	| "turn_start"
	| "turn_end"
	| "tool_error"
	| "compaction"
	| "feed"
	| "play"
	| "adopt";

export interface PetState {
	mood: PetMood;
	xp: number;
	level: number;
	lastEventAt: number;
	moodSince: number;
}

/** How long a reaction mood lasts before returning to idle. */
export const REACTION_TTL_MS = 15_000;
/** Idle this long and the pet gets sleepy. */
export const SLEEPY_AFTER_MS = 90_000;

const XP_PER_EVENT: Partial<Record<PetEventKind, number>> = {
	turn_start: 0,
	turn_end: 4,
	feed: 2,
	play: 2,
	adopt: 0,
};

export function xpForEvent(kind: PetEventKind): number {
	return XP_PER_EVENT[kind] ?? 1;
}

/** level grows with sqrt so early levels come fast, later ones slow down. */
export function levelForXp(xp: number): number {
	return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 10)) + 1);
}

export function initialPetState(now: number = Date.now()): PetState {
	return { mood: "idle", xp: 0, level: 1, lastEventAt: now, moodSince: now };
}

export function applyEvent(state: PetState, kind: PetEventKind, now: number = Date.now()): PetState {
	const next: PetState = {
		...state,
		xp: state.xp + xpForEvent(kind),
		lastEventAt: now,
	};
	next.level = levelForXp(next.xp);

	switch (kind) {
		case "turn_start":
			// "working" is driven by agentBusy in effectiveMood, not stored.
			break;
		case "turn_end":
			next.mood = "celebrating";
			next.moodSince = now;
			break;
		case "tool_error":
			next.mood = "sad";
			next.moodSince = now;
			break;
		case "compaction":
			next.mood = "sleepy";
			next.moodSince = now;
			break;
		case "feed":
			next.mood = "eating";
			next.moodSince = now;
			break;
		case "play":
			next.mood = "happy";
			next.moodSince = now;
			break;
		case "adopt":
			next.mood = "happy";
			next.moodSince = now;
			break;
	}
	return next;
}

/**
 * Resolve what the pet should look like right now.
 *
 * Precedence: agent busy (working) > fresh reaction > long idle (sleepy) > stored mood.
 */
export function effectiveMood(
	state: PetState,
	opts: { agentBusy: boolean; now?: number },
): PetMood {
	const now = opts.now ?? Date.now();
	if (opts.agentBusy) return "working";
	if (state.mood !== "idle" && state.mood !== "sleepy") {
		if (now - state.moodSince < REACTION_TTL_MS) return state.mood;
		// reaction expired
	}
	if (now - state.lastEventAt > SLEEPY_AFTER_MS) return "sleepy";
	if (state.mood === "sleepy") return "sleepy";
	return "idle";
}