/**
 * SessionLockManager — per-session mutex for scheduled tasks.
 *
 * A "session" in scheduler-land is identified by a string. For tasks
 * running in the sidecar's current active session, that's
 * `facade.runtime.sessionManager.getActiveSessionId()`. For tasks with
 * SessionTarget: "new", the dispatcher picks (or creates) a new session
 * id and reports it back via `acquired.lockedSessionId`.
 *
 * The lock is held for the entire duration of the task's `dispatcher.dispatch`
 * call. If the task exceeds its `timeoutMinutes`, the engine fires the
 * `onTimeout` callback which aborts the running turn and releases the lock
 * so queued tasks can proceed.
 *
 * Three concurrency policies are supported:
 *   - "skip"    → drop the new fire and record status: "skipped"
 *   - "queue"   → enqueue the task and fire it when the lock is released
 *   - "preempt" → abort the holder and run the new task immediately
 *
 * Queued tasks are dispatched in FIFO order. The same task id can only
 * appear once in a queue at a time (enqueueing an already-queued task is
 * a no-op). All operations are synchronous; the manager is single-threaded
 * by virtue of running on the Node.js event loop.
 */

import type { ConcurrencyPolicy, ScheduledTask } from "../../../packages/protocol/index.js";

/** Result of an acquire attempt. */
export type AcquireResult =
	/** Got the lock. `lockedSessionId` is the canonical session id to use. */
	| { kind: "acquired"; lockedSessionId: string }
	/** Lock was busy and policy === "skip". Caller should record "skipped". */
	| { kind: "skipped"; holderTaskId: string }
	/** Lock was busy and policy === "queue". Task is now in the queue. */
	| { kind: "queued"; holderTaskId: string };

interface LockHolder {
	taskId: string;
	acquiredAt: number;
	timeoutMs: number;
	timeoutHandle: NodeJS.Timeout | null;
}

export class SessionLockManager {
	/** Per-session holder (only one task per session at a time). */
	private holders = new Map<string, LockHolder>();
	/** Per-session FIFO queue of waiting tasks. */
	private queues = new Map<string, Array<{ task: ScheduledTask; enqueuedAt: number }>>();
	/** Global task-id index so we can find a task across all sessions for timeouts. */
	private byTaskId = new Map<string, string /* sessionId */>();
	/** Hook called when a task times out. Engine wires this to abort + record. */
	public onTimeout: ((taskId: string, sessionId: string) => void) | null = null;

	/**
	 * Try to acquire the lock for `task` on `sessionId`.
	 *
	 * - If the session is free, returns { kind: "acquired" } and the caller
	 *   should run the task.
	 * - If busy and policy === "skip", returns { kind: "skipped" } and the
	 *   caller records the run as skipped.
	 * - If busy and policy === "queue", returns { kind: "queued" } and the
	 *   caller does NOT run anything; the task will fire when the current
	 *   holder releases.
	 * - If busy and policy === "preempt", the current holder is released
	 *   (with onTimeout fired so the engine can abort + record a timeout
	 *   run), and { kind: "acquired" } is returned.
	 */
	acquire(
		task: ScheduledTask,
		sessionId: string,
		policy: ConcurrencyPolicy,
	): AcquireResult {
		// Already held by this task (shouldn't happen but be safe).
		if (this.byTaskId.get(task.id) === sessionId) {
			return { kind: "acquired", lockedSessionId: sessionId };
		}

		const existing = this.holders.get(sessionId);
		if (!existing) {
			this._setHolder(task, sessionId);
			return { kind: "acquired", lockedSessionId: sessionId };
		}

		switch (policy) {
			case "skip":
				return { kind: "skipped", holderTaskId: existing.taskId };

			case "queue": {
				// Don't double-enqueue the same task.
				const q = this.queues.get(sessionId) ?? [];
				if (!q.some((e) => e.task.id === task.id)) {
					q.push({ task, enqueuedAt: Date.now() });
					this.queues.set(sessionId, q);
				}
				return { kind: "queued", holderTaskId: existing.taskId };
			}

			case "preempt": {
				// Release the existing holder; the engine's onTimeout hook
				// will abort its turn and append a "timeout" run record.
				const oldTaskId = existing.taskId;
				this._clearHolder(sessionId);
				if (this.onTimeout) this.onTimeout(oldTaskId, sessionId);
				this._setHolder(task, sessionId);
				return { kind: "acquired", lockedSessionId: sessionId };
			}
		}
	}

