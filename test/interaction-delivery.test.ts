import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import {
	createInteraction,
	answerInteraction,
	interactionReplyMessage,
	listInteractions,
} from "../src/core/interaction/store.js";
import { InteractionDelivery } from "../src/core/interaction/delivery.js";
import { SessionFacade } from "../src/core/session/session-facade.js";
import { createInteractionExtension } from "../src/builtin-extensions/interaction/index.js";
import { enableMainInitiative, setInteractionOrigin } from "../src/core/interaction/initiative.js";
describe("interaction delivery lifecycle", () => {
	let dir: string, store: SqliteEventStore, services: InteractionDelivery[];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pizza-delivery-"));
		store = new SqliteEventStore("test", join(dir, "events.sqlite"));
		services = [];
	});
	afterEach(() => {
		services.forEach((s) => s.dispose());
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	function answer() {
		const r = createInteraction(store, "a", "call", {
			title: "Question",
			fields: [{ id: "name", type: "text", label: "Name" }],
		});
		return answerInteraction(store, "a", r.id, { kind: "text", text: "Tom" }, { deliveryRequired: true }).record;
	}
	function setup() {
		let active = "a",
			busy = false;
		const error = vi.fn();
		const prompt = vi.fn(async (text: string) => {
			store.append({ type: "USER_MESSAGE", actor_id: "user", thread_id: active, payload: { content: text } });
		});
		const facade = {
			get isRunning() {
				return busy;
			},
			runtime: { getProjection: () => ({ getDescriptor: () => ({ thread_id: active }) }) },
			prompt,
		} as unknown as SessionFacade;
		const service = new InteractionDelivery(store, facade, error);
		services.push(service);
		return {
			service,
			prompt,
			error,
			setActive: (v: string) => {
				active = v;
			},
			setBusy: (v: boolean) => {
				busy = v;
			},
		};
	}
	it("recovers a saved answer after restart and uses the original thread and input source", async () => {
		const r = answer();
		const { service, prompt } = setup();
		service.resume();
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
		expect(prompt).toHaveBeenCalledWith(interactionReplyMessage(r), undefined, undefined, {
			source: "interaction",
			threadId: "a",
		});
		service.resume();
		expect(prompt).toHaveBeenCalledOnce();
	});
	it("recognizes a persisted receipt even if the process stopped before acknowledging it", () => {
		const r = answer();
		store.append({
			type: "USER_MESSAGE",
			actor_id: "user",
			thread_id: "a",
			payload: { content: interactionReplyMessage(r) },
		});
		const { service, prompt } = setup();
		service.resume();
		expect(prompt).not.toHaveBeenCalled();
	});
	it("retries a failed dispatch without requiring another answer event", async () => {
		answer();
		const { service, prompt, error } = setup();
		prompt.mockRejectedValueOnce(Error("offline"));
		service.resume();
		await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
		expect(listInteractions(store, "a")[0].delivery).toBe("pending");
		service.resume();
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
		expect(store.query({ types: ["INTERACTION_ANSWERED"] })).toHaveLength(1);
		expect(listInteractions(store, "a")[0].delivery).toBe("delivered");
	});
	it("waits for busy agents and never delivers into another active conversation", async () => {
		answer();
		const { service, prompt, setBusy, setActive } = setup();
		setActive("b");
		service.resume();
		expect(prompt).not.toHaveBeenCalled();
		setActive("a");
		setBusy(true);
		service.resume();
		expect(prompt).not.toHaveBeenCalled();
		setBusy(false);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
	});
	it("does not accept scheduled input as a user's answer", async () => {
		const handlers = new Map<string, Function>();
		createInteractionExtension({
			registerCliCommand: () => {},
			on: (name: string, handler: Function) => handlers.set(name, handler),
		} as never);
		const context = {
			sessionManager: { eventStore: store, projection: { getDescriptor: () => ({ thread_id: "a" }) } },
		};
		createInteraction(store, "a", "call", { title: "Name?", fields: [{ id: "name", type: "text", label: "Name" }] });
		const runtime = { getProjection: () => context.sessionManager.projection, prompt: vi.fn(async () => {}) };
		const facade = new SessionFacade({
			runtime,
			settingsManager: {},
			extensionRunner: {
				createContext: () => context,
				hasHandlers: () => true,
				getRegisteredCommands: () => [],
				emitInput: async (text: string, _images: unknown, source: string) => {
					handlers.get("input")!({ text, source }, context);
					return { action: "continue" };
				},
			},
		} as never);
		await facade.prompt("Scheduled check", undefined, undefined, { source: "scheduler" });
		expect(listInteractions(store, "a")[0].status).toBe("pending");
		await facade.prompt("Tom");
		expect(listInteractions(store, "a")[0].answer).toEqual({ kind: "text", text: "Tom" });
	});
	it("does not let model flags bypass main-agent policy but allows trusted requested forms", () => {
		enableMainInitiative(store);
		const r = createInteraction(store, "a", "one", {
			title: "One",
			initiative: false,
			actions: [{ id: "go", label: "Go" }],
		});
		expect(r.card.initiative).toBe(true);
		answerInteraction(store, "a", r.id, { kind: "skip" });
		expect(() =>
			createInteraction(store, "a", "two", { title: "Two", initiative: false, actions: [{ id: "go", label: "Go" }] }),
		).toThrow("24 hours");
		setInteractionOrigin(store, "a", true);
		expect(
			createInteraction(store, "a", "explicit", { title: "Explicit", actions: [{ id: "go", label: "Go" }] }).status,
		).toBe("pending");
	});
	it("incrementally queries only new events and returns detached records", () => {
		const r = answer();
		const query = vi.spyOn(store, "query");
		const records = listInteractions(store, "a");
		query.mockClear();
		records[0].card.title = "mutated";
		listInteractions(store, "a");
		expect(query).not.toHaveBeenCalled();
		expect(listInteractions(store, "a")[0].card.title).toBe(r.card.title);
	});
});
