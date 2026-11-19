import { beforeEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import {
	routeContextQuery,
	selectGoalPins,
	selectPathContext,
	selectRecentContext,
} from "../src/core/context/goal-pins.js";
import { contextCommand } from "../src/builtin-extensions/context-router/index.js";
import { BUILTIN_EXTENSIONS } from "../src/builtin-extensions/index.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";

describe("GoalPins context selectors", () => {
	let store: SqliteEventStore;
	let ctx: ExtensionContext;

	beforeEach(() => {
		store = new SqliteEventStore("goal-pins", ":memory:");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "ok" }, thread_id: "thread-a" });
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "/mode" }, thread_id: "thread-a" });
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "We need to keep the public API stable and only edit source files." },
			thread_id: "thread-a",
		});
		store.append({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: "Create a branch named refactor, then read src/auth.ts." },
			thread_id: "thread-a",
		});
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "continue" }, thread_id: "thread-a" });
		store.append({
			actor_id: "runtime",
			type: "FILE_MUTATION_APPLIED",
			payload: { path: "src/auth.ts", operation: "modify", diff: "@@ -1 +1 @@\n-a\n+b" },
			thread_id: "thread-a",
		});
		store.append({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: { tool_call_id: "tc1", tool_name: "read", result: [{ type: "text", text: "current contents" }], is_error: false },
			thread_id: "thread-a",
		});
		ctx = {
			cwd: "/workspace",
			sessionManager: {
				eventStore: store,
				projection: {
					getDescriptor: () => ({
						session_id: "s1",
						thread_id: "thread-a",
						workspace_id: "goal-pins",
						event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
						created_by: "user_explicit",
						created_at: 0,
					}),
				},
			},
		} as unknown as ExtensionContext;
	});

	it("pins constraints and drops trivial/slash commands", () => {
		const events = store.query({});
		const selection = selectGoalPins(events);
		const text = selection.markdown;
		expect(text).toContain("public API stable");
		expect(text).toContain("branch named refactor");
		expect(text).not.toContain("content ok");
		expect(text).not.toContain("/mode");
	});

	it("returns recent observations", () => {
		const selection = selectRecentContext(store.query({}));
		expect(selection.evidence.some((item) => item.type === "TOOL_EXECUTION_END")).toBe(true);
		expect(selection.markdown).toContain("current contents");
	});

	it("selects path evidence", () => {
		const selection = selectPathContext(store.query({}), "src/auth.ts");
		expect(selection.evidence.some((item) => item.type === "FILE_MUTATION_APPLIED")).toBe(true);
		expect(selection.markdown).toContain("src/auth.ts");
	});

	it("routes constraint questions to pins and default to recent", () => {
		expect(routeContextQuery("why did we keep the API stable?").strategy).toBe("pins");
		expect(routeContextQuery("what is the next failing test?").strategy).toBe("recent");
	});

	it("parses and executes the _context command", async () => {
		expect(contextCommand.parseArguments?.(["pins", "--limit", "3"], undefined, {})).toMatchObject({
			subcommand: "pins",
			limit: 3,
		});
		expect(contextCommand.parseArguments?.(["path", "src/auth.ts", "--json"], undefined, {})).toMatchObject({
			subcommand: "path",
			path: "src/auth.ts",
			json: true,
		});
		expect(() => contextCommand.parseArguments?.(["path"], undefined, {})).toThrow(/path/);

		const result = await contextCommand.execute("ctx1", { subcommand: "pins" }, undefined, undefined, ctx);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("public API stable");
	});

	it("is registered as a built-in extension", () => {
		expect(BUILTIN_EXTENSIONS.some((extension) => extension.id === "context-router")).toBe(true);
	});
});
