/**
 * Concrete Event Payload Types
 *
 * Typed payloads for each EventType defined in types.ts.
 */

import type { EventBase } from "./types.js";

// ============================================================================
// User Events
// ============================================================================

/** User sends a message */
export interface UserMessageEvent extends EventBase {
	type: "USER_MESSAGE";
	payload: {
		content: string | import("./types.js").ContentBlock[];
		images?: import("./types.js").ImageContent[];
		/** Path-referenced files the agent can read with its own file tools. */
		files?: import("./types.js").FileAttachment[];
		/** Raw input before expansion */
		raw_input?: string;
	};
}

/** User approves a pending intent */
export interface UserApprovalEvent extends EventBase {
	type: "USER_APPROVAL";
	payload: {
		/** Approved intent event_id */
		intent_event_id: string;
	};
}

/** User rejects a pending intent */
export interface UserRejectionEvent extends EventBase {
	type: "USER_REJECTION";
	payload: {
		/** Rejected intent event_id */
		intent_event_id: string;
		reason?: string;
	};
}

/** User interrupts current execution */
export interface UserInterruptEvent extends EventBase {
	type: "USER_INTERRUPT";
	payload: {
		content?: string | import("./types.js").ContentBlock[];
		images?: import("./types.js").ImageContent[];
		files?: import("./types.js").FileAttachment[];
		reason?: string;
	};
}

/** User queues a follow-up message: delivered after the current turn completes (no interrupt). */
export interface UserFollowupQueuedEvent extends EventBase {
	type: "USER_FOLLOWUP_QUEUED";
	payload: {
		content: string | import("./types.js").ContentBlock[];
		images?: import("./types.js").ImageContent[];
		files?: import("./types.js").FileAttachment[];
	};
}

/** Follow-ups that were dropped (e.g. by a user interrupt) instead of delivered. */
export interface UserFollowupDroppedEvent extends EventBase {
	type: "USER_FOLLOWUP_DROPPED";
	payload: {
		/** event_ids of the USER_FOLLOWUP_QUEUED events that were discarded. */
		dropped_event_ids: string[];
		reason: string;
	};
}

/** User changes configuration */
export interface UserConfigChangeEvent extends EventBase {
	type: "USER_CONFIG_CHANGE";
	payload: {
		key: string;
		old_value: unknown;
		new_value: unknown;
	};
}

// ============================================================================
// Agent Events (LLM Output)
// ============================================================================

/** LLM thinking starts */
export interface AgentThinkingStartEvent extends EventBase {
	type: "AGENT_THINKING_START";
	payload: {
		model?: string;
	};
}

/** LLM thinking ends */
export interface AgentThinkingEndEvent extends EventBase {
	type: "AGENT_THINKING_END";
	payload: {
		duration_ms?: number;
	};
}

/** LLM message starts streaming */
export interface AgentMessageStartEvent extends EventBase {
	type: "AGENT_MESSAGE_START";
	payload: {
		model: { provider: string; model_id: string };
	};
}

/** LLM message chunk (streaming) */
export interface AgentMessageChunkEvent extends EventBase {
	type: "AGENT_MESSAGE_CHUNK";
	payload: {
		/**
		 * A single streaming chunk. Shape matches `LLMChunk` from `runtime/llm-types.ts`.
		 * Kept as `unknown` here to avoid a cross-package type dependency; consumers
		 * should narrow on `chunk.kind`.
		 */
		chunk: unknown;
	};
}

/** LLM produces assistant message (final, after streaming completes) */
export interface AgentMessageEndEvent extends EventBase {
	type: "AGENT_MESSAGE_END";
	payload: {
		content: import("./types.js").ContentBlock[];
		model: { provider: string; model_id: string };
		usage: import("./types.js").TokenUsage;
		stop_reason: "stop" | "tool_use" | "length" | "error" | "aborted";
		error_message?: string;
	};
}

