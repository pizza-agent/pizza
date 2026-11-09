import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.js";
import {
	applyEvent,
	effectiveMood,
	initialPetState,
	levelForXp,
	REACTION_TTL_MS,
	SLEEPY_AFTER_MS,
} from "../src/core/pet/state.js";
import {
	deletePetSave,
	listUserSpecies,
	loadPetSave,
	savePet,
	savePetProgress,
} from "../src/core/pet/store.js";
import { framesForMood, BUILTIN_SPECIES } from "../src/core/pet/sprites.js";
import { PetService, petService, type PetSnapshot } from "../src/core/pet/service.js";
import { attachPetToSession } from "../src/core/pet/session.js";
import { BUILTIN_EXTENSIONS } from "../src/builtin-extensions/index.js";
import type { EventBase } from "../src/core/event-store/types.js";

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
		savePet({ name: "Momo", speciesId: "cat", xp: 42, adoptedAt: 123, scale: 1.25, subtitle: "Diff inspector" });
		const loaded = loadPetSave();
		expect(loaded?.name).toBe("Momo");
		expect(loaded?.speciesId).toBe("cat");
		expect(loaded?.xp).toBe(42);
		expect(loaded?.scale).toBe(1.25);
		expect(loaded?.subtitle).toBe("Diff inspector");
		deletePetSave();
		expect(loadPetSave()).toBeUndefined();
	});

	it("lists builtin species and merges user packs", () => {
		const service = new PetService();
		const all = service.listSpecies();
		expect(all.map((s) => s.id)).toContain("pip");
		expect(all.filter((s) => s.source === "builtin").map((s) => s.id)).toEqual(["pip"]);

		const dir = join(getAgentDir(), "pets");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "dragon.json"),
			JSON.stringify({ id: "dragon", name: "Dragon", frames: { idle: ["(dragon)"] } }),
		);
		writeFileSync(join(dir, "broken.json"), "{not json");

		const merged = service.listSpecies();
		const dragon = service.findSpecies("dragon");
		expect(dragon?.name).toBe("Dragon");
		expect(dragon?.source).toBe("user");
		expect(framesForMood(dragon!, "happy")).toEqual(["(dragon)"]); // falls back to idle
		expect(merged.filter((s) => s.id === "broken")).toHaveLength(0);
	});

	it("re-reads user packs only when one changes", () => {
		const dir = join(getAgentDir(), "pets");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "owl.json");
		writeFileSync(file, JSON.stringify({ id: "owl", name: "Owl", frames: { idle: ["(o)"] } }));
		expect(listUserSpecies().find((s) => s.id === "owl")?.name).toBe("Owl");
		writeFileSync(file, JSON.stringify({ id: "owl", name: "Snowy owl", frames: { idle: ["(O)"] } }));
		expect(listUserSpecies().find((s) => s.id === "owl")?.name).toBe("Snowy owl");
		rmSync(file);
		expect(listUserSpecies().find((s) => s.id === "owl")).toBeUndefined();
	});

	it("framesForMood falls back to idle frames", () => {
		const cat = BUILTIN_SPECIES.find((s) => s.id === "pip")!;
		expect(framesForMood(cat, "happy").length).toBeGreaterThan(0);
	});
});

