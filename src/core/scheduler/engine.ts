/**
 * Scheduler engine — computes nextRunAt for any ScheduleSpec, owns the
 * in-memory task cache, and runs a setTimeout-based dispatcher per scope.
 *
 * Architecture:
 *   - One SchedulerEngine instance per scope (main, each workspace).
 *   - On start: load tasks.json, for each enabled task compute nextRunAt,
 *     schedule a setTimeout for the soonest fire, and re-schedule on tick.
 *   - On tick: lock the task (avoid re-entry), emit SCHEDULED_TASK_FIRED,
 *     dispatch to the facade (facade.prompt), wait for completion, persist
 *     the run record, and (if recurring) compute nextRunAt and schedule
 *     again. If endAt has passed, mark the task disabled.
 *   - API: load / reload / create / update / delete / runNow — all mutate
 *     in-memory cache and atomically rewrite tasks.json.
 *
 * Concurrency model:
 *   - Single Node.js process ⇒ setTimeout + JS event loop, so there's no
 *     thread-safety hazard per se. But we guard each task with a `running`
 *     flag so an overlap (e.g. clock skew, manual run-now during scheduled
 *     fire) can't double-dispatch.
 *
 * Event emission:
 *   - All events are written to stdout by the RPC layer (engine doesn't
 *     know about stdout). The engine returns an event emitter-like object
 *     that callers (rpc-mode.ts) can subscribe to.
 */

import { EventEmitter } from "node:events";
import type { ConcurrencyPolicy, ScheduledTask, ScheduledTaskSummary, ScheduledTaskRun, SessionTarget } from "../../../packages/protocol/index.js";
import { SessionLockManager, type AcquireResult } from "./locks.js";
import { cronNextRun } from "./cron.js";
import { defaultTaskName, generateTaskId, validateScheduleSpec } from "./types.js";
import { appendRun, getSchedulerDir, readRuns, readTaskFresh, readTasks, writeTasks } from "./store.js";
import { SchedulerScopeLock } from "./scope-lock.js";

/**
 * Node's setTimeout clamps delays above 2^31-1 ms (~24.8 days) to 1ms.
 * Waits longer than this are chunked: sleep MAX_TIMEOUT_MS, then recompute
 * the remaining delay (scheduleOne re-entry).
 */
const MAX_TIMEOUT_MS = 2_147_000_000; // just under 2^31-1, ~24.85 days

/**
 * fireTask refuses fires that arrive more than this many ms before their
 * scheduled time — a timer that somehow fired early (clock jump, clamped
 * overflow on an old build) reschedules instead of running the task early.
 */
const EARLY_FIRE_TOLERANCE_MS = 60_000;

// --- nextRunAt: the heart of the engine -------------------------------------

/**
 * Compute the next fire time for a task at or after `from` (epoch ms).
 * Returns null if the schedule can no longer fire (endAt passed, disabled,
 * or no future match within reason).
 */
export function nextRunAt(task: ScheduledTask, from: number = Date.now()): number | null {
	if (!task.enabled) return null;
	const endAt = task.schedule.endAt;
	if (typeof endAt === "number" && endAt <= from) return null;

	const startAt = task.schedule.startAt ?? task.createdAt;
	const base = Math.max(from, startAt);

	const spec = task.schedule;
	switch (spec.mode) {
		case "every_n_minutes": {
			if (!spec.everyN) return null;
			const n = Math.max(1, spec.everyN.n);
			// Align to N-minute boundaries in UTC.
			const intervalMs = n * 60_000;
			const next = Math.ceil(base / intervalMs) * intervalMs;
			if (typeof endAt === "number" && next > endAt) return null;
			return next;
		}
		case "every_n_hours": {
			if (!spec.everyN) return null;
			const n = Math.max(1, spec.everyN.n);
			const intervalMs = n * 3600_000;
			const next = Math.ceil(base / intervalMs) * intervalMs;
			if (typeof endAt === "number" && next > endAt) return null;
			return next;
		}
		case "daily":
		case "weekdays":
		case "weekly":
		case "monthly": {
			const times = (spec.times ?? []).slice().sort((a, b) => a.hour - b.hour || a.minute - b.minute);
			if (times.length === 0) return null;
			return nextForDateAnchoredSchedule(spec.mode, times, spec.weekdays ?? null, spec.daysOfMonth ?? null, base, endAt);
		}
		case "cron": {
			if (!spec.cron?.expression) return null;
			const next = cronNextRun(spec.cron.expression, base);
			if (next === null) return null;
			if (typeof endAt === "number" && next > endAt) return null;
			return next;
		}
		default:
			return null;
	}
}

