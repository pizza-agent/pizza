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