describe("pet is a core feature", () => {
	afterEach(() => deletePetSave());

	it("is not a (disableable) built-in extension", () => {
		expect(BUILTIN_EXTENSIONS.map((ext) => ext.id)).not.toContain("pet");
	});

	it("adopts, customizes and releases through one service", () => {
		const service = new PetService();
		expect(() => service.perform({ action: "feed" })).toThrow(/No pet/);
		expect(() => service.perform({ action: "adopt", speciesId: "nope" })).toThrow(/Unknown/);
		let catalog = service.perform({ action: "adopt", speciesId: "pip" });
		expect(catalog.pet).toMatchObject({ speciesId: "pip", mood: "happy" });
		expect(catalog.pet).not.toHaveProperty("name");
		expect(catalog.catalog.map((s) => s.id)).toEqual(expect.arrayContaining(["pip"]));
		expect(() => service.perform({ action: "adopt", speciesId: "pomo" })).toThrow(/Unknown/);
		// Older app versions require a name in the save; it is kept, never shown.
		expect(loadPetSave()?.name).toBe("Pizza");
		catalog = service.perform({ action: "customize", scale: 9 });
		expect(catalog.pet).toMatchObject({ scale: 1.5 });
		service.perform({ action: "feed" });
		expect(loadPetSave()?.xp).toBe(2);
		expect(service.perform({ action: "release" }).pet).toBeNull();
		expect(loadPetSave()).toBeUndefined();
	});

	it("follows session activity and notifies only on change", async () => {
		const service = petService;
		service.perform({ action: "adopt", speciesId: "pip" });
		const seen: PetSnapshot[] = [];
		const stop = service.subscribe((snapshot) => seen.push(snapshot));
		const handlers = new Set<(event: EventBase) => void>();
		const emit = (type: string, payload: unknown = {}) => handlers.forEach((h) => h({ type, payload } as unknown as EventBase));
		const detach = attachPetToSession({ subscribe: (h) => { handlers.add(h); return () => handlers.delete(h); } });
		try {
			emit("AGENT_TURN_START");
			expect(seen.at(-1)?.pet).toMatchObject({ busy: true, mood: "thinking" });
			const count = seen.length;
			service.notify();
			expect(seen).toHaveLength(count);
			emit("AGENT_TURN_END");
			emit("AGENT_TURN_COMPLETED", { reason: "stop" });
			expect(seen.at(-1)?.pet).toMatchObject({ busy: false, mood: "celebrating", xp: 4 });
			await service.flush();
			expect(loadPetSave()?.xp).toBe(4);
			emit("TOOL_EXECUTION_END", { is_error: true });
			expect(seen.at(-1)?.pet?.mood).toBe("sad");
		} finally {
			detach();
			stop();
		}
		expect(handlers.size).toBe(0);
	});

	it("merges plugin species and actions while their session lives", () => {
		const service = new PetService();
		const remove = service.addContributionSource({
			species: () => [{ id: "fox", name: "Fox", frames: { idle: ["(fox)"] } }, { id: "bad", name: "Bad", frames: { nope: ["x"] } } as never],
			actions: () => [{ id: "pomodoro", label: "Pomodoro", command: "/pomodoro" }, { id: "pomodoro", label: "Dupe", command: "/x" }],
		});
		expect(service.findSpecies("fox")?.source).toBe("plugin");
		expect(service.findSpecies("bad")).toBeUndefined();
		expect(service.listActions()).toEqual([{ id: "pomodoro", label: "Pomodoro", command: "/pomodoro", description: undefined }]);
		const snapshot = service.perform({ action: "adopt", speciesId: "fox" });
		expect(snapshot.species?.frames.idle).toEqual(["(fox)"]);
		service.react("celebrating", { xp: 5 });
		expect(service.status()).toMatchObject({ mood: "celebrating", xp: 5 });
		remove();
		expect(service.findSpecies("fox")).toBeUndefined();
	});
});

describe("shared pet appearance", () => {
 it("background progress preserves a newer selection, name, size and floating flag", () => {
  savePet({name:"Old",speciesId:"pip",xp:10,adoptedAt:1});
  savePet({name:"New",speciesId:"custom-new",xp:30,adoptedAt:1,scale:1.2,subtitle:"hello"});
  const result=savePetProgress(20);
  expect(result).toMatchObject({name:"New",speciesId:"custom-new",xp:30,scale:1.2,subtitle:"hello"});
  deletePetSave();
  expect(savePetProgress(50)).toBeUndefined();
  expect(loadPetSave()).toBeUndefined();
 });
 it("another process's changes reach listeners and a released pet is never resurrected", async () => {
  // Only the 2s poll is faked; the async save lock keeps real timers.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const service = new PetService();
  const seen: PetSnapshot[] = [];
  const stop = service.subscribe((snapshot) => seen.push(snapshot));
  try {
   savePet({name:"Cat",speciesId:"pip",xp:0,adoptedAt:1});
   service.notify();
   expect(seen.at(-1)?.pet?.speciesId).toBe("pip");
   savePet({name:"Dog",speciesId:"custom-new",xp:15,adoptedAt:1});
   await vi.advanceTimersByTimeAsync(2100);
   expect(seen.at(-1)?.pet).toMatchObject({speciesId:"custom-new",xp:15});
   service.dispatch("turn_end");
   await service.flush();
   expect(loadPetSave()).toMatchObject({speciesId:"custom-new",xp:19});
   deletePetSave();
   await vi.advanceTimersByTimeAsync(2100);
   expect(seen.at(-1)?.pet).toBeNull();
   service.dispatch("turn_end");
   await service.flush();
   expect(loadPetSave()).toBeUndefined();
  } finally { stop(); vi.useRealTimers(); }
 });
});


