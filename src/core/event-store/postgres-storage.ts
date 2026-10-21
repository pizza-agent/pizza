import type { AsyncEventStorage, EventRestoreOptions, EventStorageSnapshot } from "./async-storage.js";
import type { EventBase } from "./types.js";
import type { SessionIndex } from "../projection/types.js";

/** Structural pg interfaces: applications supply their pool; CLI needs no pg dependency. */
export interface PostgresConnection {
	query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, any>[] }>;
	release(destroy?: boolean): void;
	on?(event: "error", listener: (error: Error) => void): unknown;
	removeListener?(event: "error", listener: (error: Error) => void): unknown;
}
export interface PostgresPool {
	connect(): Promise<PostgresConnection>;
}
export interface PostgresStorageOptions {
	tenantId: string;
	scopeId: string;
	workspaceId: string;
	/** Defaults to public; tests can use isolated schemas. */
	schema?: string;
	/** Optional server-controlled thread restriction, also applied to imports. */
	threadId?: string;
}

/** One leased connection per active scope, held under a PG advisory lock.
 * Different scopes are independent. A second writer for the same scope fails
 * instead of using an out-of-date projection. Release automatically on crash.
 */
export class PostgresEventStorage implements AsyncEventStorage {
	readonly workspace_id: string;
	readonly identity: string;
	private head = 0;
	private restored = false;
	private closed = false;
	private broken?: Error;
	private readonly scopes: string;
	private readonly events: string;
	private readonly key: string[];
	private readonly lock: string;
	private readonly connectionError = (error: Error) => {
		this.broken = error;
	};
	private constructor(
		private readonly connection: PostgresConnection,
		private readonly options: PostgresStorageOptions,
	) {
		const schema = options.schema ?? "public";
		this.scopes = `"${schema}".pizza_event_scopes`;
		this.events = `"${schema}".pizza_events`;
		this.workspace_id = options.workspaceId;
		this.key = [options.tenantId, options.workspaceId, options.scopeId];
		this.lock = JSON.stringify([schema, ...this.key]);
		this.identity = `postgres:${this.lock}`;
		connection.on?.("error", this.connectionError);
	}
	static async open(pool: PostgresPool, options: PostgresStorageOptions): Promise<PostgresEventStorage> {
		if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.schema ?? "public")) throw Error("Invalid event schema");
		if (
			![options.tenantId, options.workspaceId, options.scopeId].every(
				(s) => typeof s === "string" && s.length > 0 && s.length <= 512 && !s.includes("\0"),
			)
		)
			throw Error("Invalid event scope");
		const connection = await pool.connect();
		const backend = new PostgresEventStorage(connection, options);
		try {
			await backend.initialize();
			return backend;
		} catch (error) {
			connection.removeListener?.("error", backend.connectionError);
			connection.release(true); // Also releases any acquired advisory lock.
			throw error;
		}
	}
	private check() {
		if (this.broken) throw this.broken;
		if (this.closed) throw Error("Postgres event storage is closed");
	}
	private async initialize() {
		await this.connection.query("BEGIN");
		try {
			// Serialize DDL across concurrent first-use scopes (including pg_type creation).
			await this.connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
				`pizza:event-schema:${this.options.schema ?? "public"}`,
			]);
			await this.connection.query(`CREATE TABLE IF NOT EXISTS ${this.scopes} (
				tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL,
				head_sequence BIGINT NOT NULL DEFAULT 0, index_json TEXT, legacy_imported BOOLEAN NOT NULL DEFAULT FALSE,
				PRIMARY KEY(tenant_id,workspace_id,scope_id));
				CREATE TABLE IF NOT EXISTS ${this.events} (
				tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, scope_id TEXT NOT NULL,
				sequence BIGINT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL,
				thread_id TEXT, caused_by TEXT, idempotency_key TEXT, event_json TEXT NOT NULL,
				PRIMARY KEY(tenant_id,workspace_id,scope_id,sequence),
				UNIQUE(tenant_id,workspace_id,scope_id,event_id),
				UNIQUE(tenant_id,workspace_id,scope_id,idempotency_key),
				FOREIGN KEY(tenant_id,workspace_id,scope_id) REFERENCES ${this.scopes}(tenant_id,workspace_id,scope_id));
				CREATE INDEX IF NOT EXISTS pizza_events_thread ON ${this.events}(tenant_id,workspace_id,scope_id,thread_id,sequence);
				CREATE INDEX IF NOT EXISTS pizza_events_type ON ${this.events}(tenant_id,workspace_id,scope_id,type,sequence);
				CREATE INDEX IF NOT EXISTS pizza_events_cause ON ${this.events}(tenant_id,workspace_id,scope_id,caused_by);`);
			await this.connection.query("COMMIT");
		} catch (error) {
			await this.connection.query("ROLLBACK");
			throw error;
		}
		const lease = await this.connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [
			this.lock,
		]);
		if (!lease.rows[0]?.locked) throw Error("Event scope already has an active writer");
		await this.connection.query(
			`INSERT INTO ${this.scopes}(tenant_id,workspace_id,scope_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
			this.key,
		);
	}
	async load(): Promise<EventStorageSnapshot> {
		const events: EventBase[] = [];
		const index = await this.restore((page) => events.push(...page));
		return { events, index };
	}
	async eventIdAt(sequence: number): Promise<string | undefined> {
		this.check();
		const { rows } = await this.connection.query(
			`SELECT event_id FROM ${this.events} WHERE tenant_id=$1 AND workspace_id=$2 AND scope_id=$3 AND sequence=$4`,
			[...this.key, sequence],
		);
		return rows[0]?.event_id;
	}
	async restore(accept: (page: EventBase[]) => void, options: EventRestoreOptions = {}): Promise<SessionIndex | undefined> {
		this.check();
		const after = options.afterSequence ?? 0;
		if (!Number.isSafeInteger(after) || after < 0) throw Error("Invalid restore cursor");
		const result = await this.connection.query(
			`SELECT head_sequence,index_json FROM ${this.scopes} WHERE tenant_id=$1 AND workspace_id=$2 AND scope_id=$3`,
			this.key,
		);
		this.head = Number(result.rows[0]!.head_sequence);
		if (!Number.isSafeInteger(this.head)) throw Error("Unsafe event sequence");
		if (after > this.head) throw Error("Projection cache is ahead of the durable log");
		let cursor = after;
		for (;;) {
			const page = await this.connection.query(
				`SELECT sequence,event_json FROM ${this.events} WHERE tenant_id=$1 AND workspace_id=$2 AND scope_id=$3 AND sequence>$4 ORDER BY sequence LIMIT 256`,
				[...this.key, cursor],
			);
			if (!page.rows.length) break;
			const events: EventBase[] = [];
			for (const row of page.rows) {
				const event = JSON.parse(row.event_json) as EventBase;
				this.validate(event);
				if (event.sequence !== Number(row.sequence) || event.sequence <= cursor) throw Error("Corrupt event sequence");
				cursor = event.sequence;
				events.push(event);
			}
			accept(events);
		}
		if (cursor !== this.head) throw Error("Event head does not match log");
		this.restored = true;
		const index = result.rows[0]!.index_json ? (JSON.parse(result.rows[0]!.index_json) as SessionIndex) : undefined;
		if (index) this.validateIndex(index);
		return index;
	}
	private validate(event: EventBase) {
		if (
			event.workspace_id !== this.workspace_id ||
			(this.options.threadId && event.thread_id && event.thread_id !== this.options.threadId)
		)
			throw Error("Event scope mismatch");
		if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.type === "AGENT_MESSAGE_CHUNK")
			throw Error("Invalid durable event");
	}
	private validateIndex(index: SessionIndex) {
		if (index.sessions.some((session) => session.source_ref))
			throw Error("Postgres storage does not support cross-workspace source references");
		for (const record of [...index.threads, ...index.sessions]) {
			if (
				record.workspace_id !== this.workspace_id ||
				(this.options.threadId && record.thread_id !== this.options.threadId)
			)
				throw Error("Session scope mismatch");
		}
	}
	async commit(events: EventBase[], index?: SessionIndex): Promise<void> {
		// Sequences/CAS are relative to the restored head; never write blind.
		if (!this.restored) throw Error("Postgres event storage must be restored before commit");
		await this.write(events, index, false);
	}
	/** Atomic, one-time import. Existing PG data is never merged or overwritten. */
	async importLegacy(source: EventStorageSnapshot | (() => EventStorageSnapshot)): Promise<boolean> {
		this.check();
		// A projection opened before import would silently miss the imported history.
		if (this.restored) throw Error("importLegacy() must run before AsyncProjectionStore.open()");
		const row = (
			await this.connection.query(
				`SELECT head_sequence,legacy_imported,index_json FROM ${this.scopes} WHERE tenant_id=$1 AND workspace_id=$2 AND scope_id=$3`,
				this.key,
			)
		).rows[0]!;
		if (row.legacy_imported) return false;
		if (Number(row.head_sequence) !== 0 || row.index_json)
			throw Error("Cannot import SQLite into a non-empty Postgres scope");
		this.head = 0;
		const snapshot = typeof source === "function" ? source() : source;
		await this.write(snapshot.events, snapshot.index, true);
		return true;
	}
	private async write(events: EventBase[], index: SessionIndex | undefined, importing: boolean) {
		this.check();
		let next = this.head;
		for (const event of events) {
			this.validate(event);
			if (event.sequence <= next) throw Error("Event sequence must increase");
			next = event.sequence;
		}
		if (index) {
			this.validateIndex(index);
			if ((index.watermark_sequence ?? 0) > next) throw Error("Session index is ahead of durable events");
		}
		await this.connection.query("BEGIN");
		try {
			const changed = await this.connection.query(
				`UPDATE ${this.scopes} SET head_sequence=$4,index_json=COALESCE($5,index_json),legacy_imported=legacy_imported OR $6 WHERE tenant_id=$1 AND workspace_id=$2 AND scope_id=$3 AND head_sequence=$7 RETURNING head_sequence`,
				[...this.key, next, index ? JSON.stringify(index) : null, importing, this.head],
			);
			if (!changed.rows.length) throw Error("Event scope changed under active writer");
			if (events.length) {
				const rows = events.map((event) => ({
					sequence: event.sequence,
					event_id: event.event_id,
					type: event.type,
					thread_id: event.thread_id ?? null,
					caused_by: event.caused_by ?? null,
					idempotency_key: event.idempotency_key ?? null,
					event_json: JSON.stringify(event),
				}));
				await this.connection.query(
					`INSERT INTO ${this.events}(tenant_id,workspace_id,scope_id,sequence,event_id,type,thread_id,caused_by,idempotency_key,event_json)
					SELECT $1,$2,$3,e.sequence,e.event_id,e.type,e.thread_id,e.caused_by,e.idempotency_key,e.event_json FROM jsonb_to_recordset($4::jsonb) AS e(sequence BIGINT,event_id TEXT,type TEXT,thread_id TEXT,caused_by TEXT,idempotency_key TEXT,event_json TEXT)`,
					[...this.key, JSON.stringify(rows)],
				);
			}
			await this.connection.query("COMMIT");
			this.head = next;
		} catch (error) {
			try {
				await this.connection.query("ROLLBACK");
			} catch {
				/* Connection may have failed. */
			}
			throw error;
		}
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		try {
			if (!this.broken) await this.connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [this.lock]);
		} finally {
			this.connection.removeListener?.("error", this.connectionError);
			this.connection.release(true);
		}
	}
}
