/**
 * ModeEventMapper
 *
 * Converts EventStore TypedEvents into mode-facing UI actions. Modes can render
 * these actions directly from the EventStore event stream.
 */

import type { AgentMessage } from "../core/agent/types.js";
import type { EventBase } from "../core/event-store/types.js";
import type { LLMChunk } from "../core/runtime/llm-types.js";
import { eventToMessage } from "../core/projection/event-to-message.js";

export type ModeEvent =
	| { type: "message_committed"; eventId: string; message: AgentMessage }
	| { type: "streaming_message_started"; eventId: string; model?: { provider: string; model_id: string } }
	| { type: "streaming_message_updated"; eventId: string; chunk: LLMChunk; delta?: string }
	| { type: "tool_started"; eventId: string; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "tool_updated"; eventId: string; toolCallId: string; update: string; progress?: number }
	| {
			type: "tool_finished";
			eventId: string;
			toolCallId: string;
			toolName: string;
			result: unknown;
			details?: unknown;
			isError: boolean;
			durationMs?: number;
	  }
	| { type: "turn_started"; eventId: string; messageCount: number }
	| { type: "turn_completed"; eventId: string; reason: string; errorMessage?: string }
	| { type: "compaction_started"; eventId: string; tokenCount: number; targetTokens?: number }
	| {
			type: "compaction_finished";
			eventId: string;
			summary: string;
			firstKeptEventId: string;
			tokensBefore: number;
			tokensAfter?: number;
	  }
	| { type: "compaction_aborted"; eventId: string; reason?: string; message?: string }
	| { type: "retry_scheduled"; eventId: string; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "retry_aborted"; eventId: string; attempt?: number; reason?: string; errorMessage?: string }
	| {
			type: "model_changed";
			eventId: string;
			provider: string;
			modelId: string;
			previousProvider?: string;
			previousModelId?: string;
	  }
	| { type: "thinking_level_changed"; eventId: string; level: string; previousLevel?: string }
	| { type: "runtime_error"; eventId: string; error: string; stack?: string }
	| { type: "agent_error"; eventId: string; error: string; stack?: string; retryable?: boolean }
	| { type: "session_split"; eventId: string; reason: string; newSessionId: string; name?: string };