function nextForDateAnchoredSchedule(
	mode: "daily" | "weekdays" | "weekly" | "monthly",
	times: Array<{ hour: number; minute: number }>,
	weekdays: number[] | null,
	daysOfMonth: number[] | null,
	base: number,
	endAt: number | undefined,
): number | null {
	// We scan forward at most 366 days.
	const horizon = base + 366 * 24 * 3600_000;
	const baseDate = new Date(base);

	// Start scanning from the beginning of the base minute.
	let candidate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), baseDate.getHours(), baseDate.getMinutes(), 0, 0).getTime();
	// Always look strictly AFTER `base`, so bump by 1 minute if equal.
	if (candidate <= base) candidate += 60_000;

	while (candidate <= horizon) {
		if (typeof endAt === "number" && candidate > endAt) return null;
		const d = new Date(candidate);
		if (matchesDateMode(mode, d, weekdays, daysOfMonth)) {
			for (const t of times) {
				if (t.hour === d.getHours() && t.minute === d.getMinutes()) {
					return candidate;
				}
			}
		}
		candidate += 60_000; // 1-minute step is fine: max 366*24*60 = ~530k iterations
	}
	return null;
}

function matchesDateMode(
	mode: "daily" | "weekdays" | "weekly" | "monthly",
	d: Date,
	weekdays: number[] | null,
	daysOfMonth: number[] | null,
): boolean {
	const day = d.getDay(); // 0=Sun..6=Sat
	const date = d.getDate();
	switch (mode) {
		case "daily":
			return true;
		case "weekdays":
			return day >= 1 && day <= 5;
		case "weekly":
			return weekdays?.includes(day) ?? false;
		case "monthly":
			return daysOfMonth?.includes(date) ?? false;
	}
}

/**
 * Compute the next N fire times for preview / display purposes. Stops early
 * if endAt is set. Pure function — does not touch task state.
 */
export function nextNRuns(task: ScheduledTask, n: number, from: number = Date.now()): number[] {
	const out: number[] = [];
	let cursor = from;
	for (let i = 0; i < n; i++) {
		const next = nextRunAt({ ...task, lastRunAt: cursor }, cursor);
		if (next === null) break;
		out.push(next);
		cursor = next + 60_000;
	}
	return out;
}

// --- SchedulerEngine -------------------------------------------------------

export interface SchedulerEngineEvents {
	"task.fired": (taskId: string, eventId: string | undefined, sessionId: string) => void;
	"task.completed": (run: ScheduledTaskRun) => void;
}

export type SchedulerListener = (event: { type: keyof SchedulerEngineEvents; payload: unknown }) => void;

export interface Dispatcher {
	/**
	 * Dispatch the task's prompt to the agent. Implementations typically
	 * call `facade.prompt(prompt)`. The returned promise resolves when the
	 * turn is complete (or rejects on error). The eventId of the produced
	 * USER_MESSAGE event (if any) and the sessionId the prompt landed in
	 * should be returned.
	 *
	 * The lock acquired on the session (if any) is held for the lifetime
	 * of this promise. The engine calls release() once the promise settles.
	 */
	dispatch(task: ScheduledTask): Promise<{ eventId?: string; sessionId?: string; error?: string }>;
	/**
	 * Abort the in-flight turn for `taskId`. Called when the lock times
	 * out or when a "preempt" policy is firing off the current holder.
	 * The dispatcher should best-effort abort any active turn and resolve
	 * promptly; the engine then releases the lock and records a failed
	 * run with reason: "timeout".
	 */
	abort?(taskId: string): void;
}

