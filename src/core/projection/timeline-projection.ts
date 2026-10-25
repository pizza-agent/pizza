/**
 * Timeline Projection
 *
 * Derives a chronological activity timeline from events in the EventStore.
 * Used by UI layers to render a full activity feed (not just chat messages).
 *
 * The timeline includes:
 * - User messages
 * - Agent responses (summarized)
 * - Tool executions (with duration)
 * - File mutations
 * - Goal/Task lifecycle events
 * - Session boundaries
 * - Compaction markers
 */

import type { EventBase, EventType } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";

// ============================================================================
// Types
// ============================================================================

/** Timeline entry kind */
export type TimelineEntryKind =
	| "user_message"
	| "agent_message"
	| "tool_execution"
	| "file_mutation"
	| "goal_event"
	| "task_event"
	| "session_boundary"
	| "compaction"
	| "error"
	| "checkpoint"
	| "bash_command"
	| "user_action"
	| "runtime"
	| "other";

/** A single entry in the timeline */
export interface TimelineEntry {
	/** Underlying event ID */
	event_id: string;
	/** Timestamp (unix ms) */
	timestamp: number;
	/** Entry kind for rendering */
	kind: TimelineEntryKind;
	/** Short human-readable summary */
	summary: string;
	/** Actor that produced this event */
	actor_id: string;
	/** Optional duration in ms (for tool executions) */
	duration_ms?: number;
	/** Associated metadata (tool name, file path, goal/task id, etc.) */
	metadata?: Record<string, unknown>;
	/** Causal parent event_id */
	caused_by?: string;
}

/** Options for querying the timeline */
export interface TimelineQueryOptions {
	/** Only include entries after this timestamp */
	after_timestamp?: number;
	/** Only include entries before this timestamp */
	before_timestamp?: number;
	/** Only include specific kinds */
	kinds?: TimelineEntryKind[];
	/** Maximum number of entries */
	limit?: number;
	/** Thread filter (isolation key) */
	thread_id?: string;
}

// ============================================================================
// Event types we scan for the timeline
// ============================================================================

const TIMELINE_EVENT_TYPES: EventType[] = [
	"USER_MESSAGE",
	"AGENT_MESSAGE_END",
	"TOOL_EXECUTION_START",
	"TOOL_EXECUTION_END",
	"FILE_MUTATION_APPLIED",
	"GOAL_CREATED",
	"GOAL_PLANNED",
	"GOAL_COMPLETED",
	"GOAL_CANCELLED",
	"TASK_CREATED",
	"TASK_STARTED",
	"TASK_COMPLETED",
	"TASK_FAILED",
	"TASK_ACCEPTED",
	"SESSION_CREATED",
	"SESSION_BOUNDARY_INFERRED",
	"SESSION_FORKED",
	"COMPACTION_END",
	"COMPACTION_ABORTED",
	"AGENT_ERROR",
	"RUNTIME_ERROR",
	"CHECKPOINT_CREATED",
];

// ============================================================================
// Timeline Projection
// ============================================================================

/**
 * TimelineProjection builds a chronological activity feed from events.
 *
 * Usage:
 *   const timeline = new TimelineProjection(store);
 *   const entries = timeline.query({ limit: 50 });
 */
export class TimelineProjection {
	/** In-memory cache of tool start times (for duration calculation) */
	private toolStartTimes: Map<string, number> = new Map();

	constructor(private store: EventStore) {}

	/**
	 * Query the timeline.
	 */
	query(options?: TimelineQueryOptions): TimelineEntry[] {
		const events = this.store.query({
			types: TIMELINE_EVENT_TYPES,
			thread_id: options?.thread_id,
		});

		// Also fetch TOOL_EXECUTION_START events for duration calculation
		const toolStartEvents = this.store.query({ types: ["TOOL_EXECUTION_START"] });
		this.toolStartTimes.clear();
		for (const evt of toolStartEvents) {
			const payload = evt.payload as { tool_call_id?: string };
			if (payload.tool_call_id) {
				this.toolStartTimes.set(payload.tool_call_id, evt.timestamp);
			}
		}

		let entries = events
			.map((event) => this._eventToEntry(event))
			.filter((entry): entry is TimelineEntry => entry !== undefined);

		// Apply filters
		if (options?.after_timestamp) {
			entries = entries.filter((e) => e.timestamp > options.after_timestamp!);
		}
		if (options?.before_timestamp) {
			entries = entries.filter((e) => e.timestamp < options.before_timestamp!);
		}
		if (options?.kinds?.length) {
			entries = entries.filter((e) => options.kinds!.includes(e.kind));
		}
		if (options?.limit && entries.length > options.limit) {
			entries = entries.slice(-options.limit);
		}

		return entries;
	}

	/**
	 * Get the latest N timeline entries.
	 */
	latest(count: number): TimelineEntry[] {
		return this.query({ limit: count });
	}

	// =========================================================================
	// Event-to-Entry Conversion
	// =========================================================================

