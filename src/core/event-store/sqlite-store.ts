import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { v7 as uuidv7 } from "uuid";
import type { EventBase, EventType } from "./types.js";
import type { EventAppendInput, EventQuery, EventStore, SubscribeOptions } from "./store.js";
import type { SessionIndex } from "../projection/types.js";
import type { SessionStore } from "./session-store.js";
import { SqliteSessionStore } from "./sqlite-session-store.js";
import { atomicWriteJson, getWorkspaceMetaPath } from "./workspace.js";
import { deriveWorkspaceId, getEventDatabasePath } from "./workspace.js";

const require = createRequire(import.meta.url);
type DatabaseSyncConstructor = typeof import("node:sqlite").DatabaseSync;
let DatabaseSyncCtor: DatabaseSyncConstructor | undefined;

type EventRow = {
	sequence: number;
	event_id: string;
	workspace_id: string;
	runtime_id: string;
	actor_id: string;
	timestamp: number;
	type: EventType;
	payload_json: string;
	caused_by: string | null;
	correlation_id: string | null;
	thread_id: string | null;
	schema_version: number;
	idempotency_key: string | null;
};

export class SqliteEventStore implements EventStore, SessionStore {
	private db: DatabaseSync;
	private subscribers: Map<
		number,
		{ handler: (event: EventBase) => void; options?: SubscribeOptions; afterSequence?: number }
	> = new Map();
	private nextSubId = 0;
	private sessionStore: SqliteSessionStore;

	private _nextSequence = 0;
	private _closed = false;

	readonly workspace_id: string;

	constructor(
		workspaceId: string,
		dbPath: string,
		private runtimeId = "local_runtime",
	) {
		this.workspace_id = workspaceId;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new (loadDatabaseSync())(dbPath);
		this._applyPragmas(dbPath);
		this._initSchema();
		this._nextSequence = this._dbMaxSequence() + 1;
		this.sessionStore = new SqliteSessionStore(this.db, workspaceId);
	}

	append(partial: EventAppendInput): EventBase {
		if (partial.idempotency_key) {
			const existing = this._getByIdempotencyKey(partial.idempotency_key);
			if (existing) return existing;
		}

		// AGENT_MESSAGE_CHUNK events are streaming-only: notify subscribers for
		// live UI rendering but do NOT persist. The complete message content is
		// captured by the subsequent AGENT_MESSAGE_END event (whose payload.content
		// holds the full LLM response), so persisting chunks is pure redundancy.
		// Historical replay / context rebuild / compaction all read END, never CHUNK.
		// Chunks must NOT consume a sequence number: they are never inserted, so
		// advancing _nextSequence here would fork the in-memory counter away from
		// the DB max used by _appendAutoSequence / appendBatch.
		if (partial.type === "AGENT_MESSAGE_CHUNK") {
			const event = this._normalizeEvent(partial, false);
			this._notify(event);
			return event;
		}

		let inserted: EventBase;
		if (partial.sequence === undefined) {
			// Auto-assigned sequence: compute atomically inside a write transaction
			// (BEGIN IMMEDIATE) to eliminate cross-process races on the unique
			// (workspace_id, sequence) index.
			inserted = this._appendAutoSequence(partial);
		} else {
			// Explicit sequence: insert directly. A duplicate sequence throws
			// UNIQUE constraint failed (intentional for import/replay misuse).
			const event = this._normalizeEvent(partial);
			this._insert(event);
			inserted = event;
		}

		const stored = this.get(inserted.event_id) ?? inserted;
		this._notify(stored);
		this._touchMetaOnMessage(stored.type);
		return stored;
	}