export interface SchedulerEngineOptions {
	scope: "main" | "workspace";
	workspaceId?: string;
	dispatcher: Dispatcher;
	listener?: SchedulerListener;
	/** For tests: deterministic clock. Defaults to Date.now. */
	now?: () => number;
}

function unsupportedSessionTargetReason(task: ScheduledTask): string | null {
	const target = task.sessionTarget;
	if (!target || target.kind === "current") {
		return "legacy current session target requires migration";
	}
	if (target.kind === "pinned" && !target.sessionId) {
		return "pinned session target is missing sessionId";
	}
	return null;
}

export class SchedulerEngine {
	private readonly scope: "main" | "workspace";
	private readonly workspaceId: string | undefined;
	private readonly dispatcher: Dispatcher;
	private readonly listener: SchedulerListener | undefined;
	private readonly now: () => number;
	private tasks: Map<string, ScheduledTask> = new Map();
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private running: Set<string> = new Set();
	private recordedByTimeout: Set<string> = new Set();
	/** Per-session mutex for scheduled tasks. */
	private locks = new SessionLockManager();
	/** One sidecar has one runtime, and that runtime can process one prompt at a time. */
	private runtimeQueue: Promise<void> = Promise.resolve();
	/** Cached actual session id from the dispatcher for diagnostics. */
	private currentSessionId: string | undefined;
	private emitter = new EventEmitter();
	private stopped = false;
	/** Tracks whether the engine has been disposed. */
	private disposed = false;
	/**
	 * Cross-process singleton guard. Only the lock holder schedules timers;
	 * passive engines still serve CRUD (writes land in tasks.json and the
	 * active engine re-reads the file before each fire).
	 */
	private scopeLock: SchedulerScopeLock;
	/** True when another live process owns this scope's dispatch loop. */
	private passive = false;

	constructor(opts: SchedulerEngineOptions) {
		this.scope = opts.scope;
		this.workspaceId = opts.workspaceId;
		this.dispatcher = opts.dispatcher;
		this.listener = opts.listener;
		this.now = opts.now ?? Date.now;
		// When the lock times out (or is preempted), abort the in-flight turn
		// and record a "timeout" run row. The actual lock release + record
		// append happens in fireTask's finally block (or release() in the
		// queue/preempt paths) so the bookkeeping is consistent.
		this.locks.onTimeout = (taskId, sessionId) => {
			this.handleTimeout(taskId, sessionId);
		};
		this.scopeLock = new SchedulerScopeLock(getSchedulerDir(this.scope, this.workspaceId), this.now);
		// If the heartbeat discovers another process took the lock over (e.g.
		// this process was suspended long enough to look dead), demote to
		// passive: cancel all timers so we never double-dispatch against the
		// new owner. CRUD keeps working (writes land in tasks.json).
		this.scopeLock.onLost = () => {
			if (this.disposed || this.passive) return;
			this.passive = true;
			for (const t of this.timers.values()) clearTimeout(t);
			this.timers.clear();
			console.warn(
				`[scheduler] scope ${this.scope}${this.workspaceId ? `:${this.workspaceId}` : ""} lock lost to pid ${this.scopeLock.holderPid()}; demoted to passive`,
			);
		};
	}

	// --- lifecycle ---

	/** Load tasks from disk and schedule all enabled ones. */
	load(): void {
		if (this.disposed) return;
		const stored = readTasks(this.scope, this.workspaceId);
		this.tasks.clear();
		for (const t of stored) this.tasks.set(t.id, t);
		// Cross-process guard: if another live process already dispatches for
		// this scope, stay passive — no timers, no double-fire. CRUD is still
		// served from this engine and lands in tasks.json.
		if (!this.scopeLock.tryAcquire()) {
			this.passive = true;
			console.warn(
				`[scheduler] scope ${this.scope}${this.workspaceId ? `:${this.workspaceId}` : ""} is owned by pid ${this.scopeLock.holderPid()}; running passive (no dispatch)`,
			);
			return;
		}
		this.passive = false;
		this.scheduleAll();
		this.catchUpMissedRuns();
	}

