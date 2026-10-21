/**
 * EventStore Interface
 *
 * The single source of truth for all events in the event-sourced architecture.
 * All observable state can be derived from the event log.
 */

import type { EventBase, EventType } from "./types.js";

// ============================================================================
// Query & Subscription
// ============================================================================

/** EventStore query filter */
export interface EventQuery {
	/** Sequence range, workspace-local and monotonic */
	after_sequence?: number;
	before_sequence?: number;
	/** Time range (by event_id, UUIDv7 is time-ordered) */
	after?: string;
	before?: string;
	/** Filter by event types */
	types?: EventType[];
	/** Filter by actor */
	actor_ids?: string[];
	/** Filter by causal chain (return all descendants of this event) */
	caused_by?: string;
	/** Filter by thread (isolation key) */
	thread_id?: string;
	/** Maximum number of events to return */
	limit?: number;
	/** Return events in reverse order */
	reverse?: boolean;
}

/** EventStore subscription options */
export interface SubscribeOptions {
	/** Start receiving events after this event_id (exclusive) */
	after?: string;
	/** Start receiving events after this sequence (exclusive) */
	after_sequence?: number;
	/** Filter by event types */
	types?: EventType[];
	/** Filter by actor */
	actor_ids?: string[];
}

// ============================================================================
// EventStore Interface
// ============================================================================

/**
 * EventStore - the single source of truth for all events.
 *
 * Responsibilities:
 * - Append-only event storage
 * - Query by various filters
 * - Real-time subscription to new events
 * - Causal chain traversal
 */
export interface EventStore {
	/** Workspace identifier */
	readonly workspace_id: string;
	/** Optional durability barrier for asynchronous persistence backends. */
	flush?(): Promise<void>;
	onPersistenceError?(handler: (error: Error) => void): () => void;
	closeAsync?(): Promise<void>;

	/**
	 * Append a new event.
	 * Returns the complete event with generated event_id and timestamp.
	 */
	append(event: EventAppendInput): EventBase;

	/**
	 * Batch append multiple events.
	 * Returns the complete events with generated IDs and timestamps.
	 */
	appendBatch(events: EventAppendInput[]): EventBase[];

	/**
	 * Query events by filter.
	 */
	query(filter: EventQuery): EventBase[];

	/**
	 * Get a single event by ID.
	 */
	get(event_id: string): EventBase | undefined;

	/**
	 * Get the latest N events.
	 */
	latest(count: number): EventBase[];

	/**
	 * Get the causal chain from this event to root.
	 * Returns events in order from root to this event.
	 */
	getCausalChain(event_id: string): EventBase[];

	/**
	 * Subscribe to real-time events.
	 * Returns an unsubscribe function.
	 */
	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void;

	/** Current total event count */
	readonly size: number;

	/** Latest event_id, or undefined if empty */
	readonly head: string | undefined;

	/** Latest workspace-local sequence, or 0 if empty */
	readonly head_sequence: number;
}

export type EventAppendInput = Omit<
	EventBase,
	"event_id" | "timestamp" | "workspace_id" | "sequence" | "runtime_id" | "schema_version"
> & Partial<Pick<EventBase, "event_id" | "timestamp" | "sequence" | "runtime_id" | "schema_version">>;
