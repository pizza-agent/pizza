/**
 * Session Projection Types
 *
 * Session is a query view over the EventStore, not a data holder.
 */

import type { EventBase } from "../event-store/types.js";

// ============================================================================
// Session Descriptor
// ============================================================================

/** Session definition - pure reference structure */
export interface SessionDescriptor {
	session_id: string;
	thread_id: string;
	workspace_id: string;
	/** Event range covered by this session [start, end] (inclusive) */
	event_range: {
		start_event_id: string;
		end_event_id: string; // "HEAD" = tracking latest
	};
	/** Summary reference (compaction event_id) */
	summary_event_id?: string;
	/** User-defined name */
	name?: string;
	/** Creation method */
	created_by: "user_explicit" | "fork" | "schedule";
	/** Boundary inference reason */
	boundary_reason?: "intent_shift" | "file_drift" | "user_explicit";
	/** Parent session (fork source) */
	parent_session_id?: string;
	/** Session whose closed history should be prepended when building context. */
	context_parent_session_id?: string;
	/**
	 * Cross-workspace fork provenance (zero-copy fork). When set, buildContext
	 * opens the SOURCE workspace's event store read-only and prepends the
	 * source session's context up to `fork_at_event_id` instead of the events
	 * having been cloned into this workspace's log. If the source store is
	 * gone (workspace deleted), context degrades to starting at this session's
	 * own range — never an error.
	 */
	source_ref?: SessionSourceRef;
	/** Creation timestamp */
	created_at: number;
}

/** Reference to a fork source in another workspace (see SessionDescriptor.source_ref). */
export interface SessionSourceRef {
	workspace_id: string;
	session_id: string;
	/** Source events up to AND INCLUDING this event id participate in context. */
	fork_at_event_id: string;
}

// ============================================================================
// Thread Descriptor
// ============================================================================

/**
 * A conversation thread — the isolation unit.
 *
 * One thread = one `thread_id` on events. Threads are fixed once created;
 * session splitting happens at session level (within a thread), never at thread level.
 * A thread contains a tree of sessions (branches from rewind/fork).
 */
export interface ThreadDescriptor {
	thread_id: string;
	workspace_id: string;
	/** User-defined name (e.g. "Q3 marketing") */
	name?: string;
	/** Creation timestamp */
	created_at: number;
	/** Lifecycle status. active = ongoing interaction; background = scheduler/automation thread (never auto-selected as the active thread on reload); closed = user-ended. */
	status: "active" | "background" | "closed";
}

/** Session index storage (threads + their session branches) */
export interface SessionIndex {
	threads: ThreadDescriptor[];
	sessions: SessionDescriptor[];
	/**
	 * Log sequence watermark: the highest event sequence whose effects are
	 * reflected in this snapshot. Loaders replay SESSION_* / THREAD_* events
	 * after this sequence to self-heal a snapshot that missed a persist.
	 * Absent in legacy snapshots (treated as "trust snapshot, replay nothing"
	 * only when no sequence information is available).
	 */
	watermark_sequence?: number;
}

// ============================================================================
// Build Context
// ============================================================================

/** Options for building LLM context */
export interface BuildContextOptions {
	/** Token budget */
	max_tokens?: number;
	/** Include tool execution details */
	include_tool_details?: boolean;
	/** Include file mutations */
	include_file_mutations?: boolean;
}

/** Built context result */
export interface BuiltContext {
	/** Messages for LLM consumption */
	messages: import("../agent/types.js").AgentMessage[];
	/** Raw events used to build context */
	events: EventBase[];
	/** Session descriptor */
	descriptor: SessionDescriptor;
	/**
	 * Number of leading entries in `events` that belong to the source/parent
	 * context (fork / session-split prefixes), not to this session's own event
	 * range. Compaction uses this to never "summarize away" prefix events —
	 * they are always injected verbatim by buildContext regardless of the
	 * compaction boundary — while still counting them in token accounting.
	 */
	contextPrefixEventCount: number;
}
