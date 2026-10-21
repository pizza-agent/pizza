import { createRequire } from "node:module";
import type { EventStorageSnapshot } from "./async-storage.js";
import type { EventBase } from "./types.js";
import type { SessionIndex, SessionDescriptor, ThreadDescriptor } from "../projection/types.js";

/** Read a consistent legacy snapshot without changing schema, events or indexes. */
export function readSqliteEventSnapshot(path: string, workspaceId: string): EventStorageSnapshot {
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		db.exec("BEGIN");
		const events = db
			.prepare("SELECT * FROM events ORDER BY sequence")
			.all()
			.map((row) => {
				if (row.workspace_id !== workspaceId) throw Error("Legacy event workspace mismatch");
				return {
					sequence: Number(row.sequence),
					event_id: row.event_id,
					workspace_id: row.workspace_id,
					runtime_id: row.runtime_id,
					actor_id: row.actor_id,
					timestamp: Number(row.timestamp),
					type: row.type,
					payload: JSON.parse(String(row.payload_json)),
					caused_by: row.caused_by ?? undefined,
					correlation_id: row.correlation_id ?? undefined,
					thread_id: row.thread_id ?? undefined,
					schema_version: Number(row.schema_version),
					idempotency_key: row.idempotency_key ?? undefined,
				} as EventBase;
			});
		const tables = new Set(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all()
				.map((row) => row.name),
		);
		let index: SessionIndex | undefined;
		if (tables.has("threads") && tables.has("sessions")) {
			const threads = db
				.prepare("SELECT * FROM threads")
				.all()
				.map((row) => ({
					thread_id: row.thread_id,
					workspace_id: row.workspace_id,
					name: row.name ?? undefined,
					created_at: Number(row.created_at),
					status: row.status,
				})) as ThreadDescriptor[];
			const sessions = db
				.prepare("SELECT * FROM sessions")
				.all()
				.map((row) => ({
					session_id: row.session_id,
					thread_id: row.thread_id,
					workspace_id: row.workspace_id,
					event_range: { start_event_id: row.start_event_id, end_event_id: row.end_event_id },
					summary_event_id: row.summary_event_id ?? undefined,
					name: row.name ?? undefined,
					created_by: row.created_by,
					boundary_reason: row.boundary_reason ?? undefined,
					parent_session_id: row.parent_session_id ?? undefined,
					context_parent_session_id: row.context_parent_session_id ?? undefined,
					source_ref: row.source_ref_json ? JSON.parse(String(row.source_ref_json)) : undefined,
					created_at: Number(row.created_at),
				})) as SessionDescriptor[];
			if ([...threads, ...sessions].some((row) => row.workspace_id !== workspaceId))
				throw Error("Legacy session workspace mismatch");
			if (threads.length || sessions.length) {
				const watermark = tables.has("session_index_meta")
					? db.prepare("SELECT watermark_sequence FROM session_index_meta WHERE workspace_id=?").get(workspaceId)
					: undefined;
				index = { threads, sessions, watermark_sequence: watermark ? Number(watermark.watermark_sequence) : undefined };
			}
		}
		db.exec("COMMIT");
		return { events, index };
	} finally {
		db.close();
	}
}
