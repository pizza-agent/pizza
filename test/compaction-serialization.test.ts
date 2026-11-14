import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.js";
import { estimateStringTokens } from "../src/core/compaction/token-estimation.js";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should cap long tool-call arguments while keeping their names", () => {
		const longContent = "x".repeat(5_000);
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc1",
						name: "_write",
						arguments: { path: "src/big.ts", content: longContent },
					},
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("_write(");
		expect(result).toContain('path="src/big.ts"');
		expect(result).toContain("more characters truncated");
		expect(result).not.toContain(longContent);
		// The full payload is ~5k chars; the serialized call should be much smaller.
		expect(estimateStringTokens(result)).toBeLessThan(
			estimateStringTokens(longContent) / 4,
		);
	});

	it("should cap long assistant thinking", () => {
		const longThinking = "t".repeat(5_000);
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: longThinking }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Assistant thinking]:");
		expect(result).toContain("more characters truncated");
		expect(result).not.toContain(longThinking);
		expect(estimateStringTokens(result)).toBeLessThan(
			estimateStringTokens(longThinking) / 2,
		);
	});

	it("should not truncate short tool-call arguments", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc1",
						name: "_read",
						arguments: { path: "src/small.ts", offset: 10 },
					},
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain('_read(path="src/small.ts", offset=10)');
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
