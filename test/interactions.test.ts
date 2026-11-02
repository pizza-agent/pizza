import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import {
	answerInteraction,
	createInteraction,
	interactionReplyMessage,
	listInteractions,
} from "../src/core/interaction/store.js";
import { listInteractionCapabilities, registerInteractionCapabilities } from "../src/core/interaction/capabilities.js";
import { interactionCardSchema, validateInteractionAnswer } from "../src/core/interaction/schema.js";
import { createInteractionExtension } from "../src/builtin-extensions/interaction/index.js";
import type { BuiltinCommandDefinition, ExtensionContext } from "../src/core/extensions/types.js";

const card = {
	title: "认识一下",
	fields: [
		{ id: "name", type: "text", label: "怎么称呼你", required: true },
		{
			id: "style",
			type: "select",
			label: "回答风格",
			options: [
				{ id: "brief", label: "简洁" },
				{ id: "detail", label: "详细" },
			],
		},
		{
			id: "interests",
			type: "multi",
			label: "关注什么",
			options: [
				{ id: "work", label: "工作" },
				{ id: "life", label: "生活" },
			],
		},
	],
};

describe("durable dynamic interactions", () => {
	let dir: string, store: SqliteEventStore;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pizza-interaction-"));
		store = new SqliteEventStore("test", join(dir, "events.sqlite"));
	});
	afterEach(() => {
		vi.useRealTimers();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	it("restores pending and answered cards from disk without browser storage", () => {
		const record = createInteraction(store, "thread-a", "call-a", card);
		store.close();
		store = new SqliteEventStore("test", join(dir, "events.sqlite"));
		expect(listInteractions(store, "thread-a")).toEqual([record]);
		const result = answerInteraction(store, "thread-a", record.id, {
			kind: "submit",
			values: { name: "Tom", style: "brief", interests: ["work"] },
		});
		store.close();
		store = new SqliteEventStore("test", join(dir, "events.sqlite"));
		expect(listInteractions(store, "thread-a")[0]).toEqual(result.record);
		expect(interactionReplyMessage(result.record)).toContain("回答风格: 简洁");
	});
	it("isolates threads, rejects foreign requests, and blocks duplicate pending questions", () => {
		const a = createInteraction(store, "a", "call", card);
		expect(listInteractions(store, "b")).toEqual([]);
		expect(() => answerInteraction(store, "b", a.id, { kind: "skip" })).toThrow("not in this conversation");
		expect(createInteraction(store, "a", "call", card)).toEqual(a);
		expect(() => createInteraction(store, "a", "other", card)).toThrow("already pending");
		expect(createInteraction(store, "b", "call", card).id).not.toBe(a.id);
	});
	it("accepts retries only for the same answer, preserving a single answer event", () => {
		const a = createInteraction(store, "a", "call", card);
		expect(answerInteraction(store, "a", a.id, { kind: "text", text: "先不设置，帮我找资料" }).duplicate).toBe(false);
		expect(answerInteraction(store, "a", a.id, { kind: "text", text: "先不设置，帮我找资料" }).duplicate).toBe(true);
		expect(() => answerInteraction(store, "a", a.id, { kind: "skip" })).toThrow("already answered");
		expect(store.query({ types: ["INTERACTION_ANSWERED"] })).toHaveLength(1);
	});
	it("expires unanswered cards and allows a fresh question", () => {
		vi.useFakeTimers();
		const record = createInteraction(store, "a", "call", { ...card, expiresInMinutes: 1 });
		vi.advanceTimersByTime(60001);
		expect(listInteractions(store, "a")[0].status).toBe("expired");
		expect(() => answerInteraction(store, "a", record.id, { kind: "skip" })).toThrow("expired");
		expect(createInteraction(store, "a", "fresh", card).status).toBe("pending");
	});
	it("discovers capabilities live, snapshots selected instructions, and never executes them", () => {
		let status = "available";
		const unregister = registerInteractionCapabilities(store, "calendar", () => [
			{ id: "custom:calendar", label: "日历", description: "安排日程", status, instructions: "Use calendar connect" },
		]);
		expect(listInteractionCapabilities(store)[0].status).toBe("available");
		status = "connected";
		expect(listInteractionCapabilities(store)[0].status).toBe("connected");
		const a = createInteraction(store, "a", "call", {
			title: "需要日历吗？",
			actions: [{ id: "connect", label: "连接日历", capabilityId: "custom:calendar" }],
		});
		unregister();
		expect(listInteractionCapabilities(store)).toEqual([]);
		const result = answerInteraction(store, "a", a.id, { kind: "submit", values: {}, actionId: "connect" });
		expect(interactionReplyMessage(result.record)).toContain('"selectedCapability":{"id":"custom:calendar"');
		expect(() =>
			createInteraction(store, "b", "unknown", {
				title: "Connect",
				actions: [{ id: "go", label: "Go", capabilityId: "unknown" }],
			}),
		).toThrow("Unknown capability");
	});
	it("skipping a connection action never grants connection intent", () => {
		const a = createInteraction(store, "a", "call", { title: "是否连接？", actions: [{ id: "go", label: "连接" }] });
		const result = answerInteraction(store, "a", a.id, { kind: "skip" });
		expect(result.record.status).toBe("skipped");
		expect(interactionReplyMessage(result.record)).not.toContain('"selectedCapability"');
	});
	it("rejects malformed schemas, unsafe keys, invented choices, and missing required values", () => {
		for (const input of [
			{ title: "x" },
			{ ...card, script: "alert(1)" },
			{ ...card, fields: [{ id: "constructor", type: "text", label: "x" }] },
			{ ...card, fields: [{ id: "a", type: "select", label: "x" }] },
			{ ...card, fields: [card.fields[0], card.fields[0]] },
		])
			expect(interactionCardSchema.safeParse(input).success).toBe(false);
		const parsed = interactionCardSchema.parse(card);
		for (const answer of [
			{ kind: "submit", values: {} },
			{ kind: "submit", values: { name: " " } },
			{ kind: "submit", values: { name: "Tom", bad: "oops" } },
			{ kind: "submit", values: { name: "Tom", style: "invented" } },
			{ kind: "submit", values: { name: "Tom", interests: ["work", "work"] } },
			{ kind: "submit", values: { name: "Tom" }, actionId: "missing" },
		])
			expect(() => validateInteractionAnswer(parsed, answer)).toThrow();
		expect(() => validateInteractionAnswer({ ...parsed, allowSkip: false }, { kind: "skip" })).toThrow(
			"cannot be skipped",
		);
	});
	it("makes registry providers runtime-local and handles replacement cleanup", () => {
		const provider = () => [{ id: "x", label: "x", description: "x", status: "ready", instructions: "x" }];
		const old = registerInteractionCapabilities(store, "test", provider);
		registerInteractionCapabilities(store, "test", () => []);
		old();
		expect(listInteractionCapabilities(store)).toEqual([]);
	});
	it("serves a nonblocking GUI card, accepts ordinary chat, and falls back to terminal prompts", async () => {
		let command: BuiltinCommandDefinition | undefined;
		const handlers = new Map<string, Function>();
		createInteractionExtension({
			registerBuiltinCommand: (c: BuiltinCommandDefinition) => {
				command = c;
			},
			on: (name: string, handler: Function) => handlers.set(name, handler),
		} as never);
		const ctx = {
			sessionManager: { eventStore: store, projection: { getDescriptor: () => ({ thread_id: "a" }) } },
			ui: { surface: "rpc", input: vi.fn(), select: vi.fn() },
		} as unknown as ExtensionContext;
		const invoke = (id: string) =>
			command!.execute(id, command!.parseArguments!(["show"], JSON.stringify(card)), undefined, undefined, ctx);
		const result = await invoke("gui-call");
		expect(JSON.stringify(result)).toContain("pending");
		expect(ctx.ui.input).not.toHaveBeenCalled();
		handlers.get("input")!({ source: "extension", text: "internal" }, ctx);
		expect(listInteractions(store, "a")[0].status).toBe("pending");
		handlers.get("input")!({ source: "interactive", text: "叫我 Tom" }, ctx);
		expect(listInteractions(store, "a")[0].answer).toEqual({ kind: "text", text: "叫我 Tom" });
		ctx.ui.surface = "tui";
		vi.mocked(ctx.ui.input).mockResolvedValueOnce("Tom").mockResolvedValueOnce("life");
		vi.mocked(ctx.ui.select).mockResolvedValue("brief: 简洁");
		await invoke("terminal-call");
		expect(listInteractions(store, "a")[1]).toMatchObject({
			status: "answered",
			answer: { values: { name: "Tom", style: "brief", interests: ["life"] } },
		});
	});
});
