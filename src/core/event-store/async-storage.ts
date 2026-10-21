import type { EventBase } from "./types.js";
import type { SessionIndex } from "../projection/types.js";
import type { EventStore } from "./store.js";
import type { SessionStore } from "./session-store.js";

/** Authoritative, asynchronous event storage. A commit includes its index. */
export interface EventStorageSnapshot {
	events: EventBase[];
	index?: SessionIndex;
}
export interface EventRestoreOptions {
	/** Only stream events with a sequence greater than this (resume a verified projection cache). */
	afterSequence?: number;
}
export interface AsyncEventStorage {
	readonly workspace_id: string;
	/** Stable identity of this log (e.g. tenant/workspace/scope). Required to reuse a projection cache. */
	readonly identity?: string;
	load(): Promise<EventStorageSnapshot>;
	/** Optional bounded-memory restore, one page at a time. */
	restore?(accept: (page: EventBase[]) => void, options?: EventRestoreOptions): Promise<SessionIndex | undefined>;
	/** Committed event id at a sequence, used to verify a projection cache before resuming it. */
	eventIdAt?(sequence: number): Promise<string | undefined>;
	commit(events: EventBase[], index?: SessionIndex): Promise<void>;
	close(): Promise<void>;
}

/** Synchronous projections plus explicit asynchronous durability barriers.
 * append() stages an event; subscribers only receive committed events.
 * Call flush() before acknowledging an operation, and closeAsync() at shutdown.
 */
export interface DurableEventStore extends EventStore, SessionStore {
	flush(): Promise<void>;
	onPersistenceError(handler: (error: Error) => void): () => void;
	closeAsync(): Promise<void>;
}
export type SessionEventStore = EventStore &
	SessionStore & {
		close?(): void;
		flush?(): Promise<void>;
		onPersistenceError?(handler: (error: Error) => void): () => void;
		closeAsync?(): Promise<void>;
	};
