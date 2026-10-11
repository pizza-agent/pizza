/**
 * Session Listing
 *
 * Lists sessions from the SQLite event store session index and EventStore.
 * Replaces old SessionManager.list/listAll static methods with a clean,
 * event-sourced implementation.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, Message } from "../agent/types.js";
import { getAgentDir } from "../../config.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import type { SessionDescriptor, SessionIndex } from "../projection/types.js";
import { deriveWorkspaceId, getEventDatabasePath, getWorkspaceMetaPath } from "../event-store/workspace.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionListInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
}

export type SessionListProgress = (loaded: number, total: number) => void;

// ============================================================================
// Helpers
// ============================================================================

const SESSION_REF_PREFIX = "event-session:";

function makeSessionRef(workspaceId: string, sessionId: string): string {
	return `${SESSION_REF_PREFIX}${workspaceId}:${sessionId}`;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

/** Read workspace cwd from meta.json */
function readWorkspaceCwd(workspaceId: string, agentDir: string): string | undefined {
	const metaPath = getWorkspaceMetaPath(workspaceId, agentDir);
	if (!existsSync(metaPath)) return undefined;
	try {
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { cwd?: string };
		return meta.cwd;
	} catch {
		return undefined;
	}
}

/** Build SessionListInfo from a session descriptor by querying EventStore for metadata */
function buildSessionInfo(
	descriptor: SessionDescriptor,
	workspaceId: string,
	cwd: string,
	store: SqliteEventStore,
): SessionListInfo {
	let messageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	let lastActivity = descriptor.created_at;

	// Query context-relevant events for this session's range. Both bounds and
	// the thread guard are required: without them every session in the
	// workspace reported the SAME aggregate (whole-log counts and first
	// message), and in multi-tenant (SDK threadId) use one tenant's listing
	// would surface another tenant's message text.
	const { start_event_id, end_event_id } = descriptor.event_range;
	const events = store.query({
		after: start_event_id === "ORIGIN" ? undefined : start_event_id,
		before: end_event_id === "HEAD" ? undefined : end_event_id,
		types: ["USER_MESSAGE", "AGENT_MESSAGE_END"],
	});

	for (const event of events) {
		// Legacy/runtime events may carry no thread_id; only skip real mismatches.
		if (event.thread_id && event.thread_id !== descriptor.thread_id) continue;
		if (event.timestamp > 0) {
			lastActivity = Math.max(lastActivity, event.timestamp);
		}

		if (event.type === "USER_MESSAGE") {
			const payload = event.payload as { content: string | unknown[] };
			const text = typeof payload.content === "string"
				? payload.content
				: "";
			messageCount++;
			if (text && !firstMessage) {
				firstMessage = text.slice(0, 200);
			}
			if (text) allMessages.push(text);
		} else if (event.type === "AGENT_MESSAGE_END") {
			messageCount++;
		}
	}

	return {
		path: makeSessionRef(workspaceId, descriptor.session_id),
		id: descriptor.session_id,
		cwd,
		name: descriptor.name,
		parentSessionPath: descriptor.parent_session_id
			? makeSessionRef(workspaceId, descriptor.parent_session_id)
			: undefined,
		created: new Date(descriptor.created_at),
		modified: new Date(lastActivity),
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		allMessagesText: allMessages.join(" "),
	};
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List all sessions for a workspace (current cwd).
 * Reads from the SQLite session index + EventStore for each session.
 */
export async function listWorkspaceSessions(
	cwd: string,
	agentDir: string = getAgentDir(),
	onProgress?: SessionListProgress,
	/**
	 * Restrict the listing to one thread. REQUIRED in multi-tenant (SDK
	 * threadId) deployments — omitting it lists every tenant's sessions in the
	 * workspace. Omit only for single-user local use, where seeing all threads
	 * is the desired behaviour.
	 */
	threadId?: string,
): Promise<SessionListInfo[]> {
	const workspaceId = deriveWorkspaceId(cwd);
	const dbPath = getEventDatabasePath(workspaceId, agentDir);
	if (!existsSync(dbPath)) return [];

	const store = new SqliteEventStore(workspaceId, dbPath, "session_list");
	try {
		const index = store.getSessionIndex();
		if (!index || index.sessions.length === 0) return [];

		const workspaceCwd = readWorkspaceCwd(workspaceId, agentDir) ?? cwd;
		const results: SessionListInfo[] = [];

		const sessions = threadId ? index.sessions.filter((s) => s.thread_id === threadId) : index.sessions;
		for (let i = 0; i < sessions.length; i++) {
			const desc = sessions[i]!;
			results.push(buildSessionInfo(desc, workspaceId, workspaceCwd, store));
			onProgress?.(i + 1, sessions.length);
		}

		results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return results;
	} finally {
		store.close();
	}
}

/**
 * List all sessions across all workspaces.
 * Scans agentDir/workspaces/* for event databases.
 */
export async function listAllSessions(
	agentDir: string = getAgentDir(),
	onProgress?: SessionListProgress,
): Promise<SessionListInfo[]> {
	const workspacesDir = join(agentDir, "workspaces");
	if (!existsSync(workspacesDir)) return [];

	const workspaceEntries = readdirSync(workspacesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);

	const results: SessionListInfo[] = [];

	for (let i = 0; i < workspaceEntries.length; i++) {
		const workspaceId = workspaceEntries[i]!;
		const dbPath = getEventDatabasePath(workspaceId, agentDir);
		if (!existsSync(dbPath)) continue;

		const store = new SqliteEventStore(workspaceId, dbPath, "session_list_all");
		try {
			const index = store.getSessionIndex();
			if (!index || index.sessions.length === 0) continue;

			const workspaceCwd = readWorkspaceCwd(workspaceId, agentDir) ?? process.cwd();
			for (const desc of index.sessions) {
				results.push(buildSessionInfo(desc, workspaceId, workspaceCwd, store));
			}
		} finally {
			store.close();
		}

		onProgress?.(i + 1, workspaceEntries.length);
	}

	results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return results;
}
