import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalMemoryStore } from "../src/core/context/personal-memory.js";

describe.sequential("PersonalMemoryStore", () => {
	let dir: string;
	let previous: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pizza-memory-"));
		previous = process.env.PIZZA_CODING_AGENT_DIR;
		process.env.PIZZA_CODING_AGENT_DIR = dir;
	});

	afterEach(() => {
		if (previous === undefined) delete process.env.PIZZA_CODING_AGENT_DIR;
		else process.env.PIZZA_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	it("stores scoped memories and filters by project/session", async () => {
		const store = new PersonalMemoryStore(dir);
		const project = await store.remember({ text: "keep API stable", scope: "project", workspaceId: "ws-a" });
		await store.remember({ text: "only e2e tests", scope: "session", sessionId: "s-a", workspaceId: "ws-a" });
		await store.remember({ text: "prefers concise answers", scope: "global" });

		const visible = await store.list({ workspaceId: "ws-a", sessionId: "s-a" });
		expect(visible.map((item) => item.text)).toEqual(["keep API stable", "only e2e tests", "prefers concise answers"]);
		const other = await store.list({ workspaceId: "ws-b", sessionId: "s-b" });
		expect(other.map((item) => item.text)).toEqual(["prefers concise answers"]);
		expect(project.sourceEventId).toBeUndefined();
	});

	it("requires explicit scope keys", async () => {
		const store = new PersonalMemoryStore(dir);
		await expect(store.remember({ text: "x", scope: "project" })).rejects.toThrow(/workspace/);
		await expect(store.remember({ text: "x", scope: "session" })).rejects.toThrow(/session/);
	});

	it("scope-filters export and rejects cross-scope forget", async () => {
		const store = new PersonalMemoryStore(dir);
		const mine = await store.remember({ text: "mine", scope: "project", workspaceId: "ws-a" });
		const other = await store.remember({ text: "other", scope: "project", workspaceId: "ws-b" });
		await store.remember({ text: "global", scope: "global" });

		const visible = await store.export({ workspaceId: "ws-a", includeExpired: true });
		expect(visible.map((item) => item.text)).toEqual(["mine", "global"]);

		expect(await store.forget(other.id, { workspaceId: "ws-a" })).toBe(false);
		expect((await store.list({ workspaceId: "ws-b" })).map((item) => item.text)).toEqual(["other", "global"]);
		expect(await store.forget(mine.id, { workspaceId: "ws-a" })).toBe(true);
	});

	it("dedupes, expires, forgets, and exports", async () => {
		const store = new PersonalMemoryStore(dir);
		const first = await store.remember({ text: "keep API stable", scope: "global", sourceEventId: "e1" });
		const again = await store.remember({ text: "keep API stable", scope: "global", sourceEventId: "e1" });
		expect(again.id).toBe(first.id);

		await store.remember({ text: "expired", scope: "global", expiresAt: Date.now() - 1 });
		expect((await store.list()).map((item) => item.text)).toEqual(["keep API stable"]);
		expect((await store.list({ includeExpired: true })).map((item) => item.text)).toEqual(["keep API stable", "expired"]);

		expect(await store.forget(first.id)).toBe(true);
		expect(await store.forget(first.id)).toBe(false);
		expect(await store.export({ includeExpired: true })).toHaveLength(1);
	});
});
