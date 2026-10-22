import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventSourcedRuntime } from "../src/core/runtime/runtime.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { ToolRegistry } from "../src/core/intent/types.js";
import type { ContentBlock, EventBase, EventType } from "../src/core/event-store/types.js";

const BIG = "x".repeat(40_000);

describe("runtime auto-compaction with tool-result masking (default engine)", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-mask-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	const registry: ToolRegistry = {
		get: (name) =>
			name === "read"
				? {
						async execute() {
							return { content: [{ type: "text", text: BIG }], is_error: false };
						},
						getMetadata() {
							return { name: "read", category: "file_read", defaultRisk: "safe" };
						},
					}
				: undefined,
		list: () => ["read"],
	};

	function waitForEvent(runtime: EventSourcedRuntime, type: EventType, timeoutMs = 2000): Promise<EventBase> {
		const existing = runtime.store.query({ types: [type], reverse: true, limit: 1 })[0];
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timed out waiting for ${type}`));
			}, timeoutMs);
			const unsubscribe = runtime.subscribe((event) => {
				if (event.type !== type) return;
				clearTimeout(timeout);
				unsubscribe();
				resolve(event);
			}, { types: [type] });
		});
	}

	function reply(content: ContentBlock[], stopReason: LLMResponse["stopReason"]): LLMResponse {
		return {
			content,
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
			stopReason,
		};
	}

	it("masks the large tool result after a turn, skips the LLM summary, and sends placeholders next turn", async () => {
		const cwd = makeTempDir();
		const requests: Parameters<LLMClient["complete"]>[0][] = [];
		const client: LLMClient = {
			async complete(request) {
				requests.push(request);
				if (requests.length === 1) {
					return reply([{ type: "tool_call", id: "call_read", name: "read", arguments: { path: "src/big.ts" } } as ContentBlock], "tool_use");
				}
				return reply([{ type: "text", text: `answer ${requests.length}` } as ContentBlock], "stop");
			},
		};

		const runtime = new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: registry,
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			compactionEngineSettings: { contextWindow: 8_000, reserveTokens: 0, keepRecentTokens: 100 },
		});

		await runtime.prompt("read the big file");
		const end = await waitForEvent(runtime, "COMPACTION_END");

		expect(requests).toHaveLength(2); // tool call + final answer; no summarization call
		expect(end.payload).toMatchObject({ mode: "mask", masked_count: 1, mask_min_chars: 500 });
		expect((end.payload as { mask_before_event_id?: string }).mask_before_event_id).toBeTruthy();

		await runtime.prompt("continue");
		const lastRequest = JSON.stringify(requests[requests.length - 1]!.messages);
		expect(lastRequest).toContain("Tool result cleared to save context");
		expect(lastRequest).not.toContain(BIG);
		expect(lastRequest).toContain("read the big file");

		runtime.dispose();
	});
});

describe("compaction threshold basis with understated catalog window", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pizza-basis-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function replyWith(usage: { input: number; output: number }, text = "ok"): LLMResponse {
		return {
			content: [{ type: "text", text } as ContentBlock],
			provider: "test",
			model: "test",
			usage: { ...usage, cache_read: 0, cache_write: 0, total: usage.input + usage.output, cost: 0 },
			stopReason: "stop",
		};
	}

	function newRuntime(cwd: string, responses: LLMResponse[]) {
		let i = 0;
		const client: LLMClient = {
			async complete() {
				return responses[Math.min(i++, responses.length - 1)]!;
			},
		};
		return new EventSourcedRuntime({
			cwd,
			agentDir: cwd,
			toolRegistry: { get: () => undefined, list: () => [] },
			llmClient: client,
			classifierConfig: { approve_unknown: false },
			systemPrompt: "",
			model: { provider: "test", model_id: "test" },
			tools: [],
			// resolved catalog-style window 10k via contextBudget (not the
			// explicit engine override, which stays authoritative), reserve 0
			contextBudget: 10_000,
			compactionEngineSettings: { reserveTokens: 0, keepRecentTokens: 0 },
		});
	}

	it("extends the trigger basis past an understated catalog window using observed capacity", async () => {
		const cwd = makeTempDir();
		// Provider proves it serves ≥30k prompts; the understated 10k catalog
		// must not trigger compaction while observedMax ≈ 30k.
		const runtime = newRuntime(cwd, [replyWith({ input: 30_000, output: 0 })]);
		const policy = (runtime as any)._buildCompactionPolicy(runtime.getProjection());
		expect(policy.contextWindow()).toBe(10_000);
		// Simulate the reactor's observed-context report.
		(runtime as any).observedContextMax = 30_000;
		expect(policy.contextWindow()).toBe(30_000); // max(budget, observed + reserve)
		expect(policy.contextWindow() * policy.threshold()).toBe(30_000);
		runtime.dispose();
	});

	it("resets observed capacity evidence on model change", async () => {
		const cwd = makeTempDir();
		const runtime = newRuntime(cwd, [replyWith({ input: 1, output: 1 })]);
		(runtime as any).observedContextMax = 50_000;
		const policy = (runtime as any)._buildCompactionPolicy(runtime.getProjection());
		expect(policy.contextWindow()).toBe(50_000);
		// New model: catalog for the new window overrides via contextBudget,
		// and old observed evidence must not leak into the new basis.
		runtime.setModel("test", "other-model", 20_000);
		expect((runtime as any).observedContextMax).toBe(0);
		// Budget re-pins to the new model window; old evidence cleared.
		const policy2 = (runtime as any)._buildCompactionPolicy(runtime.getProjection());
		expect(policy2.contextWindow()).toBe(20_000);
		runtime.dispose();
	});
});
