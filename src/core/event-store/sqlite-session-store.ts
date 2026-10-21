import type { DatabaseSync } from "node:sqlite";
import type { SessionDescriptor, SessionIndex, ThreadDescriptor } from "../projection/types.js";
import type { SessionStore } from "./session-store.js";

/**
 * SQLite-backed SessionStore implementation.
 *
 * Stores threads and sessions in the same SQLite database as the event log.
 */
export class SqliteSessionStore implements SessionStore {
	constructor(
		private readonly db: DatabaseSync,
		private readonly workspaceId: string,
	) {
		this._initSchema();
	}

	getSessionIndex(): SessionIndex | undefined {
		const threads = this._loadThreads();
		const sessions = this._loadSessions();
		if (threads.length === 0 && sessions.length === 0) {
			return undefined;
		}
		return { threads, sessions, watermark_sequence: this._loadWatermark() };
	}

	/** Drop all thread/session rows and the watermark (used to rebuild a disposable projection). */
	clearSessionIndex(): void {
		this.db.exec("begin");
		try {
			this.db.exec("delete from threads; delete from sessions; delete from session_index_meta;");
			this.db.exec("commit");
		} catch (error) {
			this.db.exec("rollback");
			throw error;
		}
	}

	saveSessionIndex(index: SessionIndex): void {
		this.db.exec("begin");
		try {
			this._saveSessionIndexInTx(index);
			this.db.exec("commit");
		} catch (error) {
			this.db.exec("rollback");
			throw error;
		}
	}

	private _saveSessionIndexInTx(index: SessionIndex): void {
		{
			const upsertThread = this.db.prepare(`
				insert into threads (thread_id, workspace_id, name, created_at, status)
				values (?, ?, ?, ?, ?)
				on conflict(thread_id) do update set
					name = excluded.name,
					status = excluded.status
			`);
			for (const thread of index.threads) {
				upsertThread.run(
					thread.thread_id,
					thread.workspace_id,
					thread.name ?? null,
					thread.created_at,
					thread.status,
				);
			}

			const upsertSession = this.db.prepare(`
				insert into sessions (
					session_id, thread_id, workspace_id, start_event_id, end_event_id,
					summary_event_id, name, created_by, boundary_reason, parent_session_id,
					context_parent_session_id, source_ref_json, created_at
				) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				on conflict(session_id) do update set
					thread_id = excluded.thread_id,
					start_event_id = excluded.start_event_id,
					end_event_id = excluded.end_event_id,
					summary_event_id = excluded.summary_event_id,
					name = excluded.name,
					boundary_reason = excluded.boundary_reason,
					parent_session_id = excluded.parent_session_id,
					context_parent_session_id = excluded.context_parent_session_id,
					source_ref_json = excluded.source_ref_json
			`);
			for (const session of index.sessions) {
				upsertSession.run(
					session.session_id,
					session.thread_id,
					session.workspace_id,
					session.event_range.start_event_id,
					session.event_range.end_event_id,
					session.summary_event_id ?? null,
					session.name ?? null,
					session.created_by,
					session.boundary_reason ?? null,
					session.parent_session_id ?? null,
					session.context_parent_session_id ?? null,
					session.source_ref ? JSON.stringify(session.source_ref) : null,
					session.created_at,
				);
			}
		}

		// Upsert-only, NO stale-row deletion. The in-memory index of one process
		// is not the full picture: a concurrent process (CLI + gateway coexist on
		// the same workspace by design) may have created sessions this process
		// never loaded. Deleting "unknown" rows here silently destroyed the other
		// process's sessions on every persist (last-writer-wins data loss).
		// SessionManager never deletes sessions, so nothing legitimately relied
		// on the old delete-stale behavior.

		// Watermark: only move forward. A stale writer (concurrent process that
		// loaded earlier) must not rewind the replay cursor past events a newer
		// writer already reflected in the snapshot.
		if (index.watermark_sequence !== undefined) {
			this.db
				.prepare(`
					insert into session_index_meta (workspace_id, watermark_sequence)
					values (?, ?)
					on conflict(workspace_id) do update set
						watermark_sequence = max(session_index_meta.watermark_sequence, excluded.watermark_sequence)
				`)
				.run(this.workspaceId, index.watermark_sequence);
		}
	}

