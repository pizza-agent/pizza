import { describe, expect, it, beforeEach } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { buildWhy } from "../src/core/provenance/why.js";

describe("provenance _why", () => {
	let store: SqliteEventStore;

	beforeEach(() => {
		store = new SqliteEventStore("provenance", ":memory:");
	});

	function seed() {
		const user = store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "fix the expired login redirect" },
			thread_id: "thread-a",
		});
		const intent = store.append({
			actor_id: "coder_agent",
			type: "INTENT_TOOL_CALL",
			payload: {
				tool_call_id: "tc_edit",
				tool_name: "cli",
				arguments: { command: "_edit src/auth.ts --old x --new y" },
			},
			thread_id: "thread-a",
		});
		const result = store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id: "tc_edit",
				tool_name: "cli",
				result: [{ type: "text", text: "Successfully edited src/auth.ts" }],
				details: {
					command: {
						source: "builtin",
						name: "_edit",
						args: { path: "src/auth.ts" },
						details: { diff: "@@ -1 +1 @@\n-a\n+b" },
					},
				},
				is_error: false,
				duration_ms: 4,
			},
			caused_by: intent.event_id,
			thread_id: "thread-a",
		});
		const mutation = store.append({
			actor_id: "runtime",
			type: "FILE_MUTATION_APPLIED",
			payload: {
				path: "src/auth.ts",
				operation: "modify",
				diff: "@@ -1 +1 @@\n-a\n+b",
				tool_call_id: "tc_edit",
			},
			caused_by: result.event_id,
			thread_id: "thread-a",
		});
		return { user, intent, result, mutation };
	}

	it("builds a causal explanation for a changed path", () => {
		seed();
		const result = buildWhy(store, { path: "src/auth.ts", threadId: "thread-a" });
		expect(result.title).toContain("src/auth.ts");
		expect(result.markdown).toContain("fix the expired login redirect");
		expect(result.markdown).toContain("Tool call: cli");
		expect(result.markdown).toContain("Changed src/auth.ts [modify] (+1 −1)");
		expect(result.evidence.map((item) => item.type)).toEqual([
			"USER_MESSAGE",
			"INTENT_TOOL_CALL",
			"TOOL_EXECUTION_END",
			"FILE_MUTATION_APPLIED",
		]);
	});

	it("finds provenance from a tool call id", () => {
		seed();
		const result = buildWhy(store, { toolCallId: "tc_edit", threadId: "thread-a" });
		expect(result.targetEventId).toBeTruthy();
		expect(result.markdown).toContain("Successfully edited src/auth.ts");
	});

	it("filters other threads and missing paths", () => {
		seed();
		expect(() => buildWhy(store, { path: "src/auth.ts", threadId: "thread-b" })).toThrow(/No provenance/);
		expect(() => buildWhy(store, { path: "src/missing.ts", threadId: "thread-a" })).toThrow(/No provenance/);
	});

	it("caps the evidence list", () => {
		seed();
		const result = buildWhy(store, { path: "src/auth.ts", threadId: "thread-a", limit: 2 });
		expect(result.evidence.length).toBeLessThanOrEqual(2);
	});

	it("does not leak raw tool output into the summary", () => {
		seed();
		const result = buildWhy(store, { path: "src/auth.ts", threadId: "thread-a" });
		expect(result.markdown).not.toContain("@@ -1 +1 @@");
	});
});