/** Runtime-level agent error. Distinct from RUNTIME_ERROR, which is reserved for system/reactor failures. */
export interface AgentErrorEvent extends EventBase {
	type: "AGENT_ERROR";
	payload: {
		error: string;
		stack?: string;
		retryable?: boolean;
		/** Event that caused the agent error */
		causing_event_id?: string;
	};
}

/** Agent turn starts */
export interface AgentTurnStartEvent extends EventBase {
	type: "AGENT_TURN_START";
	payload: {
		message_count: number;
	};
}

/** Agent turn ends */
export interface AgentTurnEndEvent extends EventBase {
	type: "AGENT_TURN_END";
	payload: {
		tool_calls_count: number;
		duration_ms?: number;
	};
}

// ============================================================================
// Intent Events
// ============================================================================

/** LLM proposes a tool call (intent, not yet executed) */
export interface IntentToolCallEvent extends EventBase {
	type: "INTENT_TOOL_CALL";
	payload: {
		tool_call_id: string;
		tool_name: string;
		arguments: Record<string, unknown>;
		/** The AGENT_MESSAGE_END event that proposed this tool call. Lets
		 * TOOL_EXECUTION_END locate its TurnTracker directly instead of walking
		 * the causal chain (which breaks across forks) or scanning all trackers
		 * by tool_call_id (which mis-attributes on provider id collisions). */
		assistant_message_event_id: string;
		/** Whether user approval is required */
		requires_approval: boolean;
		/** Classification result */
		classification?: import("../intent/types.js").IntentClassification;
	};
}

/** LLM proposes a file edit (intent, not yet executed) */
export interface IntentFileEditEvent extends EventBase {
	type: "INTENT_FILE_EDIT";
	payload: {
		path: string;
		old_text: string;
		new_text: string;
		requires_approval: boolean;
	};
}

/** LLM proposes a command execution (intent, not yet executed) */
export interface IntentCommandExecEvent extends EventBase {
	type: "INTENT_COMMAND_EXEC";
	payload: {
		command: string;
		requires_approval: boolean;
	};
}

// ============================================================================
// Execution Events (Runtime Deterministic)
// ============================================================================

/** Runtime starts tool execution */
export interface ToolExecutionStartEvent extends EventBase {
	type: "TOOL_EXECUTION_START";
	payload: {
		tool_call_id: string;
		tool_name: string;
		arguments: Record<string, unknown>;
	};
}

/** Runtime tool execution update */
export interface ToolExecutionUpdateEvent extends EventBase {
	type: "TOOL_EXECUTION_UPDATE";
	payload: {
		tool_call_id: string;
		update: string;
		progress?: number;
	};
}

/** Runtime completes tool execution */
export interface ToolExecutionEndEvent extends EventBase {
	type: "TOOL_EXECUTION_END";
	payload: {
		tool_call_id: string;
		tool_name: string;
		result: import("./types.js").ContentBlock[];
		/** Optional structured payload for logs/UI. */
		details?: unknown;
		is_error: boolean;
		duration_ms: number;
		/** File mutations produced by this execution */
		file_mutations?: import("./types.js").FileMutation[];
	};
}

/** File mutation applied */
export interface FileMutationAppliedEvent extends EventBase {
	type: "FILE_MUTATION_APPLIED";
	payload: {
		/** Current flat payload shape emitted by the reactor. */
		path?: string;
		operation?: import("./types.js").FileMutation["operation"];
		diff?: string;
		/** Legacy nested payload shape accepted by projections. */
		mutation?: import("./types.js").FileMutation;
		tool_call_id?: string;
		tool_name?: string;
	};
}

/** Command executed */
export interface CommandExecutedEvent extends EventBase {
	type: "COMMAND_EXECUTED";
	payload: {
		command: string;
		exit_code: number;
		output: string;
		duration_ms: number;
	};
}


/**
 * Bash execution event - records a bash command run by the runtime/UI
 * (not a tool call from the LLM). Used for `!cmd` user shell-escapes
 * and other side-channel runs that still need to appear in the timeline.
 */
