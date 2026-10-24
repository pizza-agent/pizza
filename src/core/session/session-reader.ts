/**
 * Session Reader
 *
 * Rebuilds the export entry list by replaying the session’s conversation
 * events (USER_MESSAGE / AGENT_MESSAGE_END / TOOL_EXECUTION_END / …). The
 * legacy format read only SESSION_ENTRY_APPENDED events — those carry only
 * extension-inserted custom entries, so a normal session exported as an
 * empty transcript.
 */

import { existsSync, readFileSync } from "node:fs";
import { getAgentDir } from "../../config.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import type { EventBase, EventType } from "../event-store/types.js";
import { deriveWorkspaceId, getEventDatabasePath, getWorkspaceMetaPath } from "../event-store/workspace.js";
import { eventToMessage } from "../projection/event-to-message.js";
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

/**
 * Event types that map onto SessionEntry records for the HTML export.
 * Conversation events become `message` entries via the shared
 * eventToMessage converter; lifecycle/user-action events get their own
 * entry types so the exported transcript mirrors the TUI timeline.
 */
const EXPORT_ENTRY_TYPES: EventType[] = [
	"USER_MESSAGE",
	"AGENT_MESSAGE_END",
	"TOOL_EXECUTION_END",
	"COMPACTION_END",
	"FILE_MUTATION_APPLIED",
	"BASH_EXECUTION",
	"CUSTOM_MESSAGE",
	"BRANCH_SUMMARY",
	"MODEL_CHANGED",
	"THINKING_LEVEL_CHANGED",
	"SESSION_RENAMED",
	"SESSION_ENTRY_APPENDED",
];