	appendBatch(partials: EventAppendInput[]): EventBase[] {
		const events: EventBase[] = [];
		const newEvents: EventBase[] = [];
		for (let attempt = 0; ; attempt++) {
			events.length = 0;
			newEvents.length = 0;

			try {
				this.db.exec("begin immediate");
				// Compute the starting sequence from the DB max inside the write
				// transaction to eliminate cross-process sequence races.
				let nextSequence = this._dbMaxSequence() + 1;
				for (const partial of partials) {
					if (partial.idempotency_key) {
						const existing = this._getByIdempotencyKey(partial.idempotency_key);
						if (existing) {
							events.push(existing);
							continue;
						}
					}
					const sequence = partial.sequence ?? nextSequence;
					nextSequence = Math.max(nextSequence, sequence + 1);
					const event = this._normalizeEvent({ ...partial, sequence });
					events.push(event);
					newEvents.push(event);
				}

				for (const event of newEvents) {
					this._insert(event);
				}
				this._nextSequence = nextSequence;
				this.db.exec("commit");
				break;
			} catch (error) {
				try { this.db.exec("rollback"); } catch { /* no active transaction */ }
				// Retry on write-lock contention (another process holds the lock),
				// backing off with jitter so concurrent writers do not collide again.
				if (isSqliteBusyError(error) && attempt < MAX_LOCK_RETRY_ATTEMPTS) {
					sleepSync(lockRetryDelayMs(attempt));
					continue;
				}
				throw error;
			}
		}

		for (const event of newEvents) {
			this._notify(event);
			this._touchMetaOnMessage(event.type);
		}

		return events.map((event) => this.get(event.event_id) ?? event);
	}

	/** Update workspace meta.json last_accessed_at when a message event is appended. */
	private _lastMetaTouch = 0;
	private _metaTouchTimer: ReturnType<typeof setTimeout> | undefined;

	private _touchMetaOnMessage(eventType: string): void {
		if (eventType !== "USER_MESSAGE" && eventType !== "AGENT_MESSAGE_START") return;
		// Throttle: last_accessed_at only feeds workspace-list recency sorting.
		// Without this, every message did a synchronous read+parse+write of
		// meta.json inside the append hot path.
		const now = Date.now();
		if (now - this._lastMetaTouch < 60_000) {
			// Trailing edge: a short conversation (< 60s) would otherwise only
			// record its FIRST message — recency sorting then lags by up to a
			// minute. Arm one deferred write for when the window closes.
			if (!this._metaTouchTimer) {
				const wait = 60_000 - (now - this._lastMetaTouch);
				this._metaTouchTimer = setTimeout(() => {
					this._metaTouchTimer = undefined;
					this._lastMetaTouch = Date.now();
					this._writeMetaTouch();
				}, wait);
				this._metaTouchTimer.unref?.();
			}
			return;
		}
		this._lastMetaTouch = now;
		this._writeMetaTouch();
	}

	private _writeMetaTouch(): void {
		try {
			const metaPath = getWorkspaceMetaPath(this.workspace_id);
			const raw = readFileSync(metaPath, "utf8");
			const meta = JSON.parse(raw) as { last_accessed_at?: number };
			meta.last_accessed_at = Date.now();
			// Atomic replace: other processes read this file concurrently and must
			// never observe a half-written meta.json.
			atomicWriteJson(metaPath, meta);
		} catch {
			// meta.json might not exist yet — ignore.
		}
	}

	query(filter: EventQuery): EventBase[] {
		// Reads on a closed store return empty — renderers (footer, projection)
		// can fire once more during shutdown after dispose() ran.
		if (this._closed) return [];
		const clauses = ["workspace_id = ?"];
		const params: SQLInputValue[] = [this.workspace_id];

		if (filter.after_sequence !== undefined) {
			clauses.push("sequence > ?");
			params.push(filter.after_sequence);
		}
		if (filter.before_sequence !== undefined) {
			clauses.push("sequence < ?");
			params.push(filter.before_sequence);
		}
		if (filter.after) {
			const after = this.get(filter.after);
			if (after) {
				clauses.push("sequence > ?");
				params.push(after.sequence);
			}
		}
		if (filter.before) {
			const before = this.get(filter.before);
			if (before) {
				clauses.push("sequence < ?");
				params.push(before.sequence);
			}
		}
		if (filter.types?.length) {
			clauses.push(`type in (${filter.types.map(() => "?").join(", ")})`);
			params.push(...filter.types);
		}
		if (filter.actor_ids?.length) {
			clauses.push(`actor_id in (${filter.actor_ids.map(() => "?").join(", ")})`);
			params.push(...filter.actor_ids);
		}
		if (filter.thread_id) {
			clauses.push("thread_id = ?");
			params.push(filter.thread_id);
		}
		if (filter.caused_by) {
			clauses.push(`event_id in (
				with recursive descendants(event_id) as (
					select event_id from events where workspace_id = ? and caused_by = ?
					union all
					select e.event_id from events e join descendants d on e.caused_by = d.event_id
					where e.workspace_id = ?
				)
				select event_id from descendants
			)`);
			params.push(this.workspace_id, filter.caused_by, this.workspace_id);
		}

		let sql = `select * from events where ${clauses.join(" and ")} order by sequence ${filter.reverse ? "desc" : "asc"}`;
		if (filter.limit && filter.limit > 0) {
			sql += " limit ?";
			params.push(filter.limit);
		}

		return this.db.prepare(sql).all(...params).map((row) => rowToEvent(row as EventRow));
	}