export interface BashExecutionEvent extends EventBase {
	type: "BASH_EXECUTION";
	payload: {
		command: string;
		output: string;
		stdout?: string;
		stderr?: string;
		exit_code?: number;
		duration_ms?: number;
		cwd?: string;
		cancelled?: boolean;
		truncated?: boolean;
		full_output_path?: string;
		exclude_from_context?: boolean;
	};
}

/**
 * Custom message event - extension-provided opaque payload that should
 * appear as a `CustomMessage` in the session timeline.
 */
export interface CustomMessageEvent extends EventBase {
	type: "CUSTOM_MESSAGE";
	payload: {
		extension_id: string;
		kind: string;
		data: unknown;
		display?: boolean | string;
	};
}

/**
 * Branch summary event - injected when switching branches; records
 * a textual summary of the branch that was left behind so the LLM
 * can stay oriented.
 */
export interface BranchSummaryEvent extends EventBase {
	type: "BRANCH_SUMMARY";
	payload: {
		summary: string;
		from_branch?: string;
		from_id?: string;
		to_branch?: string;
	};
}
// ============================================================================
// Session Lifecycle Events
// ============================================================================

/**
 * Session created.
 *
 * The payload carries the full descriptor so the session index is a pure
 * projection of the log: replaying SESSION_* / THREAD_* events rebuilds the
 * index without the snapshot. Older logs may lack the descriptor fields
 * (start_event_id etc.); the reducer falls back to the event envelope
 * (event_id / thread_id / timestamp) for those.
 */
export interface SessionCreatedEvent extends EventBase {
	type: "SESSION_CREATED";
	payload: {
		session_id: string;
		name?: string;
		created_by: "user_explicit" | "fork" | "schedule";
		parent_session_id?: string;
		context_parent_session_id?: string;
		/** Context window start boundary (event_id or "ORIGIN"). */
		start_event_id?: string;
		summary_event_id?: string;
		created_at?: number;
		/** Previously active session closed by this creation (its end boundary becomes this event). */
		closes_session_id?: string;
		/** Present when this creation also created a new thread record. */
		thread?: {
			thread_id: string;
			name?: string;
			created_at: number;
			status: "active" | "background" | "closed";
		};
		/** Cross-workspace fork provenance (zero-copy fork; see SessionDescriptor.source_ref). */
		source_ref?: { workspace_id: string; session_id: string; fork_at_event_id: string };
	};
}

/** Session boundary inferred */
export interface SessionBoundaryInferredEvent extends EventBase {
	type: "SESSION_BOUNDARY_INFERRED";
	payload: {
		reason: "intent_shift" | "file_drift" | "user_explicit";
		new_session_id: string;
	};
}

/** Session forked */
export interface SessionForkedEvent extends EventBase {
	type: "SESSION_FORKED";
	payload: {
		new_session_id: string;
		parent_session_id?: string;
		fork_at_event_id: string;
		/** Full descriptor fields for index replay (absent in older logs). */
		name?: string;
		start_event_id?: string;
		summary_event_id?: string;
		context_parent_session_id?: string;
		created_at?: number;
		/** Session whose end boundary was closed at this fork (absent when none). */
		closes_session_id?: string;
		/** Cross-workspace fork provenance (zero-copy fork; see SessionDescriptor.source_ref). */
		source_ref?: { workspace_id: string; session_id: string; fork_at_event_id: string };
	};
}

/** Agent jumped to another session in the history tree */
export interface SessionJumpedEvent extends EventBase {
	type: "SESSION_JUMPED";
	payload: {
		/** The session the agent jumped to (target in the history tree). */
		target_session_id: string;
		/** When the target was closed, the new session created to reopen it. */
		reopened_as?: string;
		reason?: string;
		direct?: boolean;
		background?: boolean;
		/** Session whose end boundary was closed by this jump (absent when none). */
		closes_session_id?: string;
	};
}