	private _initSchema(): void {
		this.db.exec(`
			create table if not exists threads (
				thread_id text primary key,
				workspace_id text not null,
				name text,
				created_at integer not null,
				status text not null
			);

			create table if not exists sessions (
				session_id text primary key,
				thread_id text not null,
				workspace_id text not null,
				start_event_id text not null,
				end_event_id text not null,
				summary_event_id text,
				name text,
				created_by text not null,
				boundary_reason text,
				parent_session_id text,
				context_parent_session_id text,
				created_at integer not null
			);

			create index if not exists idx_sessions_thread_id on sessions(thread_id);
			create index if not exists idx_sessions_workspace_id on sessions(workspace_id);
			create index if not exists idx_sessions_parent_id on sessions(parent_session_id);

			create table if not exists session_index_meta (
				workspace_id text primary key,
				watermark_sequence integer not null
			);
		`);
		this._ensureColumn("sessions", "context_parent_session_id", "text");
		this.db.exec("create index if not exists idx_sessions_context_parent_id on sessions(context_parent_session_id)");
		// Zero-copy cross-workspace fork provenance (JSON: SessionSourceRef).
		this._ensureColumn("sessions", "source_ref_json", "text");
	}

	private _ensureColumn(table: string, column: string, type: string): void {
		const rows = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
		if (rows.some((row) => row.name === column)) return;
		this.db.exec(`alter table ${table} add column ${column} ${type}`);
	}

	private _loadWatermark(): number | undefined {
		const row = this.db
			.prepare("select watermark_sequence from session_index_meta where workspace_id = ?")
			.get(this.workspaceId) as { watermark_sequence: number } | undefined;
		return row?.watermark_sequence;
	}

	private _loadThreads(): ThreadDescriptor[] {
		const rows = this.db.prepare("select * from threads").all() as ThreadRow[];
		return rows.map((row) => ({
			thread_id: row.thread_id,
			workspace_id: row.workspace_id,
			name: row.name ?? undefined,
			created_at: row.created_at,
			status: row.status as ThreadDescriptor["status"],
		}));
	}

	private _loadSessions(): SessionDescriptor[] {
		const rows = this.db.prepare("select * from sessions").all() as SessionRow[];
		return rows.map((row) => ({
			session_id: row.session_id,
			thread_id: row.thread_id,
			workspace_id: row.workspace_id,
			event_range: {
				start_event_id: row.start_event_id,
				end_event_id: row.end_event_id,
			},
			summary_event_id: row.summary_event_id ?? undefined,
			name: row.name ?? undefined,
			created_by: row.created_by as SessionDescriptor["created_by"],
			boundary_reason: row.boundary_reason as SessionDescriptor["boundary_reason"] | undefined,
			parent_session_id: row.parent_session_id ?? undefined,
			context_parent_session_id: row.context_parent_session_id ?? undefined,
			source_ref: row.source_ref_json ? safeParseSourceRef(row.source_ref_json) : undefined,
			created_at: row.created_at,
		}));
	}
}

function safeParseSourceRef(json: string): SessionDescriptor["source_ref"] {
	try {
		return JSON.parse(json) as SessionDescriptor["source_ref"];
	} catch {
		return undefined;
	}
}

type ThreadRow = {
	thread_id: string;
	workspace_id: string;
	name: string | null;
	created_at: number;
	status: string;
};

type SessionRow = {
	session_id: string;
	thread_id: string;
	workspace_id: string;
	start_event_id: string;
	end_event_id: string;
	summary_event_id: string | null;
	name: string | null;
	created_by: string;
	boundary_reason: string | null;
	parent_session_id: string | null;
	context_parent_session_id: string | null;
	source_ref_json: string | null;
	created_at: number;
};
