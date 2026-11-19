import { describe, expect, it, beforeEach } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { whyCommand } from "../src/builtin-extensions/provenance-lens/index.js";
import { BUILTIN_EXTENSIONS } from "../src/builtin-extensions/index.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";

describe("_why command", () => {
	let store: SqliteEventStore;
	let ctx: ExtensionContext;

	beforeEach(() => {
		store = new SqliteEventStore("provenance-command", ":memory:");
		const user = store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "fix the login bug" },
			thread_id: "thread-a",
		});
		const call = store.append({
			actor_id: "coder_agent",
			type: "INTENT_TOOL_CALL",
			payload: { tool_call_id: "tc_1", tool_name: "cli", arguments: { command: "_edit src/a.ts" } },
			caused_by: user.event_id,
			thread_id: "thread-a",
		});
		const end = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "tc_1",
				tool_name: "cli",
				result: [{ type: "text", text: "edited" }],
				is_error: false,
				duration_ms: 2,
			},
			caused_by: call.event_id,
			thread_id: "thread-a",
		});
		store.append({
			actor_id: "runtime",
			type: "FILE_MUTATION_APPLIED",
			payload: { path: "src/a.ts", operation: "modify", diff: "@@ -1 +1 @@\n-a\n+b", tool_call_id: "tc_1" },
			caused_by: end.event_id,
			thread_id: "thread-a",
		});
		ctx = {
			sessionManager: {
				eventStore: store,
				projection: {
					getDescriptor: () => ({
						session_id: "s1",
						thread_id: "thread-a",
						workspace_id: "provenance-command",
						event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
						created_by: "user_explicit",
						created_at: 0,
					}),
				},
			},
		} as unknown as ExtensionContext;
	});

	it("is registered as a built-in extension", () => {
		expect(BUILTIN_EXTENSIONS.some((extension) => extension.id === "provenance-lens")).toBe(true);
	});

	it("parses path/event/tool-call and JSON flags", () => {
		expect(whyCommand.parseArguments?.(["src/a.ts"], undefined, {})).toMatchObject({ path: "src/a.ts" });
		expect(whyCommand.parseArguments?.(["--event", "e1", "--json"], undefined, {})).toMatchObject({
			eventId: "e1",
			json: true,
		});
		expect(whyCommand.parseArguments?.(["--tool-call", "tc_1", "--limit", "3"], undefined, {})).toMatchObject({
			toolCallId: "tc_1",
			limit: 3,
		});
		expect(() => whyCommand.parseArguments?.([], undefined, {})).toThrow(/Missing/);
	});

	it("executes against the session EventStore and returns markdown", async () => {
		const result = await whyCommand.execute("why_1", { path: "src/a.ts" }, undefined, undefined, ctx);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("fix the login bug");
		expect(text).toContain("Changed src/a.ts");
	});

	it("supports --json", async () => {
		const result = await whyCommand.execute("why_2", { path: "src/a.ts", json: true }, undefined, undefined, ctx);
		const parsed = JSON.parse((result.content[0] as { text: string }).text);
		expect(parsed.title).toContain("src/a.ts");
		expect(Array.isArray(parsed.evidence)).toBe(true);
	});
});