	/**
	 * Force a re-read from disk. Returns the number of tasks now in memory.
	 * Useful when an external process edits tasks.json (e.g. the desktop
	 * bridge writing a task directly).
	 */
	reload(): number {
		this.load();
		return this.tasks.size;
	}

	/** Stop all timers; safe to call multiple times. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopped = true;
		for (const [, t] of this.timers) {
			clearTimeout(t);
		}
		this.timers.clear();
		this.locks.dispose();
		this.scopeLock.release();
		this.emitter.removeAllListeners();
	}

	/**
	 * Resolve the target session id for a task. Pinned tasks use their saved
	 * logical session id. For SessionTarget: new, the dispatcher creates a new
	 * session and reports its id back via dispatch().sessionId.
	 */
	private resolveTargetSessionId(task: ScheduledTask): string {
		const target = task.sessionTarget;
		if (!target) return `unsupported:${task.id}`;
		switch (target.kind) {
			case "pinned":
				return target.sessionId ?? `unsupported:${task.id}`;
			case "current":
				return `unsupported:${task.id}`;
			case "new":
				// The dispatcher picks / creates the actual session id. We use a
				// deterministic placeholder for the lock key; the real id replaces
				// it after dispatch returns. This is fine because the lock is
				// held for the entire dispatch promise.
				return `pending:${task.id}`;
		}
	}

	/**
	 * Called by the lock manager when a task's timeout fires (or a preempt
	 * overwrites the holder). Aborts the in-flight turn (if any) and
	 * records a "timeout" run. The lock is released by the lock manager
	 * immediately after, so queued tasks can proceed.
	 */
	private handleTimeout(taskId: string, _sessionId: string): void {
		const task = this.tasks.get(taskId);
		if (!task) return;
		try {
			this.dispatcher.abort?.(taskId);
		} catch {
			/* best-effort */
		}
		// Record the timeout run.
		const at = this.now();
		this.recordedByTimeout.add(taskId);
		const run: ScheduledTaskRun = {
			taskId,
			at,
			status: "failed",
			reason: task.timeoutMinutes && task.timeoutMinutes > 0
				? `timeout after ${task.timeoutMinutes}min`
				: "preempted by another task",
		};
		appendRun(this.scope, this.workspaceId, run);
		// Update the task's lastRun + runCount so the UI reflects reality.
		this.tasks.set(taskId, {
			...task,
			lastRunAt: at,
			lastRunStatus: "failed",
			updatedAt: this.now(),
			runCount: (task.runCount ?? 0) + 1,
		});
		this.persist();
		this.emit({ type: "task.completed", payload: run });
	}

	// --- task CRUD ---

	// --- task CRUD ---

	list(): ScheduledTaskSummary[] {
		const now = this.now();
		return Array.from(this.tasks.values())
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((t) => this.summarize(t, now));
	}

	get(id: string): ScheduledTaskSummary | null {
		const t = this.tasks.get(id);
		if (!t) return null;
		return this.summarize(t, this.now());
	}

	create(input: {
		name: string;
		prompt: string;
		schedule: ScheduledTask["schedule"];
		enabled?: boolean;
		createdBy?: "user" | "intent";
		sourceText?: string;
		startAt?: number;
		endAt?: number;
		sessionTarget?: SessionTarget;
		concurrencyPolicy?: ConcurrencyPolicy;
		timeoutMinutes?: number;
		maxRuns?: number;
	}): { ok: true; task: ScheduledTaskSummary } | { ok: false; error: string } {
		const validation = validateScheduleSpec(input.schedule);
		if (validation) return { ok: false, error: validation };

		const now = this.now();
		const task: ScheduledTask = {
			id: generateTaskId(),
			name: input.name.trim() || defaultTaskName(input.prompt),
			prompt: input.prompt,
			scope: this.scope,
			workspaceId: this.workspaceId,
			schedule: input.schedule,
			enabled: input.enabled ?? true,
			createdAt: now,
			updatedAt: now,
			createdBy: input.createdBy ?? "user",
			sourceText: input.sourceText,
			runCount: 0,
			sessionTarget: input.sessionTarget,
			concurrencyPolicy: input.concurrencyPolicy,
			timeoutMinutes: input.timeoutMinutes,
			maxRuns: input.maxRuns,
		};
		// Persist schedule.endAt / startAt into the embedded schedule so the
		// nextRunAt helper reads a consistent shape.
		task.schedule = {
			...task.schedule,
			startAt: input.startAt,
			endAt: input.endAt,
		};

		this.tasks.set(task.id, task);
		this.persist();
		this.scheduleOne(task);
		return { ok: true, task: this.summarize(task, now) };
	}