/** Session renamed (index projection event). */
export interface SessionRenamedEvent extends EventBase {
	type: "SESSION_RENAMED";
	payload: {
		session_id: string;
		name: string;
	};
}

/** Thread status changed (e.g. background thread promoted to active). */
export interface ThreadStatusChangedEvent extends EventBase {
	type: "THREAD_STATUS_CHANGED";
	payload: {
		thread_id: string;
		status: "active" | "background" | "closed";
	};
}

/** Legacy-compatible session tree entry stored in the event log. */
export interface SessionEntryAppendedEvent extends EventBase {
	type: "SESSION_ENTRY_APPENDED";
	payload: {
		session_id: string;
		entry: unknown;
		leaf_id?: string | null;
	};
}

// ============================================================================
// Compaction Events
// ============================================================================

/** Compaction starts */
export interface CompactionStartEvent extends EventBase {
	type: "COMPACTION_START";
	payload: {
		token_count: number;
		target_tokens?: number;
	};
}

/** Compaction completed */
export interface CompactionEndEvent extends EventBase {
	type: "COMPACTION_END";
	payload: {
		summary: string;
		first_kept_event_id: string;
		tokens_before: number;
		tokens_after?: number;
		/** "summary" (default) or "mask" (tool results replaced, nothing dropped) */
		mode?: "summary" | "mask";
		mask_before_event_id?: string;
		mask_min_chars?: number;
		masked_count?: number;
		/** Structured memory nodes extracted */
		memory_nodes?: import("./types.js").MemoryNodeRef[];
	};
}

/** Compaction was cancelled before producing a summary. */
export interface CompactionAbortedEvent extends EventBase {
	type: "COMPACTION_ABORTED";
	payload: {
		reason?: "user_cancelled" | "runtime_shutdown" | "error" | string;
		message?: string;
		/** COMPACTION_START event_id when known */
		started_event_id?: string;
		token_count?: number;
	};
}

// ============================================================================
// Runtime Events
// ============================================================================

/** Checkpoint created */
export interface CheckpointCreatedEvent extends EventBase {
	type: "CHECKPOINT_CREATED";
	payload: {
		checkpoint_id: string;
		event_count: number;
	};
}

/** Model changed */
export interface ModelChangedEvent extends EventBase {
	type: "MODEL_CHANGED";
	payload: {
		provider: string;
		model_id: string;
		previous_provider?: string;
		previous_model_id?: string;
	};
}

/** Thinking level changed */
export interface ThinkingLevelChangedEvent extends EventBase {
	type: "THINKING_LEVEL_CHANGED";
	payload: {
		level: string;
		previous_level?: string;
	};
}

/** Runtime error */
export interface RuntimeErrorEvent extends EventBase {
	type: "RUNTIME_ERROR";
	payload: {
		error: string;
		stack?: string;
		/** Event that caused the error */
		causing_event_id?: string;
	};
}

// ============================================================================
// Reactor Control Events (drive the event-driven state machine)
// ============================================================================

/**
 * Reactor decided this turn requires a new LLM call.
 *
 * Emitted by:
 *   - reactor entry after USER_MESSAGE
 *   - tool-aggregation handler after all TOOL_EXECUTION_END for a turn arrive
 *   - retry handler when a scheduled retry fires
 */
export interface AgentTurnRequestedEvent extends EventBase {
	type: "AGENT_TURN_REQUESTED";
	payload: {
		/** Why this turn was requested */
		reason: "user_message" | "tool_results" | "retry" | "steer" | "follow_up";
		/** Retry attempt counter (0 on first attempt) */
		retry_attempt?: number;
	};
}

/**
 * A complete agent turn (one or more LLM calls + tools) has settled. Terminal
 * for one user interaction unless a follow-up is queued.
 */
export interface AgentTurnCompletedEvent extends EventBase {
	type: "AGENT_TURN_COMPLETED";
	payload: {
		reason: "stop" | "length" | "aborted" | "error";
		error_message?: string;
	};
}

