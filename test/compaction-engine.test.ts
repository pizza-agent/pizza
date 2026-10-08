import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/core/event-store/sqlite-store.js";
import { SessionProjection } from "../src/core/projection/session-projection.js";
import { CompactionEngine } from "../src/core/compaction/compaction-engine.js";
import type { LLMClient, LLMResponse } from "../src/core/runtime/llm-types.js";
import type { SessionDescriptor } from "../src/core/projection/types.js";

function createProjection(store: SqliteEventStore): SessionProjection {
	const descriptor: SessionDescriptor = {
		session_id: "sess_test",
		workspace_id: store.workspace_id,
		event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
		created_by: "user_explicit",
		created_at: Date.now(),
	};
	return new SessionProjection(store, descriptor);
}

function appendAssistant(store: SqliteEventStore, text: string): void {
	store.append({
		actor_id: "coder_agent",
		type: "AGENT_MESSAGE_END",
		payload: {
			content: [{ type: "text", text }],
			model: { provider: "test", model_id: "test" },
			usage: { input: 100, output: 50, cache_read: 0, cache_write: 0, total: 150, cost: 0 },
			stop_reason: "stop",
		},
	});
}

function appendToolRound(store: SqliteEventStore, id: string, path: string, output: string) {
	store.append({
		actor_id: "coder_agent",
		type: "AGENT_MESSAGE_END",
		payload: {
			content: [{ type: "tool_call", id, name: "read", arguments: { path } }],
			model: { provider: "test", model_id: "test" },
			usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 },
			stop_reason: "tool_use",
		},
	});
	return store.append({
		actor_id: "runtime",
		type: "TOOL_EXECUTION_END",
		payload: { tool_call_id: id, tool_name: "read", result: [{ type: "text", text: output }], is_error: false, duration_ms: 1 },
	});
}

function failingLlm(): LLMClient & { calls: number } {
	const client = {
		calls: 0,
		async complete(): Promise<LLMResponse> {
			client.calls++;
			return {
				content: [{ type: "text", text: "## Goal\nLLM summary" }],
				provider: "test",
				model: "test",
				usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
				stopReason: "stop",
			};
		},
	};
	return client;
}

