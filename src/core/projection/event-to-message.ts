/**
 * Event to Message Converter
 *
 * Converts EventStore events to AgentMessage format for LLM consumption.
 */

import type { AgentMessage } from "../agent/types.js";
import type { TextContent, ImageContent, ThinkingContent, ToolCall, Usage, StopReason, Api, ProviderId } from "@earendil-works/pi-ai/compat";
import type { EventBase } from "../event-store/types.js";
import type {
	ToolExecutionEndEvent,
	UserMessageEvent,
	AgentMessageEndEvent,
	BashExecutionEvent,
	CustomMessageEvent,
	BranchSummaryEvent,
	CompactionEndEvent,
	FileMutationAppliedEvent,
} from "../event-store/events.js";

// ============================================================================
// Event to Message Conversion
// ============================================================================

/**
 * Convert events to messages for LLM context.
 *
 * Handles:
 * - USER_MESSAGE → user message
 * - AGENT_MESSAGE_END → assistant message
 * - TOOL_EXECUTION_END → tool result message
 * - COMPACTION_END → system summary message
 * - FILE_MUTATION_APPLIED → custom notification message
 */
export function eventsToMessages(events: EventBase[]): AgentMessage[] {
	const messages: AgentMessage[] = [];

	for (const event of events) {
		const msg = eventToMessage(event);
		if (msg) {
			messages.push(msg);
		}
	}

	return messages;
}

/**
 * Convert a single event to an AgentMessage.
 * Returns null if the event doesn't produce a message.
 */
export function eventToMessage(event: EventBase): AgentMessage | null {
	switch (event.type) {
		case "USER_MESSAGE": {
			const payload = event.payload as UserMessageEvent["payload"];
			// Merge images into content array if present.
			// Event-store images use snake_case `mime_type`; pi-ai's ImageContent
			// uses camelCase `mimeType`. Convert here so the LLM payload builder
			// (openai-completions etc.) reads the correct field — otherwise it
			// emits `data:undefined;base64,...` and the provider returns 400.
			// Build attachment blocks (images + files). Files don't have an
			// SDK-level "FileContent" type in pi-ai, so we emit a synthetic text
			// block pointing at the absolute path; the agent's `read` tool
			// opens the file from there.
			let content: string | (TextContent | ImageContent)[] = payload.content as string | (TextContent | ImageContent)[];
			const images: ImageContent[] = [];
			const fileBlocks: TextContent[] = [];
			if (payload.images && payload.images.length > 0) {
				for (const img of payload.images) {
					images.push({
						type: "image" as const,
						data: img.data,
						mimeType: (img as { mimeType?: string; mime_type?: string }).mimeType ?? img.mime_type,
					});
				}
			}
			if (payload.files && payload.files.length > 0) {
				for (const file of payload.files) {
					const kb = file.size > 0 ? ` (${Math.max(1, Math.round(file.size / 1024))} KB)` : "";
					const mime = file.mimeType ? ` [${file.mimeType}]` : "";
					fileBlocks.push({
						type: "text",
						text: `[Attached file: ${file.absolutePath}${mime}${kb}]`,
					});
				}
			}
			if (images.length > 0 || fileBlocks.length > 0) {
				if (typeof content === "string") {
					content = [{ type: "text", text: content }, ...fileBlocks, ...images];
				} else {
					content = [...content, ...fileBlocks, ...images];
				}
			}
			return {
				role: "user",
				content,
				timestamp: event.timestamp,
			};
		}

		case "AGENT_MESSAGE_END": {
			const payload = event.payload as AgentMessageEndEvent["payload"];

			// Convert content - AGENT_MESSAGE_END from our event store
			// contains text/image blocks from the LLM response.
			// Defense: tolerate string content (compaction artifacts, older
			// event formats) instead of crashing the whole projection.
			const payloadContent: unknown = payload.content;
			const rawContent: unknown[] = Array.isArray(payloadContent)
				? payloadContent
				: typeof payloadContent === "string" && payloadContent.length > 0
					? [{ type: "text", text: payloadContent }]
					: [];
			const content: (TextContent | ThinkingContent | ToolCall)[] = rawContent
				.filter((block): block is TextContent | ThinkingContent | ToolCall => {
					const b = block as { type?: string };
					return b.type === "text" || b.type === "thinking" || b.type === "tool_call" || b.type === "toolCall";
				})
				.map((block) => {
					const blockType = (block as { type?: string }).type;
					if (blockType !== "tool_call" && blockType !== "toolCall") {
						return block;
					}
					const toolCall = block as {
						id?: string;
						tool_call_id?: string;
						name?: string;
						tool_name?: string;
						arguments?: unknown;
					};
					return {
						type: "toolCall",
						id: String(toolCall.id ?? toolCall.tool_call_id ?? ""),
						name: String(toolCall.name ?? toolCall.tool_name ?? ""),
						arguments: (toolCall.arguments as Record<string, unknown>) ?? {},
					} as ToolCall;
				});

			// Convert stop_reason to StopReason
			const stopReason: StopReason = (payload.stop_reason === "tool_use" ? "toolUse" : payload.stop_reason) as StopReason;

			// Convert TokenUsage to Usage
			const usage: Usage = {
				input: payload.usage.input,
				output: payload.usage.output,
				cacheRead: payload.usage.cache_read,
				cacheWrite: payload.usage.cache_write,
				totalTokens: payload.usage.total,
				cost: {
					input: payload.usage.cost * 0.5,
					output: payload.usage.cost * 0.5,
					cacheRead: 0,
					cacheWrite: 0,
					total: payload.usage.cost,
				},
			};

			return {
				role: "assistant",
				content,
				api: payload.model.provider as Api,
				provider: payload.model.provider as ProviderId,
				model: payload.model.model_id,
				usage,
				stopReason,
				errorMessage: payload.error_message,
				timestamp: event.timestamp,
			};
		}

		case "TOOL_EXECUTION_END": {
			const payload = event.payload as ToolExecutionEndEvent["payload"];
			const content = formatToolResult(payload.result, payload.is_error);
			return {
				role: "toolResult",
				toolCallId: payload.tool_call_id,
				toolName: payload.tool_name,
				content,
				isError: payload.is_error,
				details: payload.details,
				timestamp: event.timestamp,
			} as AgentMessage;
		}

		case "COMPACTION_END": {
			const payload = event.payload as CompactionEndEvent["payload"];
			return {
				role: "compactionSummary",
				summary: payload.summary,
				tokensBefore: payload.tokens_before,
				timestamp: event.timestamp,
			} as AgentMessage;
		}

		case "FILE_MUTATION_APPLIED": {
			const mutation = normalizeFileMutationPayload(event.payload as FileMutationAppliedEvent["payload"]);
			const operation = mutation.operation ?? "modify";
			const path = mutation.path ?? "file";
			return {
				role: "custom",
				customType: "runtime:file_mutation",
				content: `File ${operation}: ${path}`,
				display: true,
				details: mutation,
				timestamp: event.timestamp,
			} as AgentMessage;
		}

		case "BASH_EXECUTION": {
			const payload = event.payload as BashExecutionEvent["payload"];
			return {
				role: "bashExecution",
				command: payload.command,
				output: payload.output ?? "",
				stdout: payload.stdout,
				stderr: payload.stderr,
				exitCode: payload.exit_code,
				durationMs: payload.duration_ms,
				cwd: payload.cwd,
				cancelled: payload.cancelled ?? false,
				truncated: payload.truncated ?? false,
				fullOutputPath: payload.full_output_path,
				excludeFromContext: payload.exclude_from_context,
				timestamp: event.timestamp,
			} as AgentMessage;
		}

		case "CUSTOM_MESSAGE": {
			const payload = event.payload as CustomMessageEvent["payload"];
			// Transform event data into CustomMessage shape
			let content: string | (TextContent | ImageContent)[] = "";
			let details: unknown = payload.data;
			if (typeof payload.data === "string") {
				content = payload.data;
				details = undefined;
			} else if (Array.isArray(payload.data)) {
				content = payload.data as (TextContent | ImageContent)[];
			}
			return {
				role: "custom",
				customType: `${payload.extension_id}:${payload.kind}`,
				content,
				display: payload.display,
				details,
				timestamp: event.timestamp,
			} as AgentMessage;
		}

		case "BRANCH_SUMMARY": {
			const payload = event.payload as BranchSummaryEvent["payload"];
			return {
				role: "branchSummary",
				summary: payload.summary,
				fromId: payload.from_id,
				timestamp: event.timestamp,
			} as AgentMessage;
		}
		// Skip other event types - they don't produce messages
		default:
			return null;
	}
}