/**
 * Reactor wants the LLM client to make a call. Decoupled from AGENT_TURN_REQUESTED
 * so context-building, system prompt assembly, and compaction can intercede.
 */
export interface LlmCallRequestedEvent extends EventBase {
	type: "LLM_CALL_REQUESTED";
	payload: {
		message_count: number;
	};
}

/** LLM call failed (network/provider/transient). Distinct from a stop_reason="error" assistant message. */
export interface LlmCallFailedEvent extends EventBase {
	type: "LLM_CALL_FAILED";
	payload: {
		error: string;
		retryable: boolean;
		status_code?: number;
	};
}

/**
 * All tool executions for the originating assistant message have completed.
 * Emitted by the tool-aggregation handler when the expected count matches
 * received TOOL_EXECUTION_END events sharing the same caused_by.
 */
export interface ToolResultsAggregatedEvent extends EventBase {
	type: "TOOL_RESULTS_AGGREGATED";
	payload: {
		/** event_id of the AGENT_MESSAGE_END that produced these tool calls */
		assistant_message_event_id: string;
		tool_call_count: number;
		any_error: boolean;
	};
}

/** A retry has been scheduled. The retry handler will emit AGENT_TURN_REQUESTED after delay_ms. */
export interface RetryScheduledEvent extends EventBase {
	type: "RETRY_SCHEDULED";
	payload: {
		attempt: number;
		max_attempts: number;
		delay_ms: number;
		error_message: string;
	};
}

/** A scheduled or pending retry was cancelled. */
export interface RetryAbortedEvent extends EventBase {
	type: "RETRY_ABORTED";
	payload: {
		attempt?: number;
		reason?: "user_interrupt" | "non_retryable" | "runtime_shutdown" | string;
		error_message?: string;
		/** RETRY_SCHEDULED event_id when known */
		scheduled_event_id?: string;
	};
}

/** Compaction handler decided context is too large. Distinct from COMPACTION_START which records the actual run. */
export interface CompactionRequestedEvent extends EventBase {
	type: "COMPACTION_REQUESTED";
	payload: {
		reason: "manual" | "threshold" | "overflow";
		token_count: number;
	};
}

// ============================================================================
// Type Exports
// ============================================================================

/** All event types with their payloads */
export type TypedEvent =
	| UserMessageEvent
	| UserApprovalEvent
	| UserRejectionEvent
	| UserInterruptEvent
	| UserFollowupQueuedEvent
	| UserFollowupDroppedEvent
	| UserConfigChangeEvent
	| AgentTurnRequestedEvent
	| AgentTurnCompletedEvent
	| LlmCallRequestedEvent
	| LlmCallFailedEvent
	| ToolResultsAggregatedEvent
	| RetryScheduledEvent
	| RetryAbortedEvent
	| CompactionRequestedEvent
	| AgentThinkingStartEvent
	| AgentThinkingEndEvent
	| AgentMessageStartEvent
	| AgentMessageChunkEvent
	| AgentMessageEndEvent
	| AgentErrorEvent
	| AgentTurnStartEvent
	| AgentTurnEndEvent
	| IntentToolCallEvent
	| IntentFileEditEvent
	| IntentCommandExecEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| FileMutationAppliedEvent
	| CommandExecutedEvent
	| BashExecutionEvent
	| CustomMessageEvent
	| BranchSummaryEvent
	| SessionCreatedEvent
	| SessionBoundaryInferredEvent
	| SessionForkedEvent
	| SessionJumpedEvent
	| SessionRenamedEvent
	| ThreadStatusChangedEvent
	| SessionEntryAppendedEvent
	| CompactionStartEvent
	| CompactionEndEvent
	| CompactionAbortedEvent
	| CheckpointCreatedEvent
	| ModelChangedEvent
	| ThinkingLevelChangedEvent
	| RuntimeErrorEvent;
