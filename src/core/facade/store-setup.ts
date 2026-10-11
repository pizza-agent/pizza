/**
 * EventStore + projection SessionManager setup phase for createSessionFacade.
 *
 * Owns workspace identity, the advisory workspace lock, crash recovery, and
 * initial session activation (resume / fork).
 */

import { acquireWorkspaceLock } from "../agent/main-agent.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import {
	deriveWorkspaceId,
	ensureWorkspaceMeta,
	getEventDatabasePath,
	getWorkspaceDir,
} from "../event-store/workspace.js";
import { SessionManager as ProjectionSessionManager } from "../projection/session-manager.js";
import { recoverDanglingTurnState } from "../runtime/crash-recovery.js";
import { prepareForkedSession, type ForkSource } from "./fork.js";

export interface StoreSetupOptions {
	cwd: string;
	/** Resolved agent dir (options.agentDir ?? getAgentDir()). */
	agentDir: string;
	/** Raw options.agentDir — undefined means "use built-in default paths". */
	rawAgentDir: string | undefined;
	isMainAgent: boolean;
	workspaceId?: string;
	storagePath?: string;
	sessionId?: string;
	/** Caller-supplied thread id (multi-tenant isolation). Wins over sessionId. */
	threadId?: string;
	forkFrom?: ForkSource;
}

export interface StoreSetupResult {
	workspaceId: string;
	store: SqliteEventStore;
	sessionManager: ProjectionSessionManager;
	/** Release callback for the advisory workspace lock, if acquired. */
	workspaceLock: { release: () => void } | null;
}

export function setupEventStore(options: StoreSetupOptions): StoreSetupResult {
	const { cwd, agentDir, rawAgentDir, isMainAgent } = options;
	const workspaceId = options.workspaceId ?? deriveWorkspaceId(cwd);
	if (options.storagePath !== ":memory:") {
		ensureWorkspaceMeta(workspaceId, cwd, rawAgentDir);
	}
	// Best-effort workspace lock: if another Pizza process is already driving
	// this workspace, we log a warning but still proceed — the lock is advisory,
	// not a hard gate. This allows the CLI and the desktop gateway to coexist
	// on the same workspace without blocking each other.
	let workspaceLock: { release: () => void } | null = null;
	if (!isMainAgent && options.storagePath !== ":memory:" && agentDir) {
		workspaceLock = acquireWorkspaceLock(getWorkspaceDir(workspaceId, agentDir));
		if (!workspaceLock) {
			console.warn(`Warning: workspace ${workspaceId} (cwd ${cwd}) is already in use by another Pizza process. Proceeding anyway.`);
		}
	}
	const store = new SqliteEventStore(
		workspaceId,
		options.storagePath ?? getEventDatabasePath(workspaceId, rawAgentDir),
	);
	// Compensate turn state left dangling by a crashed previous process
	// (unclosed TOOL_EXECUTION_START, tool_calls with no result, missing
	// AGENT_TURN_COMPLETED). Only safe when we are the sole workspace driver:
	// with a concurrent live process an in-flight tool is indistinguishable
	// from a crashed one.
	if (workspaceLock || isMainAgent || options.storagePath === ":memory:") {
		try {
			const recovered = recoverDanglingTurnState(store);
			if (recovered.compensated_tool_call_ids.length > 0) {
				console.warn(
					`Recovered ${recovered.compensated_tool_call_ids.length} tool call(s) interrupted by a previous crash.`,
				);
			}
		} catch (error) {
			console.warn(`Crash recovery scan failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const sessionManager = new ProjectionSessionManager(
		store,
		store,
	);
	if (options.forkFrom) {
		prepareForkedSession({ store, sessionManager, agentDir, source: options.forkFrom });
	} else if (options.threadId) {
		// Multi-tenant: bind this facade to the caller's thread. Checked before
		// sessionId because the thread is the isolation boundary — activating a
		// session from another thread would defeat it.
		sessionManager.useThread(options.threadId);
	} else if (options.sessionId) {
		sessionManager.switchTo(options.sessionId);
	}
	return { workspaceId, store, sessionManager, workspaceLock };
}