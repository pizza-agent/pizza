import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.js";
import {
	applyEvent,
	effectiveMood,
	initialPetState,
	levelForXp,
	REACTION_TTL_MS,
	SLEEPY_AFTER_MS,
} from "../src/builtin-extensions/pet/state.js";
import {
	deletePetSave,
	findSpecies,
	listAllSpecies,
	loadPetSave,
	savePet,
} from "../src/builtin-extensions/pet/store.js";
import { framesForMood, BUILTIN_SPECIES } from "../src/builtin-extensions/pet/sprites.js";
import { createPetExtension } from "../src/builtin-extensions/pet/index.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";

describe("pet state machine", () => {
	it("starts idle at level 1", () => {
		const s = initialPetState(0);
		expect(s.mood).toBe("idle");
		expect(s.level).toBe(1);
		expect(effectiveMood(s, { agentBusy: false, now: 1000 })).toBe("idle");
	});

	it("working overrides everything while agent is busy", () => {
		let s = initialPetState(0);
		s = applyEvent(s, "turn_start", 100);
		expect(effectiveMood(s, { agentBusy: true, now: 200 })).toBe("working");
	});

	it("celebrates on turn_end, expires back to idle", () => {
		let s = initialPetState(0);
		s = applyEvent(s, "turn_end", 1000);
		expect(effectiveMood(s, { agentBusy: false, now: 1000 })).toBe("celebrating");
		expect(effectiveMood(s, { agentBusy: false, now: 1000 + REACTION_TTL_MS + 1 })).toBe("idle");
	});

	it("gets sad on tool errors and sleepy on compaction", () => {
		let s = initialPetState(0);
		s = applyEvent(s, "tool_error", 5000);
		expect(effectiveMood(s, { agentBusy: false, now: 5000 })).toBe("sad");
		s = applyEvent(s, "compaction", 60_000);
		expect(effectiveMood(s, { agentBusy: false, now: 60_000 })).toBe("sleepy");
	});

	it("gets sleepy after long inactivity even from idle", () => {
		const s = initialPetState(0);
		expect(effectiveMood(s, { agentBusy: false, now: SLEEPY_AFTER_MS + 1 })).toBe("sleepy");
	});

	it("xp grows and levels up", () => {
		let s = initialPetState(0);
		s = applyEvent(s, "turn_end", 100);
		expect(s.xp).toBe(4);
		for (let i = 0; i < 24; i++) s = applyEvent(s, "turn_end", 1000 + i);
		expect(s.xp).toBe(4 + 24 * 4);
		expect(s.level).toBe(levelForXp(s.xp));
		expect(s.level).toBeGreaterThan(2);
	});
});

describe("pet store", () => {
	it("roundtrips pet.json in the agent dir", () => {
		savePet({ name: "Momo", speciesId: "cat", xp: 42, adoptedAt: 123 });
		const loaded = loadPetSave();
		expect(loaded?.name).toBe("Momo");
		expect(loaded?.speciesId).toBe("cat");
		expect(loaded?.xp).toBe(42);
		deletePetSave();
		expect(loadPetSave()).toBeUndefined();
	});

	it("lists builtin species and merges user packs", () => {
		const all = listAllSpecies();
		expect(all.map((s) => s.id)).toContain("cat");
		expect(all.map((s) => s.id)).toContain("slime");

		const dir = join(getAgentDir(), "pets");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "dragon.json"),
			JSON.stringify({ id: "dragon", name: "Dragon", frames: { idle: ["(dragon)"] } }),
		);
		writeFileSync(join(dir, "broken.json"), "{not json");

		const merged = listAllSpecies();
		const dragon = findSpecies("dragon");
		expect(dragon?.name).toBe("Dragon");
		expect(framesForMood(dragon!, "happy")).toEqual(["(dragon)"]); // falls back to idle
		expect(merged.filter((s) => s.id === "broken")).toHaveLength(0);
	});

	it("framesForMood falls back to idle frames", () => {
		const cat = BUILTIN_SPECIES.find((s) => s.id === "cat")!;
		expect(framesForMood(cat, "happy").length).toBeGreaterThan(0);
	});
});

describe("pet extension factory", () => {
	it("registers command, builtin command, settings items and event handlers", () => {
		const commands: string[] = [];
		const builtins: string[] = [];
		const events: string[] = [];
		const settings: string[] = [];
		const fakeApi = {
			on: (name: string) => events.push(name),
			registerCommand: (name: string) => commands.push(name),
			registerBuiltinCommand: (def: { name: string }) => builtins.push(def.name),
			registerSettingsItem: (item: { id: string }) => settings.push(item.id),
		} as unknown as ExtensionAPI;

		createPetExtension(fakeApi);
		expect(commands).toContain("pet");
		expect(builtins).toContain("_pet");
		expect(settings).toEqual(expect.arrayContaining(["pet", "pet-visible"]));
		expect(events).toEqual(
			expect.arrayContaining(["session_start", "turn_start", "turn_end", "agent_end", "tool_execution_end", "session_compact", "session_shutdown"]),
		);
	});
});