/** Convert one event into the SessionEntry the HTML template renders. */
function exportEntryFromEvent(event: EventBase): SessionEntry | undefined {
	const base = {
		id: event.event_id,
		parentId: null as string | null, // chained by the caller
		timestamp: new Date(event.timestamp).toISOString(),
	};

	switch (event.type) {
		case "SESSION_ENTRY_APPENDED": {
			// Extension-inserted custom entries — already SessionEntry-shaped.
			const payload = event.payload as Partial<SessionEntryAppendedPayload>;
			return payload.entry ? { ...base, ...payload.entry, id: payload.entry.id ?? event.event_id } : undefined;
		}
		case "CUSTOM_MESSAGE": {
			const payload = event.payload as { custom_type?: string; data?: unknown };
			return {
				...base,
				type: "custom_message",
				customType: payload.custom_type ?? "custom",
				content: typeof payload.data === "string" ? payload.data : "",
				details: typeof payload.data === "string" ? undefined : payload.data,
				display: true,
			} as SessionEntry;
		}
		case "FILE_MUTATION_APPLIED": {
			const payload = event.payload as { operation?: string; path?: string };
			return {
				...base,
				type: "custom_message",
				customType: "runtime:file_mutation",
				content: `File ${payload.operation ?? "modify"}: ${payload.path ?? "file"}`,
				display: true,
			} as SessionEntry;
		}
		case "BRANCH_SUMMARY": {
			const payload = event.payload as { summary?: string; from_id?: string };
			return { ...base, type: "branch_summary", fromId: payload.from_id ?? "", summary: payload.summary ?? "" } as SessionEntry;
		}
		case "MODEL_CHANGED": {
			const payload = event.payload as { provider?: string; model_id?: string };
			return { ...base, type: "model_change", provider: payload.provider ?? "", modelId: payload.model_id ?? "" } as SessionEntry;
		}
		case "THINKING_LEVEL_CHANGED": {
			const payload = event.payload as { level?: string };
			return { ...base, type: "thinking_level_change", thinkingLevel: payload.level ?? "" } as SessionEntry;
		}
		case "SESSION_RENAMED": {
			const payload = event.payload as { name?: string };
			return { ...base, type: "session_info", name: payload.name } as SessionEntry;
		}
		case "COMPACTION_END": {
			const payload = event.payload as { summary?: string; tokens_before?: number; first_kept_event_id?: string };
			return { ...base, type: "compaction", summary: payload.summary ?? "", tokensBefore: payload.tokens_before ?? 0, firstKeptEntryId: payload.first_kept_event_id ?? "" } as SessionEntry;
		}
		default: {
			// USER_MESSAGE / AGENT_MESSAGE_END / TOOL_EXECUTION_END / BASH_EXECUTION:
			// share the projection’s converter so export sees the same messages
			// the LLM context builder sees (tool calls, tool results, bash runs).
			const message = eventToMessage(event);
			return message ? ({ ...base, type: "message", message } as SessionEntry) : undefined;
		}
	}
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

		// Rebuild the transcript by replaying the session’s event range — the
		// event-sourced model never writes SESSION_ENTRY_APPENDED for normal
		// conversation, so reading only those yields an empty transcript.

		const index = store.getSessionIndex();
		const findSession = (id: string) => index?.sessions.find((s) => s.session_id === id);

		// Replay a session’s own event range into export entries.
		const entriesFor = (id: string, depth: number): SessionEntry[] => {
			const sess = findSession(id);
			// Unknown session → no events. Without this guard the range query
			// degenerates to "everything" and the export silently mixes in
			// other sessions’ transcripts (observed live: --export on a
			// bogus id produced another session’s entries).
			if (!sess) return [];
			const start = sess.event_range.start_event_id;
			const end = sess.event_range.end_event_id;
			const rangeEvents = store
				.query({
					after: start && start !== "ORIGIN" ? start : undefined,
					before: end && end !== "HEAD" ? end : undefined,
					types: EXPORT_ENTRY_TYPES,
				})
				.filter((event) => !event.thread_id || event.thread_id === sess.thread_id);

			const out: SessionEntry[] = [];
			let previousId: string | null = null;
			for (const event of rangeEvents) {
				// SESSION_ENTRY_APPENDED belongs to whatever session its payload
				// names — range membership alone is not proof.
				if (event.type === "SESSION_ENTRY_APPENDED") {
					const payload = event.payload as Partial<SessionEntryAppendedPayload>;
					if (payload.session_id && payload.session_id !== id) continue;
				}
				const entry = exportEntryFromEvent(event);
				if (!entry) continue;
				entry.parentId = previousId;
				out.push(entry);
				previousId = entry.id;
			}

			// A session forked with inherited context reads through its parent:
			// prepend the context parent’s entries so the export shows the
			// transcript the session actually saw (mirrors the projection’s
			// context_parent_session_id chain; falls back to parent_session_id).
			if (sess && depth < 8) {
				const parentId = sess.context_parent_session_id ?? sess.parent_session_id;
				if (parentId && parentId !== id) {
					const parentEntries = entriesFor(parentId, depth + 1);
					for (const entry of out) if (!entry.parentId) entry.parentId = parentEntries[parentEntries.length - 1]?.id ?? null;
					return [...parentEntries, ...out];
				}
			}
			return out;
		};

		let entries = entriesFor(sessionId, 0);

		// Without a session descriptor there is no range — fall back to
		// "everything between this SESSION_CREATED and the next one" rather
		// than an empty transcript.
		if (entries.length === 0 && createdEvent) {
			const fallback = store.query({ types: EXPORT_ENTRY_TYPES });
			let previousId: string | null = null;
			for (const event of fallback) {
				if (event.sequence <= createdEvent.sequence) continue;
				if (event.type === "SESSION_CREATED") break;
				if (event.type === "SESSION_ENTRY_APPENDED") {
					const payload = event.payload as Partial<SessionEntryAppendedPayload>;
					if (payload.session_id !== sessionId) continue;
				}
				const entry = exportEntryFromEvent(event);
				if (!entry) continue;
				entry.parentId = previousId;
				entries.push(entry);
				previousId = entry.id;
			}
		}

		const leafId = entries.length > 0 ? entries[entries.length - 1]!.id : null;

		return { header, entries, leafId, sessionId };
	} finally {
		store.close();
	}
}
