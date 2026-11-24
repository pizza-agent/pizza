import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { contextCommand } from "../src/builtin-extensions/context-router/index.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";

describe("_context memory commands", () => {
	let dir: string;
	let previous: string | undefined;
	let store: SqliteEventStore;
	let ctx: ExtensionContext;
	let eventId: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pizza-context-memory-"));
		previous = process.env.PIZZA_AGENT_DIR;
		process.env.PIZZA_AGENT_DIR = dir;
		store = new SqliteEventStore("context-memory", ":memory:");
		const event = store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "We need to keep the public API stable." },
			thread_id: "thread-a",
		});
		eventId = event.event_id;
		ctx = {
			cwd: "/workspace",
			sessionManager: {
				eventStore: store,
				projection: {
					getDescriptor: () => ({
						session_id: "s1",
						thread_id: "thread-a",
						workspace_id: "ws1",
						event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
						created_by: "user_explicit",
						created_at: 0,
					}),
				},
			},
		} as unknown as ExtensionContext;
	});

	afterEach(() => {
		if (previous === undefined) delete process.env.PIZZA_AGENT_DIR;
		else process.env.PIZZA_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	it("parses remember/forget/memories", () => {
		expect(contextCommand.parseArguments?.(["remember", "evt1", "--scope", "session", "--kind", "decision"], undefined, {})).toMatchObject({
			subcommand: "remember",
			eventId: "evt1",
			scope: "session",
			kind: "decision",
		});
		expect(contextCommand.parseArguments?.(["forget", "mem1"], undefined, {})).toMatchObject({
			subcommand: "forget",
			memoryId: "mem1",
		});
		expect(() => contextCommand.parseArguments?.(["remember"], undefined, {})).toThrow(/event id/);
	});

	it("remembers an event, merges it into pins, lists it, and forgets it", async () => {
		const remembered = await contextCommand.execute(
			"ctx1",
			{ subcommand: "remember", eventId, scope: "project", kind: "constraint" },
			undefined,
			undefined,
			ctx,
		);
		const memory = remembered.details as { id: string; text: string };
		expect(memory.text).toContain("public API stable");

		const pins = await contextCommand.execute("ctx2", { subcommand: "pins" }, undefined, undefined, ctx);
		const selection = pins.details as { evidence: Array<{ type: string; summary: string }> };
		expect(selection.evidence.some((item) => item.type === "MEMORY" && item.summary.includes("public API stable"))).toBe(true);

		const list = await contextCommand.execute("ctx3", { subcommand: "memories", json: true }, undefined, undefined, ctx);
		expect((list.content[0] as { text: string }).text).toContain(memory.id);

		const forgot = await contextCommand.execute("ctx4", { subcommand: "forget", memoryId: memory.id }, undefined, undefined, ctx);
		expect((forgot.content[0] as { text: string }).text).toContain("Forgot");

		const empty = await contextCommand.execute("ctx5", { subcommand: "memories" }, undefined, undefined, ctx);
		expect((empty.content[0] as { text: string }).text).toContain("No saved memories");
	});
});
