/**
 * ThreadScopedStore
 *
 * Wraps an EventStore to automatically tag every appended event with a
 * `thread_id`. This is the isolation mechanism for single-workspace
 * multi-thread: all threads share one SQLite event log, but each thread's
 * events are tagged, and SessionProjection.buildContext() filters by it.
 *
 * Read operations (query, get, subscribe, etc.) delegate to the inner store
 * unchanged — callers add `thread_id` to their own queries when needed.
 */

import type { EventBase } from "./types.js";
import type { EventAppendInput, EventQuery, EventStore, SubscribeOptions } from "./store.js";

export class ThreadScopedStore implements EventStore {
	constructor(
		private readonly inner: EventStore,
		private readonly threadId: string | (() => string | undefined),
	) {
		if (inner.flush) this.flush = () => inner.flush!();
		if (inner.onPersistenceError) this.onPersistenceError = (handler) => inner.onPersistenceError!(handler);
	}
	readonly flush?: () => Promise<void>;
	readonly onPersistenceError?: (handler: (error: Error) => void) => () => void;

	private _threadId(): string | undefined {
		return typeof this.threadId === "function" ? this.threadId() : this.threadId;
	}

	get workspace_id(): string {
		return this.inner.workspace_id;
	}

	append(event: EventAppendInput): EventBase {
		const threadId = this._threadId();
		return this.inner.append(threadId ? { ...event, thread_id: threadId } : event);
	}

	appendBatch(events: EventAppendInput[]): EventBase[] {
		const threadId = this._threadId();
		return this.inner.appendBatch(threadId ? events.map((e) => ({ ...e, thread_id: threadId })) : events);
	}

	query(filter: EventQuery): EventBase[] {
		return this.inner.query(filter);
	}

	get(event_id: string): EventBase | undefined {
		return this.inner.get(event_id);
	}

	latest(count: number): EventBase[] {
		return this.inner.latest(count);
	}

	getCausalChain(event_id: string): EventBase[] {
		return this.inner.getCausalChain(event_id);
	}

	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		return this.inner.subscribe(handler, options);
	}

	get size(): number {
		return this.inner.size;
	}

	get head(): string | undefined {
		return this.inner.head;
	}

	get head_sequence(): number {
		return this.inner.head_sequence;
	}
}