export function mapTypedEventToModeEvents(event: EventBase): ModeEvent[] {
	const actions: ModeEvent[] = [];

	switch (event.type) {
		case "USER_MESSAGE":
		case "AGENT_MESSAGE_END":
		case "BASH_EXECUTION":
		case "CUSTOM_MESSAGE":
		case "BRANCH_SUMMARY":
		case "FILE_MUTATION_APPLIED": {
			appendMessageCommit(actions, event);
			break;
		}
		case "AGENT_MESSAGE_START": {
			const payload = event.payload as { model?: { provider: string; model_id: string } };
			actions.push({ type: "streaming_message_started", eventId: event.event_id, model: payload.model });
			break;
		}
		case "AGENT_MESSAGE_CHUNK": {
			const payload = event.payload as { chunk: LLMChunk };
			actions.push({
				type: "streaming_message_updated",
				eventId: event.event_id,
				chunk: payload.chunk,
				delta: getChunkDelta(payload.chunk),
			});
			break;
		}
		case "TOOL_EXECUTION_START": {
			const payload = event.payload as { tool_call_id: string; tool_name: string; arguments: Record<string, unknown> };
			actions.push({
				type: "tool_started",
				eventId: event.event_id,
				toolCallId: payload.tool_call_id,
				toolName: payload.tool_name,
				args: payload.arguments,
			});
			break;
		}
		case "TOOL_EXECUTION_UPDATE": {
			const payload = event.payload as { tool_call_id: string; update: string; progress?: number };
			actions.push({
				type: "tool_updated",
				eventId: event.event_id,
				toolCallId: payload.tool_call_id,
				update: payload.update,
				progress: payload.progress,
			});
			break;
		}
		case "TOOL_EXECUTION_END": {
			const payload = event.payload as {
				tool_call_id: string;
				tool_name: string;
				result: unknown;
				details?: unknown;
				is_error: boolean;
				duration_ms?: number;
			};
			actions.push({
				type: "tool_finished",
				eventId: event.event_id,
				toolCallId: payload.tool_call_id,
				toolName: payload.tool_name,
				result: payload.result,
				details: payload.details,
				isError: payload.is_error,
				durationMs: payload.duration_ms,
			});
			appendMessageCommit(actions, event);
			break;
		}
		case "AGENT_TURN_START": {
			const payload = event.payload as { message_count: number };
			actions.push({ type: "turn_started", eventId: event.event_id, messageCount: payload.message_count });
			break;
		}
		case "AGENT_TURN_COMPLETED": {
			const payload = event.payload as { reason: string; error_message?: string };
			actions.push({
				type: "turn_completed",
				eventId: event.event_id,
				reason: payload.reason,
				errorMessage: payload.error_message,
			});
			break;
		}
		case "COMPACTION_START": {
			const payload = event.payload as { token_count: number; target_tokens?: number };
			actions.push({
				type: "compaction_started",
				eventId: event.event_id,
				tokenCount: payload.token_count,
				targetTokens: payload.target_tokens,
			});
			break;
		}
		case "COMPACTION_END": {
			const payload = event.payload as {
				summary: string;
				first_kept_event_id: string;
				tokens_before: number;
				tokens_after?: number;
			};
			actions.push({
				type: "compaction_finished",
				eventId: event.event_id,
				summary: payload.summary,
				firstKeptEventId: payload.first_kept_event_id,
				tokensBefore: payload.tokens_before,
				tokensAfter: payload.tokens_after,
			});
			appendMessageCommit(actions, event);
			break;
		}
		case "COMPACTION_ABORTED": {
			const payload = event.payload as { reason?: string; message?: string };
			actions.push({ type: "compaction_aborted", eventId: event.event_id, reason: payload.reason, message: payload.message });
			break;
		}
		case "RETRY_SCHEDULED": {
			const payload = event.payload as {
				attempt: number;
				max_attempts: number;
				delay_ms: number;
				error_message: string;
			};
			actions.push({
				type: "retry_scheduled",
				eventId: event.event_id,
				attempt: payload.attempt,
				maxAttempts: payload.max_attempts,
				delayMs: payload.delay_ms,
				errorMessage: payload.error_message,
			});
			break;
		}
		case "RETRY_ABORTED": {
			const payload = event.payload as { attempt?: number; reason?: string; error_message?: string };
			actions.push({
				type: "retry_aborted",
				eventId: event.event_id,
				attempt: payload.attempt,
				reason: payload.reason,
				errorMessage: payload.error_message,
			});
			break;
		}
		case "MODEL_CHANGED": {
			const payload = event.payload as {
				provider: string;
				model_id: string;
				previous_provider?: string;
				previous_model_id?: string;
			};
			actions.push({
				type: "model_changed",
				eventId: event.event_id,
				provider: payload.provider,
				modelId: payload.model_id,
				previousProvider: payload.previous_provider,
				previousModelId: payload.previous_model_id,
			});
			break;
		}
		case "THINKING_LEVEL_CHANGED": {
			const payload = event.payload as { level: string; previous_level?: string };
			actions.push({
				type: "thinking_level_changed",
				eventId: event.event_id,
				level: payload.level,
				previousLevel: payload.previous_level,
			});
			break;
		}
		case "RUNTIME_ERROR": {
			const payload = event.payload as { error: string; stack?: string };
			actions.push({ type: "runtime_error", eventId: event.event_id, error: payload.error, stack: payload.stack });
			break;
		}
		case "AGENT_ERROR": {
			const payload = event.payload as { error: string; stack?: string; retryable?: boolean };
			actions.push({
				type: "agent_error",
				eventId: event.event_id,
				error: payload.error,
				stack: payload.stack,
				retryable: payload.retryable,
			});
			break;
		}
		case "SESSION_BOUNDARY_INFERRED": {
			const payload = event.payload as { reason: string; new_session_id: string };
			actions.push({
				type: "session_split",
				eventId: event.event_id,
				reason: payload.reason,
				newSessionId: payload.new_session_id,
			});
			break;
		}
	}

	return actions;
}

function appendMessageCommit(actions: ModeEvent[], event: EventBase): void {
	const message = eventToMessage(event);
	if (!message) return;
	actions.push({ type: "message_committed", eventId: event.event_id, message });
}

function getChunkDelta(chunk: LLMChunk): string | undefined {
	if ("delta" in chunk && typeof chunk.delta === "string") return chunk.delta;
	if ("content" in chunk && typeof chunk.content === "string") return chunk.content;
	return undefined;
}