function toolResultTexts(projection: SessionProjection): string[] {
	return projection
		.buildContext()
		.messages.filter((m) => m.role === "toolResult")
		.map((m) => (m as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join(""));
}

describe("CompactionEngine tool-result masking", () => {
	function seed(store: SqliteEventStore) {
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "read the files" } });
		const big = appendToolRound(store, "call_big", "src/big.ts", "x".repeat(40_000));
		const small = appendToolRound(store, "call_small", "src/small.ts", "tiny");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "now continue" } });
		const recent = appendToolRound(store, "call_recent", "src/recent.ts", "y".repeat(2_000));
		appendAssistant(store, "done");
		return { big, small, recent };
	}

	it("hybrid: masks old large tool results without calling the LLM when that is enough", async () => {
		const store = new SqliteEventStore("compaction-mask", ":memory:");
		const { big } = seed(store);
		const llm = failingLlm();
		const projection = createProjection(store);
		const engine = new CompactionEngine({
			store,
			projection,
			llmClient: llm,
			model: { provider: "test", model_id: "test" },
			settings: { contextWindow: 20_000, reserveTokens: 0, keepRecentTokens: 1_000 },
		});

		const outcome = await engine.compact("threshold", new AbortController().signal);

		expect(llm.calls).toBe(0);
		expect(outcome.mode).toBe("mask");
		expect(outcome.masked_count).toBe(1);
		expect(outcome.tokens_after!).toBeLessThan(outcome.tokens_before);

		store.append({ actor_id: "compactor", type: "COMPACTION_END", payload: { ...outcome } });
		const texts = toolResultTexts(projection);
		expect(texts[0]).toContain("Tool result cleared");
		expect(texts[0]).toContain('path="src/big.ts"');
		expect(texts[1]).toBe("tiny");
		expect(texts[2]).toBe("y".repeat(2_000));
		// Nothing dropped, no summary message injected, raw event untouched
		const messages = projection.buildContext().messages;
		expect(messages.some((m) => m.role === "compactionSummary")).toBe(false);
		expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
		expect((store.get(big.event_id)!.payload as { result: Array<{ text: string }> }).result[0]!.text).toHaveLength(40_000);
		store.close();
	});

	it("hybrid: falls back to LLM summary when masking is not enough", async () => {
		const store = new SqliteEventStore("compaction-mask-fallback", ":memory:");
		seed(store);
		const llm = failingLlm();
		const engine = new CompactionEngine({
			store,
			projection: createProjection(store),
			llmClient: llm,
			model: { provider: "test", model_id: "test" },
			settings: { contextWindow: 100, reserveTokens: 0, keepRecentTokens: 100 },
		});

		const outcome = await engine.compact("threshold", new AbortController().signal);

		expect(llm.calls).toBe(1);
		expect(outcome.mode).toBeUndefined();
		expect(outcome.summary).toContain("LLM summary");
		store.close();
	});

	it("summary strategy never masks", async () => {
		const store = new SqliteEventStore("compaction-summary-only", ":memory:");
		seed(store);
		const llm = failingLlm();
		const engine = new CompactionEngine({
			store,
			projection: createProjection(store),
			llmClient: llm,
			model: { provider: "test", model_id: "test" },
			settings: { contextWindow: 20_000, reserveTokens: 0, keepRecentTokens: 1_000, strategy: "summary" },
		});

		const outcome = await engine.compact("manual", new AbortController().signal);
		expect(llm.calls).toBe(1);
		expect(outcome.mode).toBeUndefined();
		store.close();
	});

	it("mask boundaries never move backwards across compactions", async () => {
		const store = new SqliteEventStore("compaction-mask-monotonic", ":memory:");
		const { recent } = seed(store);
		const projection = createProjection(store);
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: { mode: "mask", summary: "", first_kept_event_id: "", tokens_before: 0, mask_before_event_id: recent.event_id, mask_min_chars: 500 },
		});
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: { mode: "mask", summary: "", first_kept_event_id: "", tokens_before: 0, mask_before_event_id: store.query({ types: ["USER_MESSAGE"] })[0]!.event_id, mask_min_chars: 500 },
		});
		const texts = toolResultTexts(projection);
		expect(texts[0]).toContain("Tool result cleared");
		expect(texts[2]).toBe("y".repeat(2_000));
		store.close();
	});
});

