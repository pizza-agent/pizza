/**
 * Session Reader
 *
 * Minimal utility for reading session data from EventStore for export.
 * This is the only remaining code that understands the old SESSION_ENTRY_APPENDED
 * event format used to reconstruct entries for HTML export.
 */

import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "../../config.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import type { EventBase } from "../event-store/types.js";
import { deriveWorkspaceId, getEventDatabasePath, getWorkspaceMetaPath } from "../event-store/workspace.js";
import type { SessionEntry, SessionHeader } from "../types/session-types.js";

const SESSION_REF_PREFIX = "event-session:";

// ============================================================================
// Helpers
// ============================================================================

function parseSessionRef(ref: string): { workspaceId?: string; sessionId: string } {
	if (ref.endsWith(".jsonl") || ref.includes("/") || ref.includes("\\")) {
		throw new Error("Legacy JSONL session files are no longer supported; sessions now live in events.sqlite.");
	}
	if (!ref.startsWith(SESSION_REF_PREFIX)) {
		return { sessionId: ref };
	}
	const rest = ref.slice(SESSION_REF_PREFIX.length);
	const [workspaceId, sessionId] = rest.split(":");
	if (!sessionId) {
		throw new Error(`Invalid session reference: ${ref}`);
	}
	return { workspaceId, sessionId };
}

function readWorkspaceCwd(workspaceId: string, agentDir: string, fallback: string): string {
	const metaPath = getWorkspaceMetaPath(workspaceId, agentDir);
	if (!existsSync(metaPath)) return fallback;
	try {
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { cwd?: string };
		return meta.cwd ?? fallback;
	} catch {
		return fallback;
	}
}

interface SessionEntryAppendedPayload {
	session_id: string;
	entry: SessionEntry;
	leaf_id?: string | null;
}

interface SessionCreatedPayload {
	session_id: string;
	name?: string;
	created_by?: string;
	cwd?: string;
	timestamp?: string;
	parentSession?: string;
}

function entryFromEvent(event: EventBase): SessionEntry | undefined {
	const payload = event.payload as Partial<SessionEntryAppendedPayload>;
	return payload.entry;
}

// ============================================================================
// Public API
// ============================================================================

export interface ReadSessionResult {
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	sessionId: string;
}

/**
 * Read session data from EventStore for export.
 * Replaces SessionManager.open() for the export use case.
 */
export function readSessionForExport(inputPath: string, agentDir: string = getAgentDir()): ReadSessionResult {
	const parsed = parseSessionRef(inputPath);
	const workspaceId = parsed.workspaceId ?? deriveWorkspaceId(process.cwd());
	const dbPath = getEventDatabasePath(workspaceId, agentDir);

	if (!existsSync(dbPath)) {
		throw new Error(`Session database not found: ${dbPath}`);
	}

	const store = new SqliteEventStore(workspaceId, dbPath, "export_reader");
	try {
		const sessionId = parsed.sessionId;
		const cwd = readWorkspaceCwd(workspaceId, agentDir, process.cwd());

		// Find the SESSION_CREATED event for this session
		const createdEvents = store.query({ types: ["SESSION_CREATED"] });
		const createdEvent = createdEvents.find((e) => {
			const payload = e.payload as SessionCreatedPayload;
			return payload.session_id === sessionId;
		});

		let header: SessionHeader | null = null;
		if (createdEvent) {
			const payload = createdEvent.payload as SessionCreatedPayload;
			header = {
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: payload.timestamp ?? new Date(createdEvent.timestamp).toISOString(),
				cwd: payload.cwd ?? cwd,
				parentSession: payload.parentSession,
			};
		}

		// Rebuild entries from SESSION_ENTRY_APPENDED events
		const appendedEvents = store.query({ types: ["SESSION_ENTRY_APPENDED"] }).filter((event) => {
			const payload = event.payload as Partial<SessionEntryAppendedPayload>;
			return payload.session_id === sessionId;
		});

		const entries: SessionEntry[] = [];
		let leafId: string | null = null;

		for (const event of appendedEvents) {
			const payload = event.payload as SessionEntryAppendedPayload;
			if (payload.entry) {
				entries.push(payload.entry);
				leafId = payload.entry.id;
			}
			if (payload.leaf_id !== undefined) {
				leafId = payload.leaf_id;
			}
		}

		return { header, entries, leafId, sessionId };
	} finally {
		store.close();
	}
}
