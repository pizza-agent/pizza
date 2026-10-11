/**
 * Provider-context sanitizer: repairs tool_use ↔ tool_result pairing in a
 * rebuilt message list.
 *
 * Why this exists: the event log is the source of truth, and turns can
 * interleave (historically two reactors could run concurrently; tool results
 * from a long-running tool land after other turns' messages). Providers with
 * strict adjacency rules (Anthropic/Bedrock) reject a context where a
 * toolResult does not directly follow the assistant message containing its
 * toolCall — "unexpected `tool_use_id` found in `tool_result` blocks" — which
 * poisons EVERY subsequent request from the log. The sanitizer makes any
 * rebuilt context well-formed regardless of what the log contains:
 *
 *   1. toolResults are repositioned to directly follow the assistant message
 *      containing their toolCall (batched together when several calls in one
 *      assistant message).
 *   2. toolResults whose toolCall no longer exists in the context (truncated
 *      or compacted away) are dropped.
 *   3. toolCalls with no toolResult (crash between intent and execution) get a
 *      synthetic "interrupted" result so the pairing is complete.
 *   4. Assistant messages with empty content AND no tool calls (failed LLM
 *      turns leave content:[] AGENT_MESSAGE_END events) are removed — they
 *      carry no information and can violate role alternation on strict APIs.
 */

import type { AgentMessage } from "../agent/index.js";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

function isAssistant(msg: AgentMessage): msg is AssistantMessage {
	return msg.role === "assistant";
}

function isToolResult(msg: AgentMessage): msg is ToolResultMessage {
	return msg.role === "toolResult";
}

function toolCallIds(msg: AgentMessage): string[] {
	if (!isAssistant(msg)) return [];
	// Defense: the event log can carry a stringified/malformed content payload
	// (e.g. a compaction artifact); never assume an array.
	if (!Array.isArray(msg.content)) return [];
	return msg.content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.map((block) => block.id);
}

/**
 * Repair tool_use ↔ tool_result pairing in place. Returns the sanitized list
 * (same array or a rebuilt one). Non-LLM messages (bashExecution, custom,
 * compactionSummary, …) keep their relative order.
 */
export function sanitizeToolPairing(messages: AgentMessage[]): AgentMessage[] {
	// Pass 0: index of toolCallId → assistant message position.
	const callOwner = new Map<string, number>();
	const out: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;
		out.push(msg);
		if (isAssistant(msg)) {
			for (const id of toolCallIds(msg)) {
				// First assistant message wins; duplicate ids should not exist.
				if (!callOwner.has(id)) callOwner.set(id, i);
			}
		}
	}

	// Pass 1: collect toolResults grouped by their owning assistant position,
	// dropping orphans and remembering insertion order.
	const resultsByOwner = new Map<number, ToolResultMessage[]>();
	const retained: boolean[] = out.map(() => false);
	for (let i = 0; i < out.length; i++) {
		const msg = out[i]!;
		if (!isToolResult(msg)) continue;
		const owner = callOwner.get(msg.toolCallId);
		if (owner === undefined) continue; // orphan: toolCall not in context → drop
		retained[i] = true;
		const bucket = resultsByOwner.get(owner);
		if (bucket) bucket.push(msg);
		else resultsByOwner.set(owner, [msg]);
	}

	// Pass 2: rebuild. For each assistant message with tool calls, emit it,
	// then exactly the toolResults covering its calls (existing ones in event
	// order, synthetic "interrupted" results for any missing). Drop the
	// original toolResult positions and empty failed-turn assistant messages.
	const result: AgentMessage[] = [];
	for (let i = 0; i < out.length; i++) {
		const msg = out[i]!;
		if (isToolResult(msg)) continue; // re-emitted after its owner below
		result.push(msg);
		if (!isAssistant(msg)) continue;

		const calls = toolCallIds(msg);
		if (calls.length === 0) {
			// Failed-turn artifact: assistant message with neither text/thinking
			// content nor tool calls. Keep only if it carries any content.
			const rawContent: unknown = msg.content;
			const hasContent = Array.isArray(rawContent) ? rawContent.length > 0 : typeof rawContent === "string" && rawContent.length > 0;
			if (!hasContent) result.pop();
			continue;
		}
		const results = resultsByOwner.get(i) ?? [];
		const seen = new Set<string>();
		for (const r of results) {
			result.push(r);
			seen.add(r.toolCallId);
		}
		for (const id of calls) {
			if (seen.has(id)) continue;
			// Crash between intent and execution: synthesize a terminal result so
			// strict providers accept the pairing.
			result.push({
				role: "toolResult",
				toolCallId: id,
				toolName: "",
				content: [{ type: "text", text: "Tool execution was interrupted before a result was recorded." }],
				isError: true,
				timestamp: msg.timestamp,
			} satisfies ToolResultMessage);
		}
	}
	return result;
}