	update(
		id: string,
		patch: {
			name?: string;
			prompt?: string;
			schedule?: ScheduledTask["schedule"];
			enabled?: boolean;
			startAt?: number | null;
			endAt?: number | null;
			sessionTarget?: SessionTarget | null;
			concurrencyPolicy?: ConcurrencyPolicy | null;
			timeoutMinutes?: number | null;
			maxRuns?: number | null;
		},
	): { ok: true; task: ScheduledTaskSummary } | { ok: false; error: string } {
		const existing = this.tasks.get(id);
		if (!existing) return { ok: false, error: `Task not found: ${id}` };

		if (patch.schedule) {
			const validation = validateScheduleSpec(patch.schedule);
			if (validation) return { ok: false, error: validation };
		}

		// Build the new task. Filter patch to drop nulls (which mean "clear")
		// and apply the rest as overrides on top of existing.
		const filtered: Partial<ScheduledTask> = {};
		for (const [k, v] of Object.entries(patch)) {
			if (v === null) continue;
			(filtered as Record<string, unknown>)[k] = v;
		}
		const next: ScheduledTask = {
			...existing,
			...filtered,
			schedule: patch.schedule ?? existing.schedule,
			updatedAt: this.now(),
		};
		if (patch.startAt === null) delete next.schedule.startAt;
		else if (typeof patch.startAt === "number") next.schedule.startAt = patch.startAt;
		if (patch.endAt === null) delete next.schedule.endAt;
		else if (typeof patch.endAt === "number") next.schedule.endAt = patch.endAt;
		// Explicit clears: null = remove the field entirely.
		if (patch.sessionTarget === null) delete next.sessionTarget;
		if (patch.concurrencyPolicy === null) delete next.concurrencyPolicy;
		if (patch.timeoutMinutes === null) delete next.timeoutMinutes;
		if (patch.maxRuns === null) delete next.maxRuns;

		this.tasks.set(id, next);
		this.persist();
		// Cancel and reschedule so changes take effect immediately.
		this.cancelTimer(id);
		if (next.enabled) this.scheduleOne(next);
		return { ok: true, task: this.summarize(next, this.now()) };
	}

	delete(id: string): { ok: true; id: string } | { ok: false; error: string } {
		if (!this.tasks.has(id)) return { ok: false, error: `Task not found: ${id}` };
		this.cancelTimer(id);
		this.tasks.delete(id);
		this.persist();
		return { ok: true, id };
	}

	/** Fire a task immediately, regardless of its schedule. */
	async runNow(id: string): Promise<{ ok: true; taskId: string; at: number } | { ok: false; error: string }> {
		const task = this.tasks.get(id);
		if (!task) return { ok: false, error: `Task not found: ${id}` };
		const unsupported = unsupportedSessionTargetReason(task);
		if (unsupported) return { ok: false, error: unsupported };
		// Use a fresh in-memory copy so sessionTarget / concurrencyPolicy /
		// timeoutMinutes patches take effect on this run.
		const fresh = { ...task, updatedAt: this.now() };
		const at = this.now();
		// Fire-and-forget — actual completion is signaled via events.
		void this.fireTask(fresh, at, /*manual*/ true);
		return { ok: true, taskId: id, at };
	}

	history(id: string, limit = 50): ScheduledTaskRun[] {
		return readRuns(this.scope, this.workspaceId, id, limit);
	}

	// --- internals ---

