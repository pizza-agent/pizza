/**
 * Context sanitizer: repairs tool_use ↔ tool_result pairing in rebuilt
 * contexts.
 *
 * Regression backdrop: a cron/scheduler prompt arriving while a long tool ran
 * started a second concurrent turn; the first turn's TOOL_EXECUTION_END then
 * landed after other turns' messages, and every later request failed with
 * Anthropic 400 "unexpected tool_use_id found in tool_result blocks" —
 * permanently, until the poisoned range fell out of the context.
 */

import { describe, expect, it } from "vitest";
import { sanitizeToolPairing } from "../src/core/projection/context-sanitizer.js";
import type { AgentMessage } from "../src/core/agent/types.js";
import type { AssistantMessage, ToolResultMessage, Message } from "@earendil-works/pi-ai";

let n = 0;
function user(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: ++n * 1000 };
}
function assistant(toolCallIds: string[], text?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text", text }] : []),
			...toolCallIds.map((id) => ({ type: "toolCall", id, name: "cli", arguments: {} })),
		],
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: ++n * 1000,
	};
}
function toolResult(id: string, text = "ok"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "cli",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ++n * 1000,
	};
}

describe("sanitizeToolPairing", () => {
	it("keeps an already well-formed pairing untouched", () => {
		const input: AgentMessage[] = [
			user("hi"),
			assistant(["t1"], "call it"),
			toolResult("t1"),
			assistant([], "done"),
		];
		expect(sanitizeToolPairing(input)).toEqual(input);
	});

	it("repositions a toolResult that interleaved turns separated from its tool_use (the cron bug)", () => {
		// Turn A tool_use, then a concurrent turn B user+assistant, then A's result.
		const input: AgentMessage[] = [
			user("run tests"),
			assistant(["npm"], "running"),
			user("check progress"), // cron message arrived mid-tool
			assistant(["git"], "checking"),
			toolResult("git"),
			toolResult("npm", "1450 passed"), // landed late — was the 400 poison
			assistant([], "summary"),
		];
		const out = sanitizeToolPairing(input);
		const roles = out.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant", "toolResult", "assistant"]);
		// npm result must now sit directly after its assistant message.
		expect((out[2] as ToolResultMessage).toolCallId).toBe("npm");
		expect((out[5] as ToolResultMessage).toolCallId).toBe("git");
	});

	it("drops toolResults whose tool_use fell out of the context (compaction/truncation)", () => {
		const input: AgentMessage[] = [
			user("hi"),
			toolResult("ghost"), // its assistant message was compacted away
			assistant([], "done"),
		];
		const out = sanitizeToolPairing(input);
		expect(out.some((m) => m.role === "toolResult")).toBe(false);
	});

	it("synthesizes terminal results for tool_calls interrupted before execution (crash)", () => {
		const input: AgentMessage[] = [
			user("go"),
			assistant(["t1", "t2"]), // crash between intent and execution: no results at all
			user("next"),
		];
		const out = sanitizeToolPairing(input);
		expect(out[2]).toMatchObject({ role: "toolResult", toolCallId: "t1", isError: true });
		expect(out[3]).toMatchObject({ role: "toolResult", toolCallId: "t2", isError: true });
		// "next" stays after the synthesized results.
		expect(out[4]).toMatchObject({ role: "user" });
	});

	it("removes empty assistant messages left by failed LLM turns", () => {
		const input: AgentMessage[] = [
			user("hi"),
			{ role: "assistant", content: [], api: "anthropic", provider: "anthropic", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 } as AssistantMessage,
			assistant(["t1"]),
			toolResult("t1"),
		];
		const out = sanitizeToolPairing(input);
		expect(out.filter((m) => m.role === "assistant")).toHaveLength(1);
	});

	it("is idempotent", () => {
		const input: AgentMessage[] = [
			user("a"),
			assistant(["t1"]),
			user("b"),
			assistant(["t2"]),
			toolResult("t2"),
			toolResult("t1"),
		];
		const once = sanitizeToolPairing(input);
		expect(sanitizeToolPairing(once)).toEqual(once);
	});
});
describe("sanitizeToolPairing — malformed content defense", () => {
	it("does not crash on an assistant message with string content (compaction artifact)", () => {
		// Regression: projection crashed when a producer wrote a stringified
		// content payload; toolCallIds assumed Array.filter.
		const malformed = {
			role: "assistant",
			content: "I was going to call a tool, but the content got stringified.",
			timestamp: 999,
		} as unknown as AssistantMessage;
		const input: AgentMessage[] = [
			user("hi"),
			malformed,
			assistant(["t1"], "call it"),
			toolResult("t1"),
		];
		const out = sanitizeToolPairing(input);
		// String content counts as content → message retained, no calls to pair.
		expect(out).toHaveLength(4);
		expect(out[1]).toBe(malformed);
	});

	it("treats null/undefined assistant content as empty and drops the message", () => {
		const malformed = { role: "assistant", content: null, timestamp: 999 } as unknown as AssistantMessage;
		const input: AgentMessage[] = [user("hi"), malformed, assistant([], "ok")];
		const out = sanitizeToolPairing(input);
		expect(out).toHaveLength(2);
		expect(out[1]).toMatchObject({ role: "assistant" });
	});
});
