/**
 * Fork preparation for createSessionFacade.
 *
 * Same-workspace forks are zero-copy (a new descriptor referencing the parent
 * event range). Cross-workspace forks are ALSO zero-copy now: the forked
 * descriptor carries a `source_ref` { workspace_id, session_id,
 * fork_at_event_id } and buildContext lazily opens the source workspace's
 * store read-only to prepend the source context (see
 * SessionManager._resolveSourceContext). No events are cloned into the target
 * log, and the causal chain stays intact in the source workspace.
 *
 * Legacy clone-style forks (events copied into the target log) still work:
 * their descriptors simply have no source_ref.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import { SessionManager as ProjectionSessionManager } from "../projection/session-manager.js";

export interface ForkSource {
	workspaceId: string;
	sessionId: string;
	agentDir?: string;
}

export function prepareForkedSession(options: {
	store: import("../event-store/async-storage.js").SessionEventStore;
	sessionManager: ProjectionSessionManager;
	agentDir: string;
	source: ForkSource;
}): void {
	const { store, sessionManager, agentDir, source } = options;
	if (source.workspaceId === store.workspace_id) {
		sessionManager.forkFromSession(source.sessionId);
		return;
	}

	// Cross-workspace: open the source read-only ONCE to snapshot the fork
	// point + name, then create a reference-style descriptor. buildContext
	// re-opens the source lazily via source_ref at query time.
	const sourceAgentDir = source.agentDir ?? agentDir;
	const dbPath = join(sourceAgentDir, "workspaces", source.workspaceId, "events.sqlite");
	if (!existsSync(dbPath)) {
		throw new Error(`Fork source workspace not found: ${source.workspaceId}`);
	}
	const sourceStore = new SqliteEventStore(source.workspaceId, dbPath, "session_fork_source");
	const sourceSessionManager = new ProjectionSessionManager(sourceStore, sourceStore);
	try {
		const sourceProjection = sourceSessionManager.getSessionProjection(source.sessionId);
		if (!sourceProjection) {
			throw new Error(`Session not found: ${source.sessionId}`);
		}

		const sourceDescriptor = sourceProjection.getDescriptor();
		const forkAtEventId =
			sourceDescriptor.event_range.end_event_id === "HEAD"
				? sourceStore.head ?? sourceDescriptor.event_range.start_event_id
				: sourceDescriptor.event_range.end_event_id;
		const sourceRef = {
			workspace_id: source.workspaceId,
			session_id: source.sessionId,
			fork_at_event_id: forkAtEventId,
		};
		const forked = sessionManager.createSession("fork", sourceDescriptor.name, {
			parentSessionId: source.sessionId,
			sourceRef,
		});
		store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: source.sessionId,
				fork_at_event_id: forkAtEventId,
				source_ref: sourceRef,
			},
			thread_id: forked.thread_id,
		});
	} finally {
		sourceSessionManager.dispose();
		sourceStore.close();
	}
}