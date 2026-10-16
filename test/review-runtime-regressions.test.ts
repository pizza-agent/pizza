import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime, type EventSourcedRuntimeConfig } from "../src/core/runtime/runtime.js";
import type { LLMResponse, LLMClient } from "../src/core/runtime/llm-types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";

const registry: ToolRegistry = {
	list: () => ["echo"],
	get: (name) => name === "echo" ? {
		async execute() { return { content: [{ type: "text", text: "x".repeat(1200) }], is_error: false }; },
		getMetadata() { return { name: "echo", category: "file_read", defaultRisk: "safe" }; },
	} : undefined,
};
function response(input = 0, toolId?: string): LLMResponse {
	return {
		content: toolId ? [{ type: "tool_call", id: toolId, name: "echo", arguments: { id: toolId } }] : [{ type: "text", text: "done" }],
		provider: "test", model: "test",
		usage: { input, output: 0, cache_read: 0, cache_write: 0, total: input, cost: 0 },
		stopReason: toolId ? "tool_use" : "stop",
	};
}

describe("live runtime budget and call signal cleanup", () => {
	const runtimes: EventSourcedRuntime[] = [];
	const dirs: string[] = [];
	afterEach(() => {
		for (const runtime of runtimes.splice(0)) runtime.dispose();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function makeRuntime(client: LLMClient, overrides: Partial<EventSourcedRuntimeConfig> = {}) {
		const cwd = mkdtempSync(join(tmpdir(), "pizza-review-"));
		dirs.push(cwd);
		const runtime = new EventSourcedRuntime({
			cwd, agentDir: cwd, storagePath: ":memory:", toolRegistry: registry,
			llmClient: client, systemPrompt: "", model: { provider: "test", model_id: "test" }, tools: [],
			contextBudget: 100, classifierConfig: { approve_unknown: false },
			compactionEngineSettings: { reserveTokens: 0 }, ...overrides,
		});
		runtimes.push(runtime);
		return runtime;
	}

	it("uses an observed larger budget in the next tool round and the current compaction check", async () => {
		const requests: Parameters<LLMClient["complete"]>[0][] = [];
		const runtime = makeRuntime({ async complete(request) {
			requests.push(request);
			return requests.length === 1 ? response(50_000, "echo-1") : response();
		} });
		await runtime.prompt("retain this original user instruction");
		expect(requests).toHaveLength(2);
		expect(JSON.stringify(requests[1].messages)).toContain("retain this original user instruction");
		expect(JSON.stringify(requests[1].messages)).toContain("x".repeat(1200));
		expect(runtime.store.query({ types: ["COMPACTION_REQUESTED"] })).toHaveLength(0);
	});

	it("keeps an explicitly configured compaction window authoritative", async () => {
		let calls = 0;
		const runtime = makeRuntime({ async complete() {
			return ++calls === 1 ? response(50_000, "echo-1") : response();
		} }, { compactionEngineSettings: { contextWindow: 100, reserveTokens: 0, keepRecentTokens: 1, strategy: "mask" } });
		await runtime.prompt("original instruction");
		expect(runtime.store.query({ types: ["COMPACTION_REQUESTED"] })).not.toHaveLength(0);
	});

	it("does not reduce the default budget when the first observed prompt is small", async () => {
		const requests: Parameters<LLMClient["complete"]>[0][] = [];
		const runtime = makeRuntime({ async complete(request) {
			requests.push(request);
			return requests.length === 1 ? response(10, "echo-1") : response();
		} }, { contextBudget: undefined });
		await runtime.prompt("keep this instruction through the tool round");
		expect(JSON.stringify(requests[1].messages)).toContain("keep this instruction through the tool round");
		expect(runtime.store.query({ types: ["COMPACTION_REQUESTED"] })).toHaveLength(0);
	});

	it("does not accumulate parent abort listeners across a long tool chain", async () => {
		const counts: number[] = [];
		let calls = 0;
		let parent: AbortSignal | undefined;
		const runtime = makeRuntime({ async complete() {
			parent = runtime.signal;
			counts.push(getEventListeners(parent!, "abort").length);
			return ++calls <= 20 ? response(0, `call-${calls}`) : response();
		} }, { contextBudget: 128000 });
		await runtime.prompt("run the tool chain");
		expect(calls).toBe(21);
		expect(counts.every((count) => count === 1)).toBe(true);
		expect(getEventListeners(parent!, "abort")).toHaveLength(0);
	});

	it("removes the parent listener when the LLM rejects", async () => {
		let parent: AbortSignal | undefined;
		const runtime = makeRuntime({ async complete() {
			parent = runtime.signal;
			throw new Error("nonretryable test failure");
		} });
		await runtime.prompt("fail this call");
		expect(runtime.store.query({ types: ["LLM_CALL_FAILED"] })).toHaveLength(1);
		expect(getEventListeners(parent!, "abort")).toHaveLength(0);
	});
});
