/**
 * Session Manager (Event-Sourced)
 *
 * Manages session descriptors, not session data.
 * Data lives in EventStore. Session is just a query view.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EventStore } from "../event-store/store.js";
import { isSessionStore, type SessionStore } from "../event-store/session-store.js";
import type { SessionDescriptor, SessionIndex, SessionSourceRef, ThreadDescriptor } from "./types.js";
import { SessionProjection, type ResolveSourceContext } from "./session-projection.js";
import type { BuiltContext } from "./types.js";
import { getAgentDir } from "../../config.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import {
	rebuildSessionIndex,
	replayIndexEventsAfter,
	type SessionIndexState,
} from "./session-index-reducer.js";
import { randomBytes } from "node:crypto";

/** 8-char crypto-random id suffix. Math.random() gave two concurrent
 * processes (CLI + gateway) a realistic collision window on session ids;
 * crypto randomness removes it. */
function cryptoRandomSuffix(): string {
	return randomBytes(6).toString("base64url").slice(0, 8).replace(/[-_]/g, "0");
}

export interface CreateProjectionSessionOptions {
	parentSessionId?: string;
	contextParentSessionId?: string;
	threadId?: string;
	startEventId?: string;
	summaryEventId?: string;
	closeActive?: boolean;
	/** Cross-workspace fork provenance (zero-copy fork). */
	sourceRef?: SessionSourceRef;
}

export interface SwitchToExistingSessionOptions {
	closePrevious?: "same-thread" | "always" | "never";
	background?: boolean;
}

// ============================================================================
// Session Manager
// ============================================================================

/**
 * SessionManager - manages session descriptors only.
 *
 * Storage: SessionStore implementation (typically SQLite via SqliteEventStore).
 *
 * Does NOT store messages. Tree structure emerges from EventStore's caused_by chain.
 */
export class SessionManager {
	private threads: Map<string, ThreadDescriptor> = new Map();
	private sessions: Map<string, SessionDescriptor> = new Map();
	private activeThreadId: string | undefined;
	private activeSessionId: string | undefined;
	private sessionStore: SessionStore | undefined;
	/** Threads created in-memory whose THREAD record has not yet been carried
	 * by a SESSION_CREATED event (embedded thread payload). */
	private pendingThreadEvents: Set<string> = new Set();
	/**
	 * Read-only stores of OTHER workspaces opened to resolve source_ref
	 * (zero-copy cross-workspace fork). Cached per workspace_id, closed on
	 * dispose(). null = resolution failed permanently (store missing) — do
	 * not retry every buildContext.
	 */
	private externalSources: Map<string, { store: EventStore & { close(): void }; manager: SessionManager } | null> = new Map();
	/** Cached projection for the active session (invalidated on session switch/close). */
	private _activeProjection: SessionProjection | undefined;

	constructor(
		private store: EventStore,
		sessionStore?: SessionStore,
	) {
		this.sessionStore = sessionStore ?? (isSessionStore(store) ? store : undefined);
		this._loadIndex();
	}

	// =========================================================================
	// Session Operations
	// =========================================================================

	/**
	 * Get or create the active session.
	 */
	getActiveSession(): SessionProjection {
		if (!this.activeThreadId) {
			this.createThread();
		}
		if (!this.activeSessionId) {
			this.createSession("user_explicit", undefined, { threadId: this.activeThreadId });
		}
		const desc = this.sessions.get(this.activeSessionId!)!;
		// Reuse one projection per active descriptor — every getProjection()
		// caller (footer render, get_state, turn start) would otherwise
		// rebuild a fresh projection and re-scan the event log per call.
		if (this._activeProjection?.descriptor !== desc) {
			this._activeProjection = new SessionProjection(
				this.store,
				desc,
				(sessionId) => this.sessions.get(sessionId),
				this._resolveSourceContext,
			);
		}
		return this._activeProjection;
	}