describe("CompactionEngine", () => {
	it("generates a summary and returns an event boundary without deleting events", async () => {
		const store = new SqliteEventStore("compaction-engine", ":memory:");
		const oldMessage = "old context ".repeat(80);
		const first = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: oldMessage } });
		appendAssistant(store, "old answer ".repeat(40));
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "recent request" } });
		appendAssistant(store, "recent answer");

		let prompt = "";
		const llmClient: LLMClient = {
			async complete(request): Promise<LLMResponse> {
				const message = request.messages[0];
				prompt = typeof message.content === "string" ? message.content : message.content.map((block) => "text" in block ? block.text : "").join("\n");
				return {
					content: [{ type: "text", text: "## Goal\nSummarized old context" }],
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const engine = new CompactionEngine({
			store,
			projection: createProjection(store),
			llmClient,
			model: { provider: "test", model_id: "test" },
			settings: { keepRecentTokens: 10 },
		});

		const result = await engine.compact("manual", new AbortController().signal);

		expect(result.summary).toContain("Summarized old context");
		expect(result.first_kept_event_id).toBe(kept.event_id);
		expect(result.tokens_before).toBeGreaterThan(0);
		expect(result.tokens_after).toBeGreaterThan(0);
		expect(store.get(first.event_id)).toBeDefined();
		expect(prompt).toContain("<conversation>");
		expect(prompt).toContain(oldMessage.trim());
		store.close();
	});

	it("updates an existing compaction summary on subsequent compactions", async () => {
		const store = new SqliteEventStore("compaction-engine-previous", ":memory:");
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "kept old request" } });
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: {
				summary: "Previous summary",
				first_kept_event_id: kept.event_id,
				tokens_before: 5000,
				tokens_after: 500,
			},
		});
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "new context ".repeat(80) } });
		appendAssistant(store, "new answer ".repeat(40));
		const recent = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "recent request" } });
		appendAssistant(store, "recent answer");

		let prompt = "";
		const llmClient: LLMClient = {
			async complete(request): Promise<LLMResponse> {
				const message = request.messages[0];
				prompt = typeof message.content === "string" ? message.content : message.content.map((block) => "text" in block ? block.text : "").join("\n");
				return {
					content: [{ type: "text", text: "Updated summary" }],
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, total: 2, cost: 0 },
					stopReason: "stop",
				};
			},
		};

		const engine = new CompactionEngine({
			store,
			projection: createProjection(store),
			llmClient,
			model: { provider: "test", model_id: "test" },
			settings: { keepRecentTokens: 10 },
		});

		const result = await engine.compact("threshold", new AbortController().signal);

		expect(result.summary).toBe("Updated summary");
		expect(result.first_kept_event_id).toBe(recent.event_id);
		expect(prompt).toContain("<previous-summary>");
		expect(prompt).toContain("Previous summary");
		store.close();
	});
});

describe("tool-result masking projection semantics", () => {
	function maskEnd(store: SqliteEventStore, beforeId: string, minChars: number) {
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: { mode: "mask", summary: "", first_kept_event_id: "", tokens_before: 0, mask_before_event_id: beforeId, mask_min_chars: minChars },
		});
	}

	it("a later mask with a higher min-chars does not un-mask earlier results", () => {
		const store = new SqliteEventStore("mask-min-chars", ":memory:");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "go" } });
		appendToolRound(store, "c1", "a.ts", "m".repeat(800));
		const next = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "next" } });
		maskEnd(store, next.event_id, 500);
		maskEnd(store, next.event_id, 5_000);
		expect(toolResultTexts(createProjection(store))[0]).toContain("Tool result cleared");
		store.close();
	});

	it("a summary compaction after a mask keeps masking the retained range and injects only the summary", () => {
		const store = new SqliteEventStore("mask-then-summary", ":memory:");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "old" } });
		const kept = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "kept" } });
		appendToolRound(store, "c1", "a.ts", "m".repeat(800));
		const next = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "next" } });
		maskEnd(store, next.event_id, 500);
		store.append({
			actor_id: "compactor",
			type: "COMPACTION_END",
			payload: { summary: "S", first_kept_event_id: kept.event_id, tokens_before: 1, tokens_after: 1 },
		});

		const projection = createProjection(store);
		const messages = projection.buildContext().messages;
		expect(messages.filter((m) => m.role === "compactionSummary")).toHaveLength(1);
		expect(JSON.stringify(messages)).not.toContain('"old"');
		expect(toolResultTexts(projection)[0]).toContain("Tool result cleared");
		store.close();
	});

	it("tool_use / tool_result pairing survives masking", () => {
		const store = new SqliteEventStore("mask-pairing", ":memory:");
		store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "go" } });
		appendToolRound(store, "c1", "a.ts", "m".repeat(800));
		const next = store.append({ actor_id: "user", type: "USER_MESSAGE", payload: { content: "next" } });
		maskEnd(store, next.event_id, 500);
		const messages = createProjection(store).buildContext().messages;
		const assistantIdx = messages.findIndex((m) => m.role === "assistant");
		const result = messages[assistantIdx + 1] as { role: string; toolCallId: string };
		expect(result.role).toBe("toolResult");
		expect(result.toolCallId).toBe("c1");
		store.close();
	});
});
