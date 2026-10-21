import { rmSync } from "node:fs";
import { SqliteEventStore, matchesSubscription } from "./sqlite-store.js";
import type { EventBase } from "./types.js";
import type { EventAppendInput, EventQuery, SubscribeOptions } from "./store.js";
import type { SessionIndex } from "../projection/types.js";
import type { AsyncEventStorage, DurableEventStore } from "./async-storage.js";

const PROJECTION_IDENTITY_KEY = "projection_source_identity";

function removeSqliteFiles(path: string) {
	for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
}

type Subscriber = { handler: (event: EventBase) => void; options?: SubscribeOptions; afterSequence?: number };

/** A rebuildable local projection (memory by default, or a disposable cache). The backend is the source of truth.
 * No network I/O blocks Node's event loop; dispatch follows durable commit.
 * A failed write poisons the instance: restart reloads committed state only.
 */
export class AsyncProjectionStore implements DurableEventStore {
	readonly workspace_id: string;
	private readonly projection: SqliteEventStore;
	private pending: EventBase[] = [];
	private indexDirty = false;
	private subscribers = new Set<Subscriber>();
	private errorListeners = new Set<(error: Error) => void>();
	private flushing?: Promise<void>;
	private scheduled = false;
	private failure?: Error;
	private closed = false;
	private closing?: Promise<void>;