describe("Procedural Pizza migration", () => {
 afterEach(() => deletePetSave());
 it("exposes exactly one Pizza default", () => {
  expect(BUILTIN_SPECIES.map(s=>s.id)).toEqual(["pip"]);
 });
 it.each(["dog", "mozz", "pomo", "basi"])("moves retired %s to Pizza and preserves user data", (id) => {
  savePet({name:"Wang",speciesId:id,xp:180,adoptedAt:123,scale:1.25,subtitle:"hello"});
  const pet = new PetService().status();
  expect(pet).toMatchObject({speciesId:"pip",xp:180,adoptedAt:123,scale:1.25});
  expect(pet).not.toHaveProperty("subtitle");
  expect(loadPetSave()?.speciesId).toBe("pip");
 });
 it("keeps a plugin-owned legacy id and user-defined art", () => {
  savePet({name:"Custom",speciesId:"cat",xp:10,adoptedAt:1});
  const service=new PetService();
  const remove=service.addContributionSource({species:()=>[{id:"cat",name:"Custom cat",frames:{idle:["custom"]}}],actions:()=>[]});
  try { expect(service.snapshot()).toMatchObject({pet:{speciesId:"cat"},species:{source:"plugin",frames:{idle:["custom"]}}}); }
  finally { remove(); }
 });
});