	private summarize(task: ScheduledTask, now: number): ScheduledTaskSummary {
		return {
			...task,
			nextRunAt: task.enabled && !unsupportedSessionTargetReason(task) ? nextRunAt(task, now) : null,
		};
	}

	private persist(): void {
		const list = Array.from(this.tasks.values());
		writeTasks(this.scope, this.workspaceId, list);
	}

	private cancelTimer(id: string): void {
		const t = this.timers.get(id);
		if (t) {
			clearTimeout(t);
			this.timers.delete(id);
		}
	}

	private scheduleAll(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
		for (const t of this.tasks.values()) this.scheduleOne(t);
	}

	private catchUpMissedRuns(): void {
		const now = this.now();
		for (const task of this.tasks.values()) {
			const missedAt = this.lastMissedRunAt(task, now);
			if (missedAt === null) continue;
			const timer = setTimeout(() => {
				if (this.disposed) return;
				const current = this.tasks.get(task.id);
				if (!current?.enabled) return;
				void this.fireTask(current, missedAt, /*manual*/ false);
			}, 0);
			timer.unref?.();
		}
	}

	private lastMissedRunAt(task: ScheduledTask, now: number): number | null {
		if (!task.enabled || unsupportedSessionTargetReason(task)) return null;
		if (typeof task.lastRunAt !== "number") return null;

		let cursor = task.lastRunAt + 1;
		let missed: number | null = null;
		for (let i = 0; i < 5000; i++) {
			const next = nextRunAt(task, cursor);
			if (next === null || next >= now) break;
			missed = next;
			cursor = next + 1;
		}
		return missed;
	}

	private scheduleOne(task: ScheduledTask): void {
		if (!task.enabled || this.disposed || this.passive) return;
		if (this.capReached(task)) return;
		if (unsupportedSessionTargetReason(task)) return;
		const next = nextRunAt(task, this.now());
		if (next === null) return;
		const delay = Math.max(0, next - this.now());
		// Node clamps setTimeout delays above 2^31-1 ms (~24.8 days) to 1ms,
		// which would fire a far-future task (monthly schedules, distant
		// startAt) immediately — and the post-run reschedule would loop the
		// same way. Chunk long waits: sleep MAX_TIMEOUT_MS, then recompute.
		const timer = delay > MAX_TIMEOUT_MS
			? setTimeout(() => {
					this.timers.delete(task.id);
					const current = this.tasks.get(task.id);
					if (current) this.scheduleOne(current);
				}, MAX_TIMEOUT_MS)
			: setTimeout(() => {
					this.timers.delete(task.id);
					void this.fireTask(task, next, /*manual*/ false);
				}, delay);
		// Don't keep the event loop alive solely for a scheduled fire.
		if (typeof (timer as { unref?: () => void }).unref === "function") {
			(timer as { unref: () => void }).unref();
		}
		this.timers.set(task.id, timer);
	}