	private constructor(
		private readonly backend: AsyncEventStorage,
		projection: SqliteEventStore,
	) {
		this.workspace_id = backend.workspace_id;
		this.projection = projection;
		// Subscribed only after restore, so replayed history is never re-committed.
		projection.subscribe((event) => {
			if (event.type === "AGENT_MESSAGE_CHUNK") this.notify(event);
			else {
				this.pending.push(structuredClone(event));
				this.schedule();
			}
		});
	}
	/**
	 * Restore a projection from the authoritative backend.
	 *
	 * With `reuseProjection` and a file `projectionPath`, a cache left by a previous
	 * instance is resumed only when it was built from the same log (`backend.identity`)
	 * and its head event is committed at the same sequence (`backend.eventIdAt`);
	 * then only newer events are streamed. Anything else (other scope, uncommitted
	 * tail, diverged history, unknown file) is discarded and rebuilt from scratch.
	 * The session index is always replaced by the backend copy.
	 */
	static async open(
		backend: AsyncEventStorage,
		options: { projectionPath?: string; reuseProjection?: boolean } = {},
	): Promise<AsyncProjectionStore> {
		const path = options.projectionPath ?? ":memory:";
		const create = () =>
			new SqliteEventStore(backend.workspace_id, path, "local_runtime", { touchWorkspaceMeta: false });
		let projection: SqliteEventStore | undefined;
		try {
			projection = create();
			let afterSequence = 0;
			const canReuse =
				options.reuseProjection === true &&
				path !== ":memory:" &&
				backend.identity !== undefined &&
				backend.eventIdAt !== undefined &&
				backend.restore !== undefined;
			if (canReuse) {
				const cachedIdentity = projection.getStoreMeta(PROJECTION_IDENTITY_KEY);
				const head = projection.head_sequence;
				const headId = projection.head;
				const valid =
					cachedIdentity === backend.identity &&
					(head === 0 || (headId !== undefined && (await backend.eventIdAt!(head)) === headId));
				if (valid) afterSequence = head;
				else if (cachedIdentity !== undefined || head > 0 || projection.getSessionIndex()) {
					projection.close();
					projection = undefined;
					removeSqliteFiles(path);
					projection = create();
				}
			} else if (path !== ":memory:" && (projection.head_sequence > 0 || projection.getSessionIndex())) {
				// Never silently trust stale contents without verification.
				throw Error("Projection cache is not empty; pass reuseProjection: true or use an empty file");
			}
			const target = projection;
			if (canReuse) target.setStoreMeta(PROJECTION_IDENTITY_KEY, backend.identity!);
			target.clearSessionIndex();
			if (backend.restore) {
				const index = await backend.restore(
					(page) => {
						target.appendBatch(page);
					},
					{ afterSequence },
				);
				if (index) target.saveSessionIndex(index);
			} else {
				const snapshot = await backend.load();
				if (snapshot.events.length) target.appendBatch(snapshot.events);
				if (snapshot.index) target.saveSessionIndex(snapshot.index);
			}
			return new AsyncProjectionStore(backend, target);
		} catch (error) {
			// Never let cleanup failures mask the original open/restore error.
			try {
				projection?.close();
			} catch {
				/* ignore */
			}
			await backend.close().catch(() => {});
			throw error;
		}
	}
	private check() {
		if (this.failure) throw this.failure;
		if (this.closed || this.closing) throw Error("Event store is closed");
	}
	append(event: EventAppendInput): EventBase {
		this.check();
		return this.projection.append(event);
	}
	appendBatch(events: EventAppendInput[]): EventBase[] {
		this.check();
		return this.projection.appendBatch(events);
	}
	query(query: EventQuery): EventBase[] {
		this.check();
		return this.projection.query(query);
	}
	get(id: string): EventBase | undefined {
		this.check();
		return this.projection.get(id);
	}
	latest(count: number): EventBase[] {
		this.check();
		return this.projection.latest(count);
	}
	getCausalChain(id: string): EventBase[] {
		this.check();
		return this.projection.getCausalChain(id);
	}
	get size() {
		return this.projection.size;
	}
	get head() {
		return this.projection.head;
	}
	get head_sequence() {
		return this.projection.head_sequence;
	}
	getSessionIndex() {
		this.check();
		return this.projection.getSessionIndex();
	}
	saveSessionIndex(index: SessionIndex) {
		this.check();
		this.projection.saveSessionIndex(index);
		// The SQLite projection merges (upserts) index rows and keeps the max
		// watermark; the backend replaces the stored index. Commit the merged
		// view at drain time so both sides keep identical semantics.
		this.indexDirty = true;
		this.schedule();
	}
	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		this.check();
		const sub: Subscriber = {
			handler,
			options,
			afterSequence: options?.after ? this.projection.get(options.after)?.sequence : undefined,
		};
		this.subscribers.add(sub);
		return () => {
			this.subscribers.delete(sub);
		};
	}
	onPersistenceError(handler: (error: Error) => void): () => void {
		this.errorListeners.add(handler);
		if (this.failure) handler(this.failure);
		return () => {
			this.errorListeners.delete(handler);
		};
	}
	private notify(event: EventBase) {
		for (const { handler, options, afterSequence } of this.subscribers) {
			if (!matchesSubscription(event, options, afterSequence)) continue;
			try {
				handler(event);
			} catch (error) {
				// Subscriber failures cannot undo committed events.
				console.error(`Event subscriber error (${event.type}):`, error);
			}
		}
	}
	private hasPending() {
		return this.pending.length > 0 || this.indexDirty;
	}
	/** Coalesce background commits: one microtask per burst of appends. */
	private schedule() {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (!this.closed && !this.failure) void this.flush().catch(() => {});
		});
	}
	/** Resolves once every event/index staged before this call is durable. */
	async flush(): Promise<void> {
		if (this.failure) throw this.failure;
		if (this.closed) throw Error("Event store is closed");
		for (;;) {
			// An in-flight drain may already have taken its last batch before
			// this caller's events were staged; wait for it, then re-check.
			if (this.flushing) {
				await this.flushing;
				continue;
			}
			if (this.failure) throw this.failure;
			if (!this.hasPending()) return;
			const drain = this.drain();
			this.flushing = drain;
			try {
				await drain;
			} finally {
				if (this.flushing === drain) this.flushing = undefined;
			}
		}
	}
	private async drain() {
		try {
			while (this.hasPending()) {
				const events = this.pending.splice(0);
				const index = this.indexDirty ? this.projection.getSessionIndex() : undefined;
				this.indexDirty = false;
				await this.backend.commit(events, index);
				for (const event of events) this.notify(event);
			}
		} catch (error) {
			this.failure = error instanceof Error ? error : Error(String(error));
			for (const listener of this.errorListeners) {
				try {
					listener(this.failure);
				} catch {
					/* Notify every waiter. */
				}
			}
			throw this.failure;
		}
	}
	/** Synchronous best-effort close for legacy dispose() paths; prefer closeAsync(). */
	close(): void {
		void this.closeAsync().catch((error) => {
			if (error !== this.failure) console.error("Event store close failed:", error);
		});
	}
	closeAsync(): Promise<void> {
		return (this.closing ??= (async () => {
			try {
				if (!this.failure) await this.flush();
			} finally {
				this.closed = true;
				this.subscribers.clear();
				this.errorListeners.clear();
				try {
					this.projection.close();
				} finally {
					await this.backend.close();
				}
			}
			// A poisoned store has already rejected its operations; report it once more
			// so hosts know staged events may not be durable.
			if (this.failure) throw this.failure;
		})());
	}
}