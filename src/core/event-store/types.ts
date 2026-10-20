/**
 * Event-Sourced Runtime Types
 *
 * This module defines the core types for the event-sourced architecture.
 * All events are immutable, append-only, causally linked, and timestamped.
 */

// ============================================================================
// Core Types
// ============================================================================

/** All event base interface - immutable, append-only, causally linked */
export interface EventBase {
	/** Workspace-local monotonic sequence number */
	sequence: number;

	/** Global unique event ID (UUIDv7, time-ordered) */
	event_id: string;

	/** Workspace identifier (one cwd = one workspace) */
	workspace_id: string;

	/** Runtime instance that produced this event */
	runtime_id: string;

	/** Actor that produced this event */
	actor_id: ActorId;

	/** Unix ms timestamp */
	timestamp: number;

	/** Event type */
	type: EventType;

	/** Event payload (structure determined by type) */
	payload: unknown;

	/** Causal chain: event_id that triggered this event */
	caused_by?: string;

	/** Trace identifier for a user turn, scheduled tick, webhook, or goal run */
	correlation_id?: string;

	/** Thread this event belongs to (isolation key; one conversation = one thread_id). Events of a thread are visible only to that thread's sessions. */
	thread_id?: string;

	/** Event payload schema version */
	schema_version: number;

	/** Optional retry-safe deduplication key */
	idempotency_key?: string;
}

/** Actor identifier */
export type ActorId = "user" | "coder_agent" | "runtime" | "compactor" | string;

/** All event types */
export type EventType =
	// User Events
	| "USER_MESSAGE"
	| "USER_APPROVAL"
	| "USER_REJECTION"
	| "USER_INTERRUPT"
	| "USER_FOLLOWUP_QUEUED"
	| "USER_FOLLOWUP_DROPPED"
	| "USER_CONFIG_CHANGE"
	// Reactor control events (drive state transitions, no side effects themselves)
	| "AGENT_TURN_REQUESTED"
	| "AGENT_TURN_COMPLETED"
	| "LLM_CALL_REQUESTED"
	| "LLM_CALL_FAILED"
	| "TOOL_RESULTS_AGGREGATED"
	| "RETRY_SCHEDULED"
	| "RETRY_ABORTED"
	// Agent Events (LLM output)
	| "AGENT_THINKING_START"
	| "AGENT_THINKING_END"
	| "AGENT_MESSAGE_START"
	| "AGENT_MESSAGE_CHUNK"
	| "AGENT_MESSAGE_END"
	| "AGENT_TURN_START"
	| "AGENT_TURN_END"
	| "AGENT_ERROR"
	// Intent Events (LLM proposals)
	| "INTENT_TOOL_CALL"
	| "INTENT_FILE_EDIT"
	| "INTENT_COMMAND_EXEC"
	// Execution Events (runtime deterministic)
	| "TOOL_EXECUTION_START"
	| "TOOL_EXECUTION_UPDATE"
	| "TOOL_EXECUTION_END"
	| "FILE_MUTATION_APPLIED"
	| "BASH_EXECUTION"
	| "CUSTOM_MESSAGE"
	| "BRANCH_SUMMARY"
	| "COMMAND_EXECUTED"
	// Session Lifecycle
	| "SESSION_CREATED"
	| "SESSION_BOUNDARY_INFERRED"
	| "SESSION_FORKED"
	| "SESSION_JUMPED"
	| "SESSION_RENAMED"
	| "THREAD_STATUS_CHANGED"
	| "SESSION_ENTRY_APPENDED"
	// Compaction
	| "COMPACTION_REQUESTED"
	| "COMPACTION_START"
	| "COMPACTION_END"
	| "COMPACTION_ABORTED"
	// Runtime
	| "RUNTIME_STARTED"
	| "RUNTIME_PAUSED"
	| "RUNTIME_RESUMED"
	| "CHECKPOINT_CREATED"
	| "CHECKPOINT_RESTORED"
	| "CHECKPOINT_FAILED"
	| "MODEL_CHANGED"
	| "THINKING_LEVEL_CHANGED"
	| "RUNTIME_ERROR"
	// Goal Lifecycle
	| "GOAL_CREATED"
	| "GOAL_CLASSIFIED"
	| "GOAL_PLANNED"
	| "GOAL_PAUSED"
	| "GOAL_RESUMED"
	| "GOAL_COMPLETED"
	| "GOAL_CANCELLED"
	// Task Lifecycle
	| "TASK_CREATED"
	| "TASK_ASSIGNED"
	| "TASK_STARTED"
	| "TASK_PROGRESS"
	| "TASK_COMPLETED"
	| "TASK_FAILED"
	| "TASK_REWORK_REQUESTED"
	| "TASK_ACCEPTED"
	| "TASK_CANCELLED"
	// Browser (managed browser-use engine). Audit-only payloads: tab ids,
	// origins, action classes, outcomes. Never page content, snapshot text,
	// screenshot bytes, or frame-channel tokens. Excluded from LLM context
	// (see CONTEXT_RELEVANT_EVENT_TYPES allowlist).
	| "BROWSER_TAB_OPENED"
	| "BROWSER_TAB_ACTIVATED"
	| "BROWSER_TAB_CLOSED"
	| "BROWSER_NAVIGATED"
	| "BROWSER_ACTION"
	| "BROWSER_SESSION_ENDED";

// ============================================================================
// Supporting Types
// ============================================================================

/** Content block for messages */
export interface ContentBlock {
	type: "text" | "image" | "thinking" | "tool_call";
	[key: string]: unknown;
}

/** Token usage statistics */
export interface TokenUsage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	total: number;
	cost: number;
}

/** File mutation record */
export interface FileMutation {
	path: string;
	operation: "create" | "modify" | "delete";
	diff?: string;
}

/** Memory node reference */
export interface MemoryNodeRef {
	node_id: string;
	type: string;
}

/** Image content */
export interface ImageContent {
	type: "image";
	data: string;
	mime_type: string;
}

/**
 * File attachment content — a path reference to a file the agent can read
 * with its own file tools (read, bash, python-docx, etc.). Stored on disk
 * under <cwd>/.pizza/uploads/<ws>/<session>/<uuid>-<basename> by the
 * sidecar's save_upload handler; the agent gets the absolute path and
 * decides how to read it.
 */
export interface FileAttachment {
	type: "file";
	/** Absolute path the agent can read with file tools. */
	absolutePath: string;
	/** Best-effort MIME (may be empty when the OS didn't supply one). */
	mimeType: string;
	/** Original file name (basename). */
	name: string;
	/** File size in bytes. */
	size: number;
}