	/** Release the lock for `taskId`. If a task is queued, dispatch it next. */
	release(taskId: string, onDispatchNext: (task: ScheduledTask) => void): void {
		const sessionId = this.byTaskId.get(taskId);
		if (!sessionId) return;
		this._clearHolder(sessionId);
		// Run next queued task for this session, if any.
		const q = this.queues.get(sessionId);
		if (q && q.length > 0) {
			const next = q.shift()!;
			if (q.length === 0) this.queues.delete(sessionId);
			this._setHolder(next.task, sessionId);
			// Caller is responsible for actually running it (so the engine can
			// wire up the timeout / completion bookkeeping uniformly).
			onDispatchNext(next.task);
		}
	}

	/** For tests / diagnostics. */
	inspect(sessionId: string): { holder: string | null; queueLength: number } {
		const h = this.holders.get(sessionId);
		const q = this.queues.get(sessionId) ?? [];
		return { holder: h?.taskId ?? null, queueLength: q.length };
	}

	/** Returns the active session id, or null if free. */
	holderOf(sessionId: string): string | null {
		return this.holders.get(sessionId)?.taskId ?? null;
	}

	/**
	 * Re-key an existing lock from `oldSessionId` to `newSessionId`. Used by
	 * the engine to migrate the placeholder lock acquired for
	 * SessionTarget: "new" tasks (which initially uses a `pending:${taskId}`
	 * key) to the real session id the dispatcher reports back. This way,
	 * two "new" tasks fired into different sessions don't falsely share
	 * the same lock key, and a "new" task + a "current" task targeting
	 * the same session DO block each other.
	 *
	 * If the new key is ALREADY held by a different task, we do nothing
	 * (do not clobber). The caller should treat that as "another task beat
	 * me to this session; the original lock will resolve itself".
	 */
	reassign(oldSessionId: string, newSessionId: string): void {
		if (oldSessionId === newSessionId) return;
		const h = this.holders.get(oldSessionId);
		if (!h) return;
		if (this.holders.has(newSessionId)) {
			// Target session already held by another task. Don't overwrite.
			return;
		}
		this.holders.delete(oldSessionId);
		this.holders.set(newSessionId, h);
		this.byTaskId.set(h.taskId, newSessionId);
		// Migrate the queue too: any tasks queued behind this one for the
		// same session should be re-keyed.
		const q = this.queues.get(oldSessionId);
		if (q && q.length > 0) {
			this.queues.set(newSessionId, q);
			this.queues.delete(oldSessionId);
		}
	}

	/** Clear everything (used on dispose). */
	dispose(): void {
		for (const h of this.holders.values()) {
			if (h.timeoutHandle) clearTimeout(h.timeoutHandle);
		}
		this.holders.clear();
		this.queues.clear();
		this.byTaskId.clear();
	}

	// --- internals ---

	private _setHolder(task: ScheduledTask, sessionId: string): void {
		const timeoutMs = (task.timeoutMinutes ?? 0) * 60_000;
		let timeoutHandle: NodeJS.Timeout | null = null;
		if (timeoutMs > 0) {
			timeoutHandle = setTimeout(() => {
				// The engine's onTimeout hook will release the lock + abort.
				if (this.onTimeout) this.onTimeout(task.id, sessionId);
			}, timeoutMs);
			if (typeof (timeoutHandle as { unref?: () => void }).unref === "function") {
				(timeoutHandle as { unref: () => void }).unref();
			}
		}
		this.holders.set(sessionId, {
			taskId: task.id,
			acquiredAt: Date.now(),
			timeoutMs,
			timeoutHandle,
		});
		this.byTaskId.set(task.id, sessionId);
	}

	private _clearHolder(sessionId: string): void {
		const h = this.holders.get(sessionId);
		if (!h) return;
		if (h.timeoutHandle) clearTimeout(h.timeoutHandle);
		this.holders.delete(sessionId);
		this.byTaskId.delete(h.taskId);
	}
}