	get(event_id: string): EventBase | undefined {
		if (this._closed) return undefined;
		const row = this.db
			.prepare("select * from events where workspace_id = ? and event_id = ?")
			.get(this.workspace_id, event_id) as EventRow | undefined;
		return row ? rowToEvent(row) : undefined;
	}

	latest(count: number): EventBase[] {
		return this.query({ limit: count, reverse: true }).reverse();
	}

	getCausalChain(event_id: string): EventBase[] {
		const chain: EventBase[] = [];
		let currentId: string | undefined = event_id;
		while (currentId) {
			const event = this.get(currentId);
			if (!event) break;
			chain.unshift(event);
			currentId = event.caused_by;
		}
		return chain;
	}

	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		const subId = this.nextSubId++;
		// Resolve the `after` event_id to its log sequence ONCE at subscribe time.
		// Matching then compares sequences — the previous string comparison on
		// event_id only worked because uuidv7 happens to be time-ordered, and
		// broke for ids from another generator (or chunk ids never persisted).
		let afterSequence: number | undefined;
		if (options?.after) {
			afterSequence = this.get(options.after)?.sequence;
		}
		this.subscribers.set(subId, { handler, options, afterSequence });
		return () => this.subscribers.delete(subId);
	}

	get size(): number {
		if (this._closed) return 0;
		const row = this.db
			.prepare("select count(*) as count from events where workspace_id = ?")
			.get(this.workspace_id) as { count: number };
		return row.count;
	}

	get head(): string | undefined {
		if (this._closed) return undefined;
		const row = this.db
			.prepare("select event_id from events where workspace_id = ? order by sequence desc limit 1")
			.get(this.workspace_id) as { event_id: string } | undefined;
		return row?.event_id;
	}

	get head_sequence(): number {
		return this._nextSequence - 1;
	}

	close(): void {
		if (this._closed) return;
		this._closed = true;
		if (this._metaTouchTimer) {
			clearTimeout(this._metaTouchTimer);
			this._metaTouchTimer = undefined;
		}
		this.db.close();
	}

	getSessionIndex(): SessionIndex | undefined {
		if (this._closed) return undefined;
		return this.sessionStore.getSessionIndex();
	}

	saveSessionIndex(index: SessionIndex): void {
		this.sessionStore.saveSessionIndex(index);
	}

	// Enable WAL so external readers (GUI, ad-hoc sqlite3) do not block writes,
	// and retry transient lock contention instead of throwing SQLITE_BUSY. An
	// unhandled SQLITE_BUSY on the write path previously crashed the sidecar.
	private _applyPragmas(dbPath: string): void {
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec("PRAGMA synchronous = NORMAL");
		if (dbPath !== ":memory:") {
			this.db.exec("PRAGMA journal_mode = WAL");
		}
	}

	private _initSchema(): void {
		this.db.exec(`
			create table if not exists events (
				sequence integer not null,
				event_id text not null unique,
				workspace_id text not null,
				runtime_id text not null,
				actor_id text not null,
				timestamp integer not null,
				type text not null,
				payload_json text not null,
				caused_by text,
				correlation_id text,
				thread_id text,
				schema_version integer not null default 1,
				idempotency_key text
			);
			create index if not exists idx_events_workspace_sequence on events(workspace_id, sequence);
			create unique index if not exists uniq_events_workspace_sequence on events(workspace_id, sequence);
			create index if not exists idx_events_workspace_type_sequence on events(workspace_id, type, sequence);
			create index if not exists idx_events_caused_by on events(caused_by);
			create index if not exists idx_events_correlation on events(correlation_id);
			create unique index if not exists idx_events_workspace_idempotency
				on events(workspace_id, idempotency_key)
				where idempotency_key is not null;
		`);

		// Migrate legacy column name session_hint → thread_id.
		// session_hint was always NULL in shipped code (isolation was never active),
		// so this is a safe rename with no data loss.
		const columns = this.db.prepare("pragma table_info(events)").all() as Array<{ name: string }>;
		if (columns.some((c) => c.name === "session_hint") && !columns.some((c) => c.name === "thread_id")) {
			this.db.exec("alter table events rename column session_hint to thread_id");
		}
	}

	private _normalizeEvent(partial: EventAppendInput, consumeSequence = true): EventBase {
		const sequence = partial.sequence ?? this._nextSequence;
		if (consumeSequence && sequence >= this._nextSequence) {
			this._nextSequence = sequence + 1;
		}
		return {
			...partial,
			sequence,
			event_id: partial.event_id ?? uuidv7(),
			workspace_id: this.workspace_id,
			runtime_id: partial.runtime_id ?? this.runtimeId,
			timestamp: partial.timestamp ?? Date.now(),
			schema_version: partial.schema_version ?? 1,
		};
	}

	private _insert(event: EventBase): void {
		this.db.prepare(`
			insert into events (
				sequence, event_id, workspace_id, runtime_id, actor_id, timestamp, type,
				payload_json, caused_by, correlation_id, thread_id, schema_version, idempotency_key
			) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			event.sequence,
			event.event_id,
			event.workspace_id,
			event.runtime_id,
			event.actor_id,
			event.timestamp,
			event.type,
			JSON.stringify(event.payload),
			event.caused_by ?? null,
			event.correlation_id ?? null,
			event.thread_id ?? null,
			event.schema_version,
			event.idempotency_key ?? null,
		);
	}

	/**
	 * Append an event with an auto-assigned sequence, using `BEGIN IMMEDIATE`
	 * to acquire the write lock before computing `max(sequence) + 1` from the
	 * database. This makes the sequence allocation atomic across processes —
	 * no other writer can interleave between the max read and the insert, so
	 * the `uniq_events_workspace_sequence` constraint can never be violated
	 * for auto-assigned sequences. Retries on `database is locked` (SQLITE_BUSY)
	 * when another process holds the write lock beyond the busy_timeout.
	 */
	private _appendAutoSequence(partial: EventAppendInput): EventBase {
		for (let attempt = 0; ; attempt++) {
			try {
				this.db.exec("begin immediate");
				const sequence = this._dbMaxSequence() + 1;
				const event = this._normalizeEvent({ ...partial, sequence });
				this._insert(event);
				this._nextSequence = sequence + 1;
				this.db.exec("commit");
				return event;
			} catch (error) {
				try { this.db.exec("rollback"); } catch { /* no active transaction */ }
				if (isSqliteBusyError(error) && attempt < MAX_LOCK_RETRY_ATTEMPTS) {
					sleepSync(lockRetryDelayMs(attempt));
					continue;
				}
				throw error;
			}
		}
	}

	private _dbMaxSequence(): number {
		const row = this.db
			.prepare("select coalesce(max(sequence), 0) as sequence from events where workspace_id = ?")
			.get(this.workspace_id) as { sequence: number };
		return row.sequence;
	}

	private _getByIdempotencyKey(idempotencyKey: string): EventBase | undefined {
		const row = this.db
			.prepare("select * from events where workspace_id = ? and idempotency_key = ?")
			.get(this.workspace_id, idempotencyKey) as EventRow | undefined;
		return row ? rowToEvent(row) : undefined;
	}

	/**
	 * Fan out an event to subscribers. Each handler is isolated: a throwing
	 * subscriber must not prevent the remaining subscribers from seeing the
	 * event, and must not propagate out of append() and abort the caller
	 * (subscribers drive the reactor and the UI, so an exception here would
	 * otherwise break the agent turn). Mirrors the event-bus contract.
	 */
	private _notify(event: EventBase): void {
		for (const [, sub] of this.subscribers) {
			if (!matchesSubscription(event, sub.options, sub.afterSequence)) continue;
			try {
				sub.handler(event);
			} catch (error) {
				console.error(`Event subscriber error (${event.type}):`, error);
			}
		}
	}
}

function rowToEvent(row: EventRow): EventBase {
	return {
		sequence: row.sequence,
		event_id: row.event_id,
		workspace_id: row.workspace_id,
		runtime_id: row.runtime_id,
		actor_id: row.actor_id,
		timestamp: row.timestamp,
		type: row.type,
		payload: JSON.parse(row.payload_json) as unknown,
		caused_by: row.caused_by ?? undefined,
		correlation_id: row.correlation_id ?? undefined,
		thread_id: row.thread_id ?? undefined,
		schema_version: row.schema_version,
		idempotency_key: row.idempotency_key ?? undefined,
	};
}

/** Max retries after SQLITE_BUSY before giving up and rethrowing. */
const MAX_LOCK_RETRY_ATTEMPTS = 5;

/** Whether an error is SQLite reporting write-lock contention. */
function isSqliteBusyError(error: unknown): boolean {
	return error instanceof Error && /database is locked/.test(error.message);
}

/**
 * Block the calling thread for `ms` without spinning the CPU.
 *
 * The store API is synchronous (node:sqlite DatabaseSync), so `await` is not
 * available on this path. Atomics.wait on a throwaway SharedArrayBuffer is the
 * standard way to sleep synchronously; the wait never gets notified, so it
 * always runs to the timeout.
 */
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		// SharedArrayBuffer can be unavailable in restricted environments. Losing
		// the delay only costs us decorrelation, so proceeding is fine.
	}
}

/**
 * Decorrelated backoff between lock retries: 2ms, 4ms, 8ms… each with jitter.
 *
 * Note this is *not* about avoiding a busy-wait — `PRAGMA busy_timeout` already
 * makes SQLite block internally, so reaching SQLITE_BUSY means ~5s of
 * contention has already elapsed. The jitter exists so that several processes
 * released by the same commit do not all retry in lockstep and collide again
 * (thundering herd).
 */
function lockRetryDelayMs(attempt: number): number {
	const base = 2 * 2 ** attempt;
	return base + Math.random() * base;
}

function matchesSubscription(event: EventBase, options?: SubscribeOptions, afterSequence?: number): boolean {
	if (!options) return true;
	if (options.after) {
		// afterSequence was resolved at subscribe time. When the `after` event
		// could not be resolved (unknown id / never-persisted chunk id), fall
		// back to the legacy uuidv7 string ordering rather than dropping the
		// filter entirely.
		if (afterSequence !== undefined) {
			if (event.sequence <= afterSequence) return false;
		} else if (event.event_id <= options.after) {
			return false;
		}
	}
	if (options.after_sequence !== undefined && event.sequence <= options.after_sequence) return false;
	if (options.types?.length && !options.types.includes(event.type)) return false;
	if (options.actor_ids?.length && !options.actor_ids.includes(event.actor_id)) return false;
	return true;
}

function loadDatabaseSync(): DatabaseSyncConstructor {
	if (!DatabaseSyncCtor) {
		try {
			DatabaseSyncCtor = (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync;
		} catch {
			// Bun (pre-1.4) doesn't implement node:sqlite. Fall back to bun:sqlite,
			// whose Database class exposes a compatible API (exec/prepare/all/get/run).
			const bunSqlite = require("bun:sqlite") as { Database: new (path: string) => DatabaseSync };
			DatabaseSyncCtor = bunSqlite.Database as unknown as DatabaseSyncConstructor;
		}
	}
	return DatabaseSyncCtor;
}

export function createEventStore(cwd: string, agentDir?: string, runtimeId?: string): SqliteEventStore {
	const workspaceId = deriveWorkspaceId(cwd);
	return new SqliteEventStore(workspaceId, getEventDatabasePath(workspaceId, agentDir), runtimeId);
}
