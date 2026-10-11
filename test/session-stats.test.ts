import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/core/agent/types.js";
import { computeMessageStats } from "../src/core/session/session-stats.js";

// Test fixtures: minimal message shapes matching what computeMessageStats reads.
// Cast to AgentMessage (named type) because the full AssistantMessage requires
// fields (model, stopReason, ...) irrelevant to stats computation.
function userMsg(text: string): AgentMessage {
	return { role: "user", content: text } as unknown as AgentMessage;
}

function assistantMsg(opts: {
	text?: string;
	toolCalls?: number;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total: number } };
}): AgentMessage {
	const content: Array<Record<string, unknown>> = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	for (let i = 0; i < (opts.toolCalls ?? 0); i++) {
		content.push({ type: "toolCall", id: `tc-${i}`, name: "read", input: {} });
	}
	return { role: "assistant", content, usage: opts.usage } as unknown as AgentMessage;
}

function toolResultMsg(): AgentMessage {
	return { role: "toolResult", content: [{ type: "text", text: "ok" }] } as unknown as AgentMessage;
}

describe("computeMessageStats", () => {
	it("counts message roles and total", () => {
		const stats = computeMessageStats([
			userMsg("q1"),
			assistantMsg({ text: "a1" }),
			userMsg("q2"),
			assistantMsg({ toolCalls: 2 }),
			toolResultMsg(),
		]);
		expect(stats.userMessages).toBe(2);
		expect(stats.assistantMessages).toBe(2);
		expect(stats.toolResults).toBe(1);
		expect(stats.totalMessages).toBe(5);
	});

	it("counts tool calls across assistant messages", () => {
		const stats = computeMessageStats([
			assistantMsg({ toolCalls: 3 }),
			assistantMsg({ toolCalls: 1, text: "done" }),
		]);
		expect(stats.toolCalls).toBe(4);
	});

	it("sums token usage from assistant messages only", () => {
		const stats = computeMessageStats([
			userMsg("q"),
			assistantMsg({ usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 } }),
			assistantMsg({ usage: { input: 200, output: 30 } }),
		]);
		expect(stats.tokens.input).toBe(300);
		expect(stats.tokens.output).toBe(80);
		expect(stats.tokens.cacheRead).toBe(10);
		expect(stats.tokens.cacheWrite).toBe(5);
		expect(stats.tokens.total).toBe(395);
	});

	it("sums cost from usage.cost.total", () => {
		const stats = computeMessageStats([
			assistantMsg({ usage: { cost: { total: 0.01 } } }),
			assistantMsg({ usage: { cost: { total: 0.02 } } }),
		]);
		expect(stats.cost).toBeCloseTo(0.03, 5);
	});

	it("handles empty message list", () => {
		const stats = computeMessageStats([]);
		expect(stats.totalMessages).toBe(0);
		expect(stats.tokens.total).toBe(0);
		expect(stats.cost).toBe(0);
		expect(stats.toolCalls).toBe(0);
	});

	it("treats missing usage as zero", () => {
		const stats = computeMessageStats([assistantMsg({ text: "no usage" })]);
		expect(stats.tokens.input).toBe(0);
		expect(stats.cost).toBe(0);
	});
});
