import { afterEach, describe, expect, it, vi } from "vitest";
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
	loadPetSave,
	savePet,
	savePetProgress,
} from "../src/core/pet/store.js";
import { BUILTIN_SPECIES } from "../src/core/pet/sprites.js";
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
	it("roundtrips the code character's progress and size", () => {
		savePet({ speciesId: "pizza", xp: 42, adoptedAt: 123, scale: 1.25 });
		expect(loadPetSave()).toMatchObject({ speciesId: "pizza", xp: 42, adoptedAt: 123, scale: 1.25 });
		deletePetSave();
		expect(loadPetSave()).toBeUndefined();
	});
	it("exposes only the code-defined Pizza character", () => {
		expect(new PetService().listSpecies()).toEqual(BUILTIN_SPECIES);
		expect(BUILTIN_SPECIES.map((s) => s.id)).toEqual(["pizza"]);
	});
	it("does not load or migrate an unsupported character save", () => {
		savePet({ speciesId: "unsupported", xp: 42, adoptedAt: 123 });
		expect(loadPetSave()).toBeUndefined();
		expect(new PetService().status()).toBeNull();
		deletePetSave();
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
		let catalog = service.perform({ action: "adopt", speciesId: "pizza" });
		expect(catalog.pet).toMatchObject({ speciesId: "pizza", mood: "happy" });
		expect(catalog.pet).not.toHaveProperty("name");
		expect(catalog.catalog.map((s) => s.id)).toEqual(["pizza"]);
		catalog = service.perform({ action: "customize", scale: 9 });
		expect(catalog.pet).toMatchObject({ scale: 1.5 });
		service.perform({ action: "feed" });
		expect(loadPetSave()?.xp).toBe(2);
		expect(service.perform({ action: "release" }).pet).toBeNull();
		expect(loadPetSave()).toBeUndefined();
	});

	it("follows session activity and notifies only on change", async () => {
		const service = petService;
		service.perform({ action: "adopt", speciesId: "pizza" });
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

	it("keeps plugin actions and expression controls without custom species registration", () => {
		const service = new PetService();
		const remove = service.addContributionSource({
			actions: () => [{ id: "pomodoro", label: "Pomodoro", command: "/pomodoro" }, { id: "pomodoro", label: "Dupe", command: "/x" }],
		});
		expect(service.listActions()).toEqual([{ id: "pomodoro", label: "Pomodoro", command: "/pomodoro", description: undefined }]);
		service.perform({ action: "adopt", speciesId: "pizza" });
		service.react("celebrating", { xp: 5 });
		expect(service.status()).toMatchObject({ mood: "celebrating", xp: 5 });
		remove();
		expect(service.listActions()).toEqual([]);
	});
});

describe("shared character progress", () => {
	it("background progress preserves newer size and adoption data", () => {
		savePet({ speciesId: "pizza", xp: 10, adoptedAt: 1 });
		savePet({ speciesId: "pizza", xp: 30, adoptedAt: 2, scale: 1.2 });
		expect(savePetProgress(20)).toMatchObject({ speciesId: "pizza", xp: 30, adoptedAt: 2, scale: 1.2 });
		deletePetSave();
		expect(savePetProgress(50)).toBeUndefined();
		expect(loadPetSave()).toBeUndefined();
	});
	it("syncs changes across processes and never restores a released character", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const service = new PetService();
		const seen: PetSnapshot[] = [];
		const stop = service.subscribe((snapshot) => seen.push(snapshot));
		try {
			savePet({ speciesId: "pizza", xp: 0, adoptedAt: 1 });
			service.notify();
			savePet({ speciesId: "pizza", xp: 15, adoptedAt: 1, scale: 1.3 });
			await vi.advanceTimersByTimeAsync(2100);
			expect(seen.at(-1)?.pet).toMatchObject({ speciesId: "pizza", xp: 15, scale: 1.3 });
			service.dispatch("turn_end");
			await service.flush();
			expect(loadPetSave()).toMatchObject({ speciesId: "pizza", xp: 19 });
			deletePetSave();
			await vi.advanceTimersByTimeAsync(2100);
			expect(seen.at(-1)?.pet).toBeNull();
			service.dispatch("turn_end");
			await service.flush();
			expect(loadPetSave()).toBeUndefined();
		} finally { stop(); vi.useRealTimers(); }
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