	private _eventToEntry(event: EventBase): TimelineEntry | undefined {
		switch (event.type) {
			case "USER_MESSAGE":
				return this._userMessage(event);
			case "AGENT_MESSAGE_END":
				return this._agentMessage(event);
			case "TOOL_EXECUTION_END":
				return this._toolExecution(event);
			case "FILE_MUTATION_APPLIED":
				return this._fileMutation(event);
			case "GOAL_CREATED":
			case "GOAL_PLANNED":
			case "GOAL_COMPLETED":
			case "GOAL_CANCELLED":
				return this._goalEvent(event);
			case "TASK_CREATED":
			case "TASK_STARTED":
			case "TASK_COMPLETED":
			case "TASK_FAILED":
			case "TASK_ACCEPTED":
				return this._taskEvent(event);
			case "SESSION_CREATED":
			case "SESSION_BOUNDARY_INFERRED":
			case "SESSION_FORKED":
				return this._sessionEvent(event);
			case "COMPACTION_END":
			case "COMPACTION_ABORTED":
				return this._compactionEvent(event);
			case "AGENT_ERROR":
			case "RUNTIME_ERROR":
				return this._errorEvent(event);
			case "CHECKPOINT_CREATED":
				return this._checkpointEvent(event);
			default:
				return undefined;
		}
	}

	private _userMessage(event: EventBase): TimelineEntry {
		const payload = event.payload as { content?: string };
		const text = typeof payload.content === "string" ? payload.content : "";
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "user_message",
			summary: text.length > 100 ? text.slice(0, 100) + "…" : text,
			actor_id: event.actor_id,
			caused_by: event.caused_by,
		};
	}

	private _agentMessage(event: EventBase): TimelineEntry {
		const payload = event.payload as {
			content?: Array<{ type: string; text?: string }>;
			stop_reason?: string;
			usage?: { total?: number };
		};
		const textBlocks = payload.content?.filter((b) => b.type === "text") ?? [];
		const firstText = textBlocks[0]?.text ?? "";
		const summary = firstText.length > 100 ? firstText.slice(0, 100) + "…" : firstText;
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "agent_message",
			summary: summary || `(${payload.stop_reason ?? "response"})`,
			actor_id: event.actor_id,
			caused_by: event.caused_by,
			metadata: { stop_reason: payload.stop_reason, tokens: payload.usage?.total },
		};
	}

	private _toolExecution(event: EventBase): TimelineEntry {
		const payload = event.payload as {
			tool_call_id?: string;
			tool_name?: string;
			is_error?: boolean;
		};
		const startTime = payload.tool_call_id
			? this.toolStartTimes.get(payload.tool_call_id)
			: undefined;
		const duration = startTime ? event.timestamp - startTime : undefined;
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "tool_execution",
			summary: `${payload.tool_name ?? "tool"}${payload.is_error ? " (error)" : ""}`,
			actor_id: event.actor_id,
			duration_ms: duration,
			caused_by: event.caused_by,
			metadata: { tool_name: payload.tool_name, is_error: payload.is_error },
		};
	}

	private _fileMutation(event: EventBase): TimelineEntry {
		const payload = event.payload as {
			path?: string;
			operation?: string;
			mutation?: { path?: string; operation?: string; diff?: string };
		};
		const path = payload.path ?? payload.mutation?.path ?? "file";
		const operation = payload.operation ?? payload.mutation?.operation ?? "modify";
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "file_mutation",
			summary: `${operation} ${path}`,
			actor_id: event.actor_id,
			caused_by: event.caused_by,
			metadata: { ...payload.mutation, ...payload, path, operation },
		};
	}

	private _goalEvent(event: EventBase): TimelineEntry {
		const payload = event.payload as { goal_id?: string; title?: string };
		const action = event.type.replace("GOAL_", "").toLowerCase();
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "goal_event",
			summary: `Goal ${action}: ${payload.title ?? payload.goal_id ?? ""}`,
			actor_id: event.actor_id,
			caused_by: event.caused_by,
			metadata: payload,
		};
	}

	private _taskEvent(event: EventBase): TimelineEntry {
		const payload = event.payload as { task_id?: string; title?: string };
		const action = event.type.replace("TASK_", "").toLowerCase();
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "task_event",
			summary: `Task ${action}: ${payload.title ?? payload.task_id ?? ""}`,
			actor_id: event.actor_id,
			caused_by: event.caused_by,
			metadata: payload,
		};
	}

	private _sessionEvent(event: EventBase): TimelineEntry {
		const payload = event.payload as { session_id?: string; reason?: string };
		const action = event.type.replace("SESSION_", "").toLowerCase();
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "session_boundary",
			summary: `Session ${action}${payload.reason ? `: ${payload.reason}` : ""}`,
			actor_id: event.actor_id,
			caused_by: event.caused_by,
			metadata: payload,
		};
	}

	private _compactionEvent(event: EventBase): TimelineEntry {
		const payload = event.payload as { summary?: string; tokens_before?: number; message?: string };
		const aborted = event.type === "COMPACTION_ABORTED";
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "compaction",
			summary: aborted
				? `Context compaction aborted${payload.message ? `: ${payload.message}` : ""}`
				: `Context compacted${payload.tokens_before ? ` (${payload.tokens_before} tokens)` : ""}`,
			actor_id: event.actor_id,
			caused_by: event.caused_by,
			metadata: payload,
		};
	}

	private _errorEvent(event: EventBase): TimelineEntry {
		const payload = event.payload as { error?: string; error_message?: string };
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "error",
			summary: payload.error_message ?? payload.error ?? "Runtime error",
			actor_id: event.actor_id,
			caused_by: event.caused_by,
			metadata: payload,
		};
	}

	private _checkpointEvent(event: EventBase): TimelineEntry {
		const payload = event.payload as { label?: string; checkpoint_id?: string };
		return {
			event_id: event.event_id,
			timestamp: event.timestamp,
			kind: "checkpoint",
			summary: `Checkpoint${payload.label ? `: ${payload.label}` : ""}`,
			actor_id: event.actor_id,
			caused_by: event.caused_by,
			metadata: payload,
		};
	}
}