	/**
	 * Run a task now (or at its scheduled fire time). The session-lock
	 * machinery guarantees that no two tasks run in the same target session
	 * concurrently, and the policy on the task decides what to do when
	 * the session is busy: skip / queue / preempt.
	 *
	 * Returns synchronously; the dispatch promise runs in the background
	 * and resolves when the agent turn completes (or errors / times out).
	 */
	private async fireTask(task: ScheduledTask, at: number, manual: boolean): Promise<void> {
		if (this.disposed) return;
		// Guard against early fires (timer overflow clamping, wall-clock jumps):
		// if the scheduled time is still in the future, put the task back on a
		// timer instead of running it ahead of schedule.
		if (!manual && at > this.now() + EARLY_FIRE_TOLERANCE_MS) {
			const current = this.tasks.get(task.id);
			if (current) this.scheduleOne(current);
			return;
		}
		// Re-read the task from disk right before firing. External edits
		// (another process pausing/deleting via tasks.json, _cron acting
		// cross-scope) must win over our stale in-memory copy — otherwise a
		// disabled task keeps firing until restart AND our persist() after the
		// run silently reverts the external change.
		const fresh = readTaskFresh(this.scope, this.workspaceId, task.id);
		if (!fresh) {
			// Deleted externally — drop it from memory and stop rescheduling.
			this.cancelTimer(task.id);
			this.tasks.delete(task.id);
			return;
		}
		if (!fresh.enabled && !manual) {
			// Paused externally — sync memory and skip this fire.
			this.cancelTimer(task.id);
			this.tasks.set(task.id, fresh);
			return;
		}
		this.tasks.set(task.id, fresh);
		const current = fresh;
		if (unsupportedSessionTargetReason(current)) return;
		// maxRuns safety cap: refuse to fire once the cap is reached.
		if (!manual && this.capReached(current)) {
			this.disableForCap(current, at);
			return;
		}
		const sessionId = this.resolveTargetSessionId(current);
		const policy: ConcurrencyPolicy = current.concurrencyPolicy ?? "skip";

		const result = this.locks.acquire(current, sessionId, policy);
		if (result.kind === "skipped") {
			// The session is busy and the policy says drop this tick. Record it
			// and emit completion so the UI history reflects reality.
			const run: ScheduledTaskRun = {
				taskId: current.id,
				at,
				status: "skipped",
				reason: `session busy (held by ${result.holderTaskId})`,
			};
			appendRun(this.scope, this.workspaceId, run);
			this.tasks.set(current.id, {
				...current,
				lastRunAt: at,
				lastRunStatus: "skipped",
				updatedAt: this.now(),
				runCount: (current.runCount ?? 0) + 1,
			});
			this.persist();
			this.emit({ type: "task.completed", payload: run });
			// No nextRunAt change — a skipped tick is a no-op.
			return;
		}

		if (result.kind === "queued") {
			// The lock manager has enqueued us; it will call back via
			// lock.release() → runQueuedTask() once the holder finishes.
			return;
		}

		// result.kind === "acquired" — we hold the lock and get to dispatch.
		const lockedSessionId = result.lockedSessionId;
		this.emit({ type: "task.fired", payload: { taskId: current.id, at, sessionId: lockedSessionId } });
		this.running.add(current.id);
		try {
			const dispatchedTask = { ...current, updatedAt: this.now() };
			const dispatched = await this.runWhenRuntimeIdle(current.id, () => this.dispatcher.dispatch(dispatchedTask));
			let taskAfterDispatch = current;
			// Cache the session id the dispatcher used so subsequent
			// SessionTarget: current tasks can reuse it.
			if (dispatched.sessionId) {
				this.currentSessionId = dispatched.sessionId;
				if (current.sessionTarget?.kind === "new") {
					// For SessionTarget: "new", migrate the lock from the
					// `pending:${taskId}` placeholder to the real session id the
					// dispatcher just reported.
					this.locks.reassign(lockedSessionId, dispatched.sessionId);
				} else if (
					current.sessionTarget?.kind === "pinned" &&
					current.sessionTarget.sessionId &&
					current.sessionTarget.sessionId !== dispatched.sessionId
				) {
					// A pinned target can be a closed historical session. The
					// runtime will continue it into a writable child before
					// appending the prompt. Persist that resolved child so the
					// task stays fixed instead of drifting through fresh children.
					this.locks.reassign(lockedSessionId, dispatched.sessionId);
					taskAfterDispatch = {
						...current,
						sessionTarget: { ...current.sessionTarget, sessionId: dispatched.sessionId },
						updatedAt: this.now(),
					};
				}
			}

			const status: "ok" | "failed" = dispatched.error ? "failed" : "ok";
			const reason = dispatched.error;

			if (!this.recordedByTimeout.delete(current.id)) {
				const run: ScheduledTaskRun = {
					taskId: current.id,
					at,
					status,
					eventId: dispatched.eventId,
					sessionId: dispatched.sessionId,
					reason,
				};
				appendRun(this.scope, this.workspaceId, run);
				this.tasks.set(current.id, {
					...taskAfterDispatch,
					lastRunAt: at,
					lastRunStatus: status,
					lastRunEventId: dispatched.eventId,
					runCount: (current.runCount ?? 0) + 1,
					updatedAt: this.now(),
				});
				this.persist();
				this.emit({ type: "task.completed", payload: run });
			}

			const updated = this.tasks.get(current.id)!;
			if (updated.enabled && !this.disposed) {
				if (this.capReached(updated)) {
					// maxRuns reached after this run — auto-disable instead of
					// rescheduling, so runaway recurring tasks die on their own.
					this.disableForCap(updated, this.now());
				} else {
					const stillValid = !updated.schedule.endAt || updated.schedule.endAt > this.now();
					if (stillValid) this.scheduleOne(updated);
					else if (manual === false) {
						this.tasks.set(updated.id, { ...updated, enabled: false });
						this.persist();
					}
				}
			}
		} catch (e) {
			// Should not happen — dispatcher.dispatch itself is supposed to
			// catch and return { error }. This is belt-and-suspenders.
			const run: ScheduledTaskRun = {
				taskId: current.id,
				at,
				status: "failed",
				reason: e instanceof Error ? e.message : String(e),
			};
			appendRun(this.scope, this.workspaceId, run);
			this.tasks.set(current.id, {
				...current,
				lastRunAt: at,
				lastRunStatus: "failed",
				updatedAt: this.now(),
				runCount: (current.runCount ?? 0) + 1,
			});
			this.persist();
			this.emit({ type: "task.completed", payload: run });
		} finally {
			this.running.delete(current.id);
			this.recordedByTimeout.delete(current.id);
			// Release the lock. If something is queued, the manager will hand
			// the lock off and call back via onDispatchNext, which kicks off
			// the next fireTask in this same session.
			this.locks.release(current.id, (next) => {
				// Re-dispatch the queued task now. The lock manager has
				// already acquired the lock on its behalf.
				void this.fireTask(next, this.now(), /*manual*/ false);
			});
		}
	}