describe("agent-driven character expressions", () => {
	afterEach(async () => { await petService.flush(); deletePetSave(); vi.useRealTimers(); });
	function source() {
		const handlers = new Set<(event: EventBase) => void>();
		let id = 0;
		const detach = attachPetToSession({ subscribe: (h) => { handlers.add(h); return () => handlers.delete(h); } });
		const emit = (type: EventBase["type"], payload: unknown = {}, eventId = `event-${++id}`, causedBy?: string) => {
			handlers.forEach((h) => h({ event_id: eventId, caused_by: causedBy, type, payload } as EventBase));
			return eventId;
		};
		return { emit, detach };
	}
	it("distinguishes thinking, text streaming, parallel tools and actual completion without adoption", () => {
		deletePetSave();
		const s = source();
		try {
			s.emit("AGENT_TURN_START");
			expect(petService.snapshot()).toMatchObject({ pet: null, activity: { mood: "thinking", busy: true } });
			s.emit("AGENT_MESSAGE_CHUNK", { chunk: { kind: "thinking_delta", delta: "hmm" } });
			expect(petService.snapshot().activity?.mood).toBe("thinking");
			s.emit("AGENT_MESSAGE_CHUNK", { chunk: { kind: "text_delta", delta: "hello" } });
			expect(petService.snapshot().activity?.mood).toBe("speaking");
			s.emit("TOOL_EXECUTION_START", { tool_call_id: "a" });
			s.emit("TOOL_EXECUTION_START", { tool_call_id: "b" });
			s.emit("TOOL_EXECUTION_END", { tool_call_id: "a" });
			expect(petService.snapshot().activity?.mood).toBe("working");
			s.emit("TOOL_EXECUTION_END", { tool_call_id: "b" });
			s.emit("AGENT_TURN_END"); // Model/tool loop boundary is not success.
			expect(petService.snapshot().activity?.mood).toBe("thinking");
			s.emit("AGENT_TURN_COMPLETED", { reason: "stop" });
			expect(petService.snapshot().activity).toEqual({ mood: "celebrating", busy: false });
		} finally { s.detach(); }
	});
	it("keeps waiting through parallel tools until all approvals are answered", () => {
		const s = source();
		try {
			s.emit("AGENT_TURN_START");
			const a = s.emit("INTENT_TOOL_CALL", { requires_approval: true });
			const b = s.emit("INTENT_TOOL_CALL", { requires_approval: true });
			s.emit("TOOL_EXECUTION_START", { tool_call_id: "other" });
			s.emit("USER_APPROVAL", { intent_event_id: a });
			expect(petService.snapshot().activity?.mood).toBe("waiting");
			s.emit("USER_REJECTION", { intent_event_id: b });
			expect(petService.snapshot().activity?.mood).toBe("working");
			s.emit("USER_INTERRUPT");
			expect(petService.snapshot().activity).toEqual({ mood: "idle", busy: false });
		} finally { s.detach(); }
	});
	it("preserves interaction waiting after the agent stops, then clears on an answer or expiry", () => {
		vi.useFakeTimers();
		const s = source();
		try {
			s.emit("AGENT_TURN_START");
			const requestId = s.emit("INTERACTION_REQUESTED", { card: { title: "Which branch?" }, expiresAt: Date.now() + 1000 });
			s.emit("AGENT_TURN_COMPLETED", { reason: "interaction_pending" });
			expect(petService.snapshot().activity?.mood).toBe("waiting");
			s.emit("INTERACTION_ANSWERED", { requestId });
			expect(petService.snapshot().activity?.busy).toBe(false);
			s.emit("INTERACTION_REQUESTED", { card: { title: "Continue?" }, expiresAt: Date.now() + 1000 });
			vi.advanceTimersByTime(1001);
			expect(petService.snapshot().activity?.busy).toBe(false);
		} finally { s.detach(); }
	});
	it("prioritizes attention across sessions, preserves active work when one detaches, and reports failure", () => {
		const a = source(), b = source();
		try {
			a.emit("AGENT_TURN_START");
			a.emit("TOOL_EXECUTION_START", { tool_call_id: "a" });
			b.emit("AGENT_TURN_START");
			b.emit("INTENT_TOOL_CALL", { requires_approval: true });
			expect(petService.snapshot().activity?.mood).toBe("waiting");
			b.detach();
			expect(petService.snapshot().activity?.mood).toBe("working");
			a.emit("AGENT_TURN_COMPLETED", { reason: "error" });
			expect(petService.snapshot().activity).toEqual({ mood: "sad", busy: false });
		} finally { a.detach(); b.detach(); }
	});
	it("clears an automatically allowed intent when execution starts or rejects without a dialog", () => {
		const s = source();
		try {
			s.emit("AGENT_TURN_START");
			const allowed = s.emit("INTENT_TOOL_CALL", { requires_approval: true, tool_call_id: "a" });
			s.emit("TOOL_EXECUTION_START", { tool_call_id: "a" }, "start-a", allowed);
			expect(petService.snapshot().activity?.mood).toBe("working");
			s.emit("TOOL_EXECUTION_END", { tool_call_id: "a" }, "end-a", allowed);
			const rejected = s.emit("INTENT_TOOL_CALL", { requires_approval: true, tool_call_id: "b" });
			s.emit("TOOL_EXECUTION_END", { tool_call_id: "b", is_error: true }, "end-b", rejected);
			expect(petService.snapshot().activity?.mood).toBe("thinking");
		} finally { s.detach(); }
	});
	it("refreshes long-running activity so clients can distinguish it from a dead sidecar", () => {
		vi.useFakeTimers();
		const service = new PetService();
		const seen: PetSnapshot[] = [];
		const stop = service.subscribe((frame) => seen.push(frame));
		try {
			service.setActivity(Symbol("long tool"), "working");
			const count = seen.length;
			vi.advanceTimersByTime(2100);
			expect(seen).toHaveLength(count + 1);
			expect(seen.at(-1)?.activity).toEqual({ mood: "working", busy: true });
		} finally { stop(); }
	});
	it("does not celebrate an aborted turn", () => {
		const s = source();
		try {
			s.emit("AGENT_TURN_START");
			s.emit("AGENT_TURN_COMPLETED", { reason: "aborted" });
			expect(petService.snapshot().activity).toEqual({ mood: "idle", busy: false });
		} finally { s.detach(); }
	});
});
