import type { ContextUsage } from "../extensions/index.js";
import type { AgentMessage } from "../agent/types.js";

/** Token + cost + message-count statistics derived from a message list (no identity). */
export interface MessageStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
}

/**
 * Compute token/cost/message-count statistics from a list of agent messages.
 * Pure function — no facade, no identity fields. Callers needing sessionFile/
 * sessionId add them on top.
 */
export function computeMessageStats(messages: AgentMessage[]): MessageStats {
	const userMessages = messages.filter((m) => m.role === "user").length;
	const assistantMessages = messages.filter((m) => m.role === "assistant").length;
	const toolResults = messages.filter((m) => m.role === "toolResult").length;

	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		toolCalls += message.content.filter((block) => block.type === "toolCall").length;
		totalInput += message.usage?.input ?? 0;
		totalOutput += message.usage?.output ?? 0;
		totalCacheRead += message.usage?.cacheRead ?? 0;
		totalCacheWrite += message.usage?.cacheWrite ?? 0;
		totalCost += message.usage?.cost?.total ?? 0;
	}

	return {
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: messages.length,
		tokens: {
			input: totalInput,
			output: totalOutput,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
		},
		cost: totalCost,
	};
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}