	/**
	 * Create a new session.
	 */
	createSession(
		created_by: SessionDescriptor["created_by"],
		name?: string,
		options: CreateProjectionSessionOptions = {},
	): SessionDescriptor {
		const threadId = options.threadId ?? this.activeThreadId ?? this._createThreadRecord().thread_id;
		const previousActiveId = options.closeActive !== false ? this.activeSessionId : undefined;
		const desc: SessionDescriptor = {
			session_id: this._generateSessionId(),
			thread_id: threadId,
			workspace_id: this.store.workspace_id,
			event_range: {
				start_event_id: options.startEventId ?? this.store.head ?? "ORIGIN",
				end_event_id: "HEAD",
			},
			summary_event_id: options.summaryEventId,
			name,
			created_by,
			parent_session_id: options.parentSessionId,
			context_parent_session_id: options.contextParentSessionId,
			source_ref: options.sourceRef,
			created_at: Date.now(),
		};

		this.sessions.set(desc.session_id, desc);
		this.activeSessionId = desc.session_id;
		this.activeThreadId = desc.thread_id;

		// Which session does this creation close? Computed BEFORE append so the
		// event carries the boundary mutation (index = projection of the log).
		const previousActive = previousActiveId ? this.sessions.get(previousActiveId) : undefined;
		const closesSession =
			previousActive && previousActive.thread_id === threadId && previousActive.event_range.end_event_id === "HEAD"
				? previousActive
				: undefined;

		// Embed the thread record when this event is the first to reference it,
		// so replay can recreate the thread without a snapshot.
		const threadPayload = this._takePendingThreadEvent(desc.thread_id);

		// Emit session created event carrying the full descriptor.
		const createdEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_CREATED",
			payload: {
				session_id: desc.session_id,
				name,
				created_by,
				parent_session_id: desc.parent_session_id,
				context_parent_session_id: desc.context_parent_session_id,
				start_event_id: desc.event_range.start_event_id,
				summary_event_id: desc.summary_event_id,
				created_at: desc.created_at,
				closes_session_id: closesSession?.session_id,
				thread: threadPayload,
				source_ref: desc.source_ref,
			},
			thread_id: desc.thread_id,
		});

		if (closesSession) {
			closesSession.event_range.end_event_id = createdEvent.event_id;
		}
		this._persistIndex();

		return desc;
	}

	/**
	 * Fork the current session at a specific event.
	 */
	forkAt(event_id: string): SessionDescriptor {
		const active = this.getActiveSession();
		const source = active.getDescriptor();
		const forked = active.fork(event_id);
		this.sessions.set(forked.session_id, forked);
		this.activeSessionId = forked.session_id;
		this.activeThreadId = forked.thread_id;

		const closesSource = source.event_range.end_event_id === "HEAD";
		const forkedEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: forked.parent_session_id,
				fork_at_event_id: event_id,
				name: forked.name,
				start_event_id: forked.event_range.start_event_id,
				summary_event_id: forked.summary_event_id,
				context_parent_session_id: forked.context_parent_session_id,
				created_at: forked.created_at,
				closes_session_id: closesSource ? source.session_id : undefined,
			},
			thread_id: forked.thread_id,
		});
		if (closesSource) {
			source.event_range.end_event_id = forkedEvent.event_id;
		}
		this._persistIndex();

		return forked;
	}

	/**
	 * Fork an existing session while preserving its projected history.
	 *
	 * The source session is frozen at the current head if it was tracking HEAD,
	 * and the forked descriptor reuses the source start boundary so context still
	 * includes the source conversation.
	 *
	 * @param preserveHistory - When true (default), the forked session starts at
	 *   the source's start boundary, preserving the full source conversation.
	 *   When false, the forked session starts at the fork point (the source's
	 *   end boundary or current HEAD), excluding the source's earlier history.
	 *   Use false when the source's history is large and would cause context
	 *   overflow (e.g. forking from an old, long-running session).
	 */
	forkFromSession(session_id: string, options?: { preserveHistory?: boolean }): SessionDescriptor {
		const source = this.sessions.get(session_id);
		if (!source) {
			throw new Error(`Session not found: ${session_id}`);
		}
		const previousActive =
			this.activeSessionId && this.activeSessionId !== source.session_id
				? this.sessions.get(this.activeSessionId)
				: undefined;

		const preserveHistory = options?.preserveHistory ?? true;
		const forkAtEventId =
			source.event_range.end_event_id === "HEAD"
				? this.store.head ?? source.event_range.start_event_id
				: source.event_range.end_event_id;
		if (source.event_range.end_event_id === "HEAD") {
			this.activeSessionId = source.session_id;
			this.activeThreadId = source.thread_id;
			this._promoteThreadToActive(source.thread_id);
		}

		const forked = this.createSession("fork", source.name, {
			parentSessionId: source.session_id,
			startEventId: preserveHistory ? source.event_range.start_event_id : forkAtEventId,
			summaryEventId: source.summary_event_id,
			threadId: source.thread_id,
		});

		const closesPrevious = previousActive?.event_range.end_event_id === "HEAD";
		const forkedEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_FORKED",
			payload: {
				new_session_id: forked.session_id,
				parent_session_id: source.session_id,
				fork_at_event_id: forkAtEventId,
				name: forked.name,
				start_event_id: forked.event_range.start_event_id,
				summary_event_id: forked.summary_event_id,
				context_parent_session_id: forked.context_parent_session_id,
				created_at: forked.created_at,
				closes_session_id: closesPrevious ? previousActive!.session_id : undefined,
			},
			thread_id: forked.thread_id,
		});
		if (closesPrevious) {
			previousActive!.event_range.end_event_id = forkedEvent.event_id;
			this._persistIndex();
		}

		return forked;
	}

	/**
	 * If the active session is a closed historical view, make it writable before
	 * appending a prompt. We reuse an existing open continuation when possible;
	 * otherwise we create one in a fresh thread and prepend the closed source's
	 * context via context_parent_session_id.
	 */
	ensureActiveSessionWritable(reason?: string): SessionDescriptor | undefined {
		const activeId = this.activeSessionId;
		if (!activeId) return undefined;
		const active = this.sessions.get(activeId);
		if (!active || active.event_range.end_event_id === "HEAD") return active;

		const reusable = Array.from(this.sessions.values())
			.filter((session) =>
				session.context_parent_session_id === active.session_id &&
				session.event_range.end_event_id === "HEAD"
			)
			.sort((a, b) => b.created_at - a.created_at)[0];
		if (reusable) {
			this.switchToExistingSession(reusable.session_id, reason ?? "continue historical session", {
				closePrevious: "never",
				background: true,
			});
			return reusable;
		}

		const thread = this._createThreadRecord(active.name);
		const continuation = this.createSession("fork", active.name, {
			parentSessionId: active.session_id,
			contextParentSessionId: active.session_id,
			threadId: thread.thread_id,
			startEventId: this.store.head ?? active.event_range.end_event_id,
			closeActive: false,
		});
		this.store.append({
			actor_id: "runtime",
			type: "SESSION_JUMPED",
			payload: {
				target_session_id: active.session_id,
				reopened_as: continuation.session_id,
				reason: reason ?? "continue historical session",
				direct: true,
				background: true,
			},
			thread_id: continuation.thread_id,
		});
		this._persistIndex();
		return continuation;
	}

	/**
	 * Return the newest open continuation for a closed visible session.
	 *
	 * Internal continuations are hidden from the history tree, so selecting the
	 * visible source should land on its writable continuation when one exists.
	 */
	getOpenContinuationForSession(session_id: string): SessionDescriptor | undefined {
		return Array.from(this.sessions.values())
			.filter((session) =>
				session.context_parent_session_id === session_id &&
				session.event_range.end_event_id === "HEAD"
			)
			.sort((a, b) => b.created_at - a.created_at)[0];
	}

	/**
	 * Resolve a UI-visible history node to the session that should become active.
	 * Open targets switch directly; closed targets reuse their open continuation
	 * when present, otherwise they remain inspect-only and switch directly.
	 */
	resolveSwitchTargetSession(session_id: string): SessionDescriptor {
		const target = this.sessions.get(session_id);
		if (!target) {
			throw new Error(`Session not found: ${session_id}`);
		}
		if (target.event_range.end_event_id === "HEAD") {
			return target;
		}
		return this.getOpenContinuationForSession(session_id) ?? target;
	}

	/**
	 * Jump to a session in the history tree.
	 *
	 * - Target is already active: no-op.
	 * - Target is still open (`end_event_id === "HEAD"`): switch to it directly.
	 * - Target is closed: reopen it by forking (new session reuses the target's
	 *   start boundary so its conversation history is preserved).
	 *
	 * Emits SESSION_JUMPED so the reactor can refresh its projection.
	 */
	jumpToSession(session_id: string, reason?: string): { descriptor: SessionDescriptor; reopened: boolean } {
		const target = this.sessions.get(session_id);
		if (!target) {
			throw new Error(`Session not found: ${session_id}`);
		}
		if (session_id === this.activeSessionId && target.event_range.end_event_id === "HEAD") {
			return { descriptor: target, reopened: false };
		}

		if (target.event_range.end_event_id === "HEAD") {
			this.switchToExistingSession(target.session_id, reason);
			return { descriptor: target, reopened: false };
		}

		const reopened = this.forkFromSession(session_id);
		this.store.append({
			actor_id: "runtime",
			type: "SESSION_JUMPED",
			payload: { target_session_id: session_id, reopened_as: reopened.session_id, reason },
			thread_id: reopened.thread_id,
		});
		return { descriptor: reopened, reopened: true };
	}

	/**
	 * List all sessions.
	 */
	listSessions(): SessionDescriptor[] {
		return Array.from(this.sessions.values()).sort((a, b) => b.created_at - a.created_at);
	}

	/**
	 * Switch to a different session.
	 */
	switchTo(session_id: string): void {
		const target = this.sessions.get(session_id);
		if (!target) {
			throw new Error(`Session not found: ${session_id}`);
		}
		this.activeSessionId = target.session_id;
		this.activeThreadId = target.thread_id;
		this._promoteThreadToActive(target.thread_id);
		this._persistIndex();
	}

	/**
	 * Switch to an existing session without reopening/forking it.
	 *
	 * This is intentionally different from jumpToSession(): closed sessions stay
	 * closed, so the UI can inspect them without creating another branch.
	 */
	switchToExistingSession(
		session_id: string,
		reason?: string,
		options: SwitchToExistingSessionOptions = {},
	): SessionDescriptor {
		const target = this.sessions.get(session_id);
		if (!target) {
			throw new Error(`Session not found: ${session_id}`);
		}
		// `background: true` marks a scheduler-driven switch (it hops into the
		// task's pinned session and hops back). Those must never promote a
		// background thread — only an explicit user navigation does.
		const userInitiated = options.background !== true;
		if (session_id === this.activeSessionId && target.thread_id === this.activeThreadId) {
			// Already here — still promote, otherwise a user sitting in a
			// background thread never gets it promoted (the switch that brought
			// them here may have been the scheduler's).
			if (userInitiated && this._promoteThreadToActive(target.thread_id)) {
				this._persistIndex();
			}
			return target;
		}
		const previousActive =
			this.activeSessionId && this.activeSessionId !== target.session_id
				? this.sessions.get(this.activeSessionId)
				: undefined;
		this.activeSessionId = target.session_id;
		this.activeThreadId = target.thread_id;
		if (userInitiated) this._promoteThreadToActive(target.thread_id);
		// Which session does this switch close? Computed BEFORE append so the
		// event carries the boundary mutation (index = projection of the log).
		const closePrevious = options.closePrevious ?? "same-thread";
		const closesTarget =
			previousActive?.event_range.end_event_id === "HEAD" &&
			(closePrevious === "always" ||
				(closePrevious === "same-thread" && previousActive.thread_id === target.thread_id))
				? previousActive
				: undefined;
		const jumpedEvent = this.store.append({
			actor_id: "runtime",
			type: "SESSION_JUMPED",
			payload: {
				target_session_id: target.session_id,
				reason,
				direct: true,
				background: options.background,
				closes_session_id: closesTarget?.session_id,
			},
			thread_id: target.thread_id,
		});
		if (closesTarget) {
			closesTarget.event_range.end_event_id = jumpedEvent.event_id;
		}
		this._persistIndex();
		return target;
	}

	/**
	 * Get a session by ID.
	 */
	getSession(session_id: string): SessionDescriptor | undefined {
		return this.sessions.get(session_id);
	}

	/**
	 * Get session projection by ID.
	 */
	getSessionProjection(session_id: string): SessionProjection | undefined {
		const desc = this.sessions.get(session_id);
		if (!desc) return undefined;
		return new SessionProjection(
			this.store,
			desc,
			(id) => this.sessions.get(id),
			this._resolveSourceContext,
		);
	}

	/**
	 * Update session name.
	 */
	renameSession(session_id: string, name: string): void {
		const desc = this.sessions.get(session_id);
		if (!desc) return;
		desc.name = name;
		// Renames must be in the log so the index remains a pure projection.
		this.store.append({
			actor_id: "runtime",
			type: "SESSION_RENAMED",
			payload: { session_id, name },
			thread_id: desc.thread_id,
		});
		this._persistIndex();
	}

	/**
	 * Get the active session ID.
	 */
	getActiveSessionId(): string | undefined {
		return this.activeSessionId;
	}

	getActiveThreadId(): string | undefined {
		return this.activeThreadId;
	}

	getActiveThread(): ThreadDescriptor | undefined {
		return this.activeThreadId ? this.threads.get(this.activeThreadId) : undefined;
	}

	/**
	 * Create a new thread (conversation). Threads are the isolation unit —
	 * events are tagged with thread_id. Creates the first session in the thread.
	 */
	createThread(name?: string, created_by: SessionDescriptor["created_by"] = "user_explicit"): ThreadDescriptor {
		// Scheduler-created threads are background threads: they exist to
		// isolate automated/scheduled turns from the interactive thread.
		// Background threads are never auto-selected as the active thread on
		// reload (see _loadIndex), so a leftover scheduled thread cannot
		// hijack the chat after a restart.
		const status: ThreadDescriptor["status"] = created_by === "schedule" ? "background" : "active";
		const thread = this._createThreadRecord(name, status);
		this.createSession(created_by, name, { threadId: thread.thread_id });
		this._persistIndex();
		return thread;
	}

	/**
	 * Adopt a CALLER-SUPPLIED thread id — the multi-tenant entry point.
	 *
	 * SDK embedders map their own tenant/user identity onto `threadId` (e.g.
	 * "user-1024"). Threads are the isolation unit: events are tagged with
	 * thread_id and `SessionProjection.buildContext()` filters by it, so two
	 * ids never see each other's history while sharing one event log.
	 *
	 * Idempotent by construction — the whole point is that a returning user
	 * passes the same id and lands back in their own conversation:
	 *   - unknown id  → create the thread record with that exact id + a session
	 *   - known id    → activate its open (HEAD) session, else start a new one
	 *
	 * Unlike createThread() this never invents an id, so the mapping stays
	 * owned by the caller and survives restarts with no side table.
	 */
	useThread(threadId: string, name?: string): ThreadDescriptor {
		const existing = this.threads.get(threadId);
		if (!existing) {
			const thread = this._createThreadRecord(name, "active", threadId);
			this.createSession("user_explicit", name, { threadId: thread.thread_id, closeActive: false });
			this._persistIndex();
			return thread;
		}

		// Reuse the thread's open session so a reconnecting user continues the
		// same conversation instead of fragmenting it into a new branch.
		let open: SessionDescriptor | undefined;
		for (const session of this.sessions.values()) {
			if (session.thread_id !== threadId) continue;
			if (session.event_range.end_event_id !== "HEAD") continue;
			if (!open || session.created_at > open.created_at) open = session;
		}
		if (open) {
			// closeActive: never — closing another tenant's live session because
			// this one connected would corrupt their range.
			this.activeSessionId = open.session_id;
			this.activeThreadId = open.thread_id;
			this._promoteThreadToActive(open.thread_id);
			this._persistIndex();
		} else {
			this.createSession("user_explicit", name, { threadId, closeActive: false });
			this._persistIndex();
		}
		return existing;
	}

	/**
	 * Dispose the session manager. Closes any read-only source stores opened
	 * for zero-copy cross-workspace forks.
	 */
	dispose(): void {
		for (const entry of this.externalSources.values()) {
			if (!entry) continue;
			try {
				entry.manager.dispose();
				entry.store.close();
			} catch {
				/* best-effort */
			}
		}
		this.externalSources.clear();
	}

	/**
	 * Resolve a cross-workspace fork source into a built context (zero-copy
	 * fork). Opens the source workspace's event store READ-ONLY (cached per
	 * workspace, closed on dispose) and builds the source session's context
	 * clamped to fork_at_event_id. Degrades to undefined — never throws —
	 * when the source workspace/session is gone.
	 */
	private _resolveSourceContext: ResolveSourceContext = (ref: SessionSourceRef): BuiltContext | undefined => {
		if (ref.workspace_id === this.store.workspace_id) {
			// Same workspace: resolve against our own index (defensive — the
			// fork path only writes source_ref for cross-workspace forks).
			const desc = this.sessions.get(ref.session_id);
			if (!desc) return undefined;
			const nextAfter = this.store.query({ after: ref.fork_at_event_id, limit: 1 })[0];
			return new SessionProjection(this.store, {
				...desc,
				event_range: {
					...desc.event_range,
					end_event_id: nextAfter ? nextAfter.event_id : desc.event_range.end_event_id,
				},
			}, (id) => this.sessions.get(id), this._resolveSourceContext).buildContext();
		}

		let entry = this.externalSources.get(ref.workspace_id);
		if (entry === undefined) {
			entry = this._openExternalSource(ref.workspace_id);
			this.externalSources.set(ref.workspace_id, entry);
		}
		if (entry === null) return undefined;

		const sourceDesc = entry.manager.sessions.get(ref.session_id);
		if (!sourceDesc) return undefined;
		// Clamp the source range to the fork point so events appended to the
		// source AFTER the fork do not leak into this session's context.
		// event_range.end is an EXCLUSIVE `before` bound in store.query, but
		// fork_at_event_id must be INCLUDED — use the next event after it as
		// the bound (or keep the source's own end when nothing follows).
		const nextAfterFork = entry.store.query({ after: ref.fork_at_event_id, limit: 1 })[0];
		const clamped: SessionDescriptor = {
			...sourceDesc,
			event_range: {
				...sourceDesc.event_range,
				end_event_id: nextAfterFork ? nextAfterFork.event_id : sourceDesc.event_range.end_event_id,
			},
		};
		try {
			return new SessionProjection(
				entry.store,
				clamped,
				(id) => entry!.manager.sessions.get(id),
				entry.manager._resolveSourceContext,
			).buildContext();
		} catch {
			return undefined; // corrupt source store — degrade, never break the fork
		}
	};

	/** Open another workspace's event store read-only, or null when missing. */
	private _openExternalSource(workspaceId: string): { store: EventStore & { close(): void }; manager: SessionManager } | null {
		try {
			// Check existence WITHOUT the usual path helpers: getWorkspaceDir()
			// mkdirs as a side effect, which would fabricate empty workspace
			// dirs for deleted sources.
			const dbPath = join(getAgentDir(), "workspaces", workspaceId, "events.sqlite");
			if (!existsSync(dbPath)) return null;
			const store = new SqliteEventStore(workspaceId, dbPath, "fork_source_reader");
			const manager = new SessionManager(store, store);
			return { store, manager };
		} catch {
			return null;
		}
	}

	// =========================================================================
	// Internal Methods
	// =========================================================================

	private _loadIndex(): void {
		const index = this.sessionStore?.getSessionIndex();
		if (!index) {
			// No snapshot. The log may still contain SESSION_* events (snapshot
			// lost/corrupted, or a fresh checkout of an existing event db):
			// rebuild the index as a pure projection of the log.
			const rebuilt = rebuildSessionIndex(this.store);
			if (rebuilt.sessions.size === 0 && rebuilt.threads.size === 0) return;
			this.threads = rebuilt.threads;
			this.sessions = rebuilt.sessions;
			this._selectActiveFromIndex({
				threads: Array.from(rebuilt.threads.values()),
				sessions: Array.from(rebuilt.sessions.values()),
			});
			return;
		}

		// Load threads (without selecting an active thread yet) and index all
		// sessions first. The active thread is chosen deterministically below.
		for (const thread of index.threads ?? []) {
			this.threads.set(thread.thread_id, thread);
		}
		for (const session of index.sessions) {
			this.sessions.set(session.session_id, session);
		}

		// Self-heal: replay SESSION_* / THREAD_* events the snapshot missed
		// (crash between event append and snapshot persist). The reducer is the
		// same one the live path conceptually applies, so replay converges.
		const state: SessionIndexState = { threads: this.threads, sessions: this.sessions };
		replayIndexEventsAfter(state, this.store, index.watermark_sequence ?? 0);

		this._selectActiveFromIndex(index);
	}

	private _selectActiveFromIndex(index: Pick<SessionIndex, "threads" | "sessions">): void {
		// Deterministically select the active thread on reload.
		//
		// Background threads (created by the scheduler for automated tasks)
		// must NEVER be auto-selected as the interactive active thread —
		// otherwise a leftover background thread hijacks the user's chat on
		// every restart (the bug where user prompts landed in the wrong thread).
		//
		// Among interactive threads (status "active"), pick the one whose most
		// recent session was created latest — i.e. the thread the user was
		// actually last working in. This replaces the previous "last active
		// thread wins" behavior, which depended on storage iteration order and
		// could nondeterministically select a stale thread.
		const interactiveThreadIds = new Set(
			(index.threads ?? []).filter((t) => t.status === "active").map((t) => t.thread_id),
		);
		if (interactiveThreadIds.size > 0) {
			// Build a thread-created-at lookup so ties on session.created_at are
			// broken deterministically by thread recency (never by iteration order).
			const threadCreatedAt = new Map<string, number>();
			for (const thread of index.threads ?? []) {
				threadCreatedAt.set(thread.thread_id, thread.created_at);
			}
			let bestThreadId: string | undefined;
			let bestSessionCreatedAt = -1;
			let bestThreadCreatedAt = -1;
			for (const session of this.sessions.values()) {
				if (!interactiveThreadIds.has(session.thread_id)) continue;
				const tca = threadCreatedAt.get(session.thread_id) ?? 0;
				// Pick the thread whose latest session is newest; break ties by
				// thread recency so the result is deterministic.
				if (
					session.created_at > bestSessionCreatedAt ||
					(session.created_at === bestSessionCreatedAt && tca > bestThreadCreatedAt)
				) {
					bestSessionCreatedAt = session.created_at;
					bestThreadCreatedAt = tca;
					bestThreadId = session.thread_id;
				}
			}
			// Fallback: if an interactive thread has no sessions, take the most
			// recently created interactive thread.
			if (!bestThreadId) {
				bestThreadId = (index.threads ?? [])
					.filter((t) => t.status === "active")
					.sort((a, b) => b.created_at - a.created_at)[0]?.thread_id;
			}
			if (bestThreadId) this.activeThreadId = bestThreadId;
		}

		// Resolve the active session: the one at HEAD within the active thread.
		for (const session of this.sessions.values()) {
			if (session.event_range.end_event_id === "HEAD" && session.thread_id === this.activeThreadId) {
				this.activeSessionId = session.session_id;
			}
		}
	}

	private _persistIndex(): void {
		if (!this.sessionStore) return;
		const index: SessionIndex = {
			threads: Array.from(this.threads.values()),
			sessions: Array.from(this.sessions.values()),
			// Snapshot watermark: everything up to the store's current head is
			// reflected in this snapshot (mutations happen right after append).
			watermark_sequence: this.store.head_sequence,
		};
		this.sessionStore.saveSessionIndex(index);
	}

	private _generateSessionId(): string {
		const timestamp = Date.now().toString(36);
		return `sess_${timestamp}_${cryptoRandomSuffix()}`;
	}

	/** Create a thread record (no session). Used by createThread and createSession auto-thread fallback. The status defaults to active; pass background for scheduler threads. `explicitId` adopts a caller-supplied id verbatim (useThread / SDK multi-tenancy) instead of generating one. */
	private _createThreadRecord(name?: string, status: ThreadDescriptor["status"] = "active", explicitId?: string): ThreadDescriptor {
		const thread: ThreadDescriptor = {
			thread_id: explicitId ?? this._generateThreadId(),
			workspace_id: this.store.workspace_id,
			name,
			created_at: Date.now(),
			status,
		};
		this.threads.set(thread.thread_id, thread);
		this.activeThreadId = thread.thread_id;
		// The thread record rides on the next SESSION_CREATED event for this
		// thread (embedded `thread` payload) so replay can recreate it.
		this.pendingThreadEvents.add(thread.thread_id);
		return thread;
	}

	/** Consume the pending-thread marker and return the embeddable payload. */
	private _takePendingThreadEvent(
		threadId: string,
	): { thread_id: string; name?: string; created_at: number; status: ThreadDescriptor["status"] } | undefined {
		if (!this.pendingThreadEvents.has(threadId)) return undefined;
		this.pendingThreadEvents.delete(threadId);
		const thread = this.threads.get(threadId);
		if (!thread) return undefined;
		return {
			thread_id: thread.thread_id,
			name: thread.name,
			created_at: thread.created_at,
			status: thread.status,
		};
	}

	/**
	 * Promote a background thread to active when the user explicitly
	 * navigates into it (history tree click / jump / switch). Once a user
	 * has interacted with a scheduled thread, it should participate in
	 * active-thread selection on future reloads like any interactive thread.
	 * No-op for threads that are already active. Closed threads are not
	 * re-opened here.
	 *
	 * Returns true when the status actually changed, so callers that are not
	 * already persisting the index can do so.
	 */
	private _promoteThreadToActive(threadId: string | undefined): boolean {
		if (!threadId) return false;
		const thread = this.threads.get(threadId);
		if (thread?.status !== "background") return false;
		thread.status = "active";
		// Status changes must be in the log so the index remains a pure projection.
		this.store.append({
			actor_id: "runtime",
			type: "THREAD_STATUS_CHANGED",
			payload: { thread_id: threadId, status: "active" },
			thread_id: threadId,
		});
		return true;
	}

	private _generateThreadId(): string {
		const timestamp = Date.now().toString(36);
		return `thread_${timestamp}_${cryptoRandomSuffix()}`;
	}
}