	/** True when the task has a maxRuns cap and has already hit it. */
	private capReached(task: ScheduledTask): boolean {
		return typeof task.maxRuns === "number" && task.maxRuns > 0 && (task.runCount ?? 0) >= task.maxRuns;
	}

	/** Disable a task that hit its maxRuns cap and record why. */
	private disableForCap(task: ScheduledTask, at: number): void {
		this.cancelTimer(task.id);
		this.tasks.set(task.id, { ...task, enabled: false, updatedAt: this.now() });
		this.persist();
		const run: ScheduledTaskRun = {
			taskId: task.id,
			at,
			status: "skipped",
			reason: `maxRuns cap reached (${task.runCount ?? 0}/${task.maxRuns}); task auto-disabled`,
		};
		appendRun(this.scope, this.workspaceId, run);
		this.emit({ type: "task.completed", payload: run });
	}

	private emit(event: { type: keyof SchedulerEngineEvents; payload: unknown }): void {
		this.listener?.(event);
		this.emitter.emit(event.type, ...(Array.isArray(event.payload) ? event.payload : [event.payload]));
	}

	private runWhenRuntimeIdle(
		taskId: string,
		dispatch: () => Promise<{ eventId?: string; sessionId?: string; error?: string }>,
	): Promise<{ eventId?: string; sessionId?: string; error?: string }> {
		const run = this.runtimeQueue.then(async () => {
			if (this.disposed || this.recordedByTimeout.has(taskId)) {
				return { error: "scheduler task cancelled before dispatch" };
			}
			return await dispatch();
		}, async () => {
			if (this.disposed || this.recordedByTimeout.has(taskId)) {
				return { error: "scheduler task cancelled before dispatch" };
			}
			return await dispatch();
		});
		this.runtimeQueue = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Subscribe to engine events (returns an unsubscribe function). */
	subscribe(listener: SchedulerListener): () => void {
		const wrapped = (e: { type: keyof SchedulerEngineEvents; payload: unknown }) => listener(e);
		this.emitter.on("task.fired", wrapped as never);
		this.emitter.on("task.completed", wrapped as never);
		return () => {
			this.emitter.off("task.fired", wrapped as never);
			this.emitter.off("task.completed", wrapped as never);
		};
	}
}