function normalizeFileMutationPayload(payload: FileMutationAppliedEvent["payload"]): {
	path?: string;
	operation?: string;
	diff?: string;
	toolCallId?: string;
	toolName?: string;
} {
	const nested = payload.mutation;
	return {
		path: payload.path ?? nested?.path,
		operation: payload.operation ?? nested?.operation,
		diff: payload.diff ?? nested?.diff,
		toolCallId: payload.tool_call_id,
		toolName: payload.tool_name,
	};
}

/**
 * Format tool result content for message.
 */
function formatToolResult(
	result: unknown[],
	is_error: boolean,
): (TextContent | ImageContent)[] {
	return result
		.filter((block): block is TextContent | ImageContent => {
			const b = block as { type?: string };
			return b.type === "text" || b.type === "image";
		})
		.map((block) => {
			if (block.type === "text") {
				return {
					type: "text",
					text: is_error ? `Error: ${block.text}` : block.text,
				} as TextContent;
			}
			return block;
		});
}

/**
 * Extract tool calls from content blocks.
 */
export function extractToolCalls(content: unknown[]): Array<{
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}> {
	const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

	for (const block of content) {
		const b = block as { type?: string; id?: string; tool_call_id?: string; name?: string; tool_name?: string; arguments?: unknown };
		if (b.type === "tool_call" || b.type === "toolCall") {
			calls.push({
				id: String(b.id ?? b.tool_call_id ?? ""),
				name: String(b.name ?? b.tool_name ?? ""),
				arguments: (b.arguments as Record<string, unknown>) ?? {},
			});
		}
	}

	return calls;
}

/**
 * Extract text content from a message.
 */
export function extractTextContent(content: string | unknown[]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => {
			const b = block as { type?: string; text?: string };
			return b.type === "text" && typeof b.text === "string";
		})
		.map((block) => block.text)
		.join(" ");
}
