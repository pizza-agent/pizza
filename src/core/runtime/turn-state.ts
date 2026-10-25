/**
 * TurnState — explicit, log-replayable turn-level state.
 *
 * The Reactor's bookkeeping (follow-up queue, retry timers, turn trackers,
 * pending approvals, loop-detection signatures, turn lifecycle flags) used to
 * live as ~7 loosely-related private fields mutated from a dozen handlers.
 * TurnState makes that state explicit and centrally owned:
 *
 *   - the Reactor delegates every mutation to it (single writer);
 *   - `replayFromLog()` reconstructs what a process run can recover from the
 *     log alone: compensates turns interrupted by a crash (via
 *     recoverDanglingTurnState) and re-queues follow-ups that were queued but
 *     never delivered;
 *   - process-run identity is the RUNTIME_STARTED `run_id` (unique per boot)
 *     instead of sequence-position heuristics: USER_FOLLOWUP_QUEUED events
 *     carry the run_id that queued them, and replay only picks up entries
 *     from the CURRENT run (stale ones belong to dead in-memory buffers).
 *
 * What intentionally stays in memory only (documented, not hidden):
 *   - turnTrackers / pendingApprovals describe in-flight executions; a crash
 *     invalidates them wholesale, and the log compensates (crash-recovery)
 *     rather than resurrects them;
 *   - retry timers are wall-clock timers; their durable trace is the
 *     RETRY_SCHEDULED/RETRY_ABORTED event pair, and crash recovery closes the
 *     interrupted turn instead of resuming a backoff across restarts.
 */

import type { EventBase } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import { recoverDanglingTurnState } from "./crash-recovery.js";

export interface ToolExecutionResultShape {
	content: Array<{ type: string; [key: string]: unknown }>;
	details?: unknown;
	is_error: boolean;
	[key: string]: unknown;
}

export interface TurnTracker {
	assistantMessageEventId: string;
	expectedCount: number;
	expectedToolCallIds: Set<string>;
	received: Array<{ tool_call_id: string; tool_name: string; result: ToolExecutionResultShape; is_error: boolean }>;
	abortSignal?: AbortSignal;
}

export interface FollowUpEntry {
	content: string | unknown[];
	images?: unknown[];
	/** Event that queued this entry (USER_FOLLOWUP_QUEUED / USER_INTERRUPT). */
	sourceEventId?: string;
	/** Origin: steer (interrupt-with-content) or plain follow-up queueing. */
	kind: "steer" | "followUp";
	/** The content is already in the log as a USER_MESSAGE (queued from a
	 * mid-turn raw user message): deliver a turn request instead of
	 * appending a duplicate USER_MESSAGE. */
	userMessageEventId?: string;
}

export interface RetryTimer {
	attempt: number;
	errorMessage: string;
	scheduled_event_id: string;
	timeout: ReturnType<typeof setTimeout>;
	/** Fires the retried turn loop. */
	retry: () => void;
}

export interface PendingApproval {
	resolve: (approved: boolean) => void;
	tool_call_id: string;
	tool_name: string;
	arguments: Record<string, unknown>;
}

/** Unique id for this process run, stamped into RUNTIME_STARTED. */
export function generateRunId(): string {
	return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Owns all turn-level in-memory state for a reactor. Single-writer: the
 * reactor mutates through these methods only.
 */
export class TurnState {
	readonly followUpQueue: FollowUpEntry[] = [];
	readonly retryTimers = new Map<string, RetryTimer>();
	readonly turnTrackers = new Map<string, TurnTracker>();
	readonly pendingApprovals = new Map<string, PendingApproval>();
	/** IntentClassification categories the user approved for the whole
	 * session ("Always allow" in the approval dialog). Session-scoped by
	 * design: held in memory, never persisted, cleared on restart. */
	readonly allowedCategories = new Set<string>();
	/** Stable log boundary for this run, including across replay pages. */
	private replayRunStartSequence: number | undefined;

	/** Turn loop-detection signatures for the current prompt cycle. */
	toolRoundSignatures: string[][] = [];

	/** Consecutive empty-answer nudges sent in the current prompt cycle. */
	emptyAnswerRetries = 0;

	/** True while a turn (or its retry backoff) is in flight. */
	turnInFlight = false;

	/** Hard abort was requested; suppress follow-up drain. */
	abortedByUser = false;

	constructor(readonly runId: string) {}

	// ── follow-up queue ─────────────────────────────────────────────────────

	queueFollowUp(entry: FollowUpEntry): void {
		this.followUpQueue.push(entry);
	}

	dequeueFollowUp(): FollowUpEntry | undefined {
		return this.followUpQueue.shift();
	}

	get hasFollowUps(): boolean {
		return this.followUpQueue.length > 0;
	}

	/** Remove ONE queued entry by its source event id. Returns it, or undefined. */
	removeFollowUp(sourceEventId: string): FollowUpEntry | undefined {
		const idx = this.followUpQueue.findIndex((e) => e.sourceEventId === sourceEventId);
		if (idx < 0) return undefined;
		return this.followUpQueue.splice(idx, 1)[0];
	}

	/**
	 * Move ONE queued entry to the FRONT of the queue. Used by "send now"
	 * (steer promotion): the drain delivers from the front, and a steer
	 * re-queued by the interrupt handler lands at the end — without this an
	 * explicit "send this one first" would paradoxically run LAST behind
	 * every other queued message. True when the entry is (now) at the front.
	 */
	moveFollowUpToFront(sourceEventId: string): boolean {
		const idx = this.followUpQueue.findIndex((e) => e.sourceEventId === sourceEventId);
		if (idx < 0) return false;
		if (idx === 0) return true;
		const [entry] = this.followUpQueue.splice(idx, 1);
		this.followUpQueue.unshift(entry!);
		return true;
	}

	clearFollowUps(): Array<{ sourceEventId?: string }> {
		const dropped = this.followUpQueue.map((e) => ({ sourceEventId: e.sourceEventId }));
		this.followUpQueue.length = 0;
		return dropped;
	}

	/** Snapshot for the runtime's pendingFollowUps API. */
	pendingFollowUps(): Array<{ kind: "steer" | "followUp"; content: string | unknown[]; sourceEventId?: string }> {
		return this.followUpQueue.map((e) => ({ kind: e.kind, content: e.content, sourceEventId: e.sourceEventId }));
	}

	// ── retry timers ────────────────────────────────────────────────────────

	scheduleRetry(scheduledEventId: string, timer: RetryTimer): void {
		this.retryTimers.set(scheduledEventId, timer);
	}

	cancelRetry(scheduledEventId: string): void {
		clearTimeout(this.retryTimers.get(scheduledEventId)?.timeout);
		this.retryTimers.delete(scheduledEventId);
	}

	cancelAllRetries(): RetryTimer[] {
		const cancelled = [...this.retryTimers.values()];
		for (const t of cancelled) clearTimeout(t.timeout);
		this.retryTimers.clear();
		return cancelled;
	}

	get hasPendingRetries(): boolean {
		return this.retryTimers.size > 0;
	}

	// ── turn trackers ───────────────────────────────────────────────────────

	track(tracker: TurnTracker): void {
		this.turnTrackers.set(tracker.assistantMessageEventId, tracker);
	}

	getTracker(assistantMessageEventId: string): TurnTracker | undefined {
		return this.turnTrackers.get(assistantMessageEventId);
	}

	untrack(assistantMessageEventId: string): void {
		this.turnTrackers.delete(assistantMessageEventId);
	}

	// ── loop detection ──────────────────────────────────────────────────────

	resetLoopDetection(): void {
		this.toolRoundSignatures = [];
	}

	recordToolRoundSignature(signature: string[]): void {
		this.toolRoundSignatures.push(signature);
	}

	// ── lifecycle ───────────────────────────────────────────────────────────

	resetCycle(): void {
		this.turnInFlight = false;
		this.abortedByUser = false;
		this.resetLoopDetection();
		this.emptyAnswerRetries = 0;
	}

	/**
	 * Whether a new turn may start now: no turn in flight, no retry backoff,
	 * no pending approvals. (Compaction is reactor-level and checked there.)
	 */
	get canStartTurn(): boolean {
		return !this.turnInFlight && !this.hasPendingRetries;
	}

	dispose(): void {
		this.cancelAllRetries();
		this.drainPendingApprovals(false);
		this.clearFollowUps();
		this.turnTrackers.clear();
	}

	/** Resolve every pending approval (crash/shutdown answers them as rejected). */
	drainPendingApprovals(defaultDecision: boolean): void {
		if (this.pendingApprovals.size === 0) return;
		for (const [, pending] of this.pendingApprovals) {
			pending.resolve(defaultDecision);
		}
		this.pendingApprovals.clear();
	}

	// ── log replay ──────────────────────────────────────────────────────────

	/**
	 * Recover turn state a fresh process run can act on:
	 *
	 *  1. Compensate turns interrupted by a previous crash (dangling tool
	 *     calls, missing AGENT_TURN_COMPLETED) — only safe when this process
	 *     is the sole workspace driver.
	 *  2. Re-queue follow-ups from THIS run (identified by run_id on
	 *     USER_FOLLOWUP_QUEUED; legacy entries fall back to a sequence
	 *     comparison against the last RUNTIME_STARTED) that were never
	 *     delivered.
	 *
	 * Returns the recovered follow-up entries (queued into followUpQueue).
	 */
	replayFromLog(store: EventStore): FollowUpEntry[] {
		// Dangling turns belong to previous runs; compensate before replay so
		// the follow-up drain sees a settled log.
		recoverDanglingTurnState(store);
		return this.replayFollowUpsFromLog(store);
	}

	/**
	 * Re-queue this run's undelivered follow-ups from the log (no crash
	 * compensation — safe to call at any reactor start, including with
	 * concurrent processes on the same workspace).
	 */
	replayFollowUpsFromLog(store: EventStore): FollowUpEntry[] {
		// Only this run's events can carry a live follow-up buffer: entries
		// queued before OUR run's RUNTIME_STARTED belong to a dead process run.
		// Scope every scan to events after it — a long-lived workspace log
		// would otherwise be fully re-scanned on every prompt. We locate OUR
		// RUNTIME_STARTED by run_id (a concurrent runtime's STARTED must not
		// shrink the scope and strand our queue). Legacy fallback still uses
		// the newest STARTED for the undated-entry cutoff.
		const startedEvents = store.query({ types: ["RUNTIME_STARTED"], reverse: true, limit: 100 });
		const lastStarted = startedEvents[0];
		if (this.replayRunStartSequence === undefined) {
			let page = startedEvents;
			let ourStarted = page.find((e) => runIdOf(e) === this.runId);
			// Other live runtimes may have produced more than one page of boot
			// events. Never substitute their start for ours and strand our queue.
			while (!ourStarted && page.length === 100) {
				page = store.query({ types: ["RUNTIME_STARTED"], reverse: true, limit: 100, before_sequence: page[page.length - 1]!.sequence });
				ourStarted = page.find((e) => runIdOf(e) === this.runId);
			}
			if (ourStarted) this.replayRunStartSequence = ourStarted.sequence;
		}
		const runStartSeq = this.replayRunStartSequence ?? 0;
		const scope = { after_sequence: runStartSeq } as const;

		const followups = store.query({ types: ["USER_FOLLOWUP_QUEUED"], ...scope });
		if (followups.length === 0) return [];

		// Delivered: a USER_MESSAGE or AGENT_TURN_REQUESTED carries the
		// follow-up event id as caused_by (delivery shapes — see reactor).
		const deliveredCausedBy = new Set(
			store
				.query({ types: ["USER_MESSAGE", "AGENT_TURN_REQUESTED"], ...scope })
				.map((m) => m.caused_by)
				.filter((id): id is string => !!id),
		);

		// Dropped: USER_FOLLOWUP_DROPPED lists abandoned queue entries.
		const droppedIds = new Set<string>();
		for (const d of store.query({ types: ["USER_FOLLOWUP_DROPPED"], ...scope })) {
			const p = d.payload as { dropped_event_ids?: string[] };
			for (const id of p.dropped_event_ids ?? []) droppedIds.add(id);
		}

		const recovered: FollowUpEntry[] = [];
		for (const f of followups) {
			if (deliveredCausedBy.has(f.event_id)) continue;
			if (droppedIds.has(f.event_id)) continue;
			const p = f.payload as {
				content: string | unknown[];
				images?: unknown[];
				user_message_event_id?: string;
				run_id?: string;
			};
			// Only this run's queue entries: stale ones belong to a dead
			// in-memory buffer (run_id match; legacy fallback = queued after
			// the last RUNTIME_STARTED by sequence).
			if (p.run_id !== undefined) {
				if (p.run_id !== this.runId) continue;
			} else {
				if (lastStarted && f.sequence < lastStarted.sequence) continue;
			}
			const entry: FollowUpEntry = {
				content: p.content,
				images: p.images,
				sourceEventId: f.event_id,
				kind: "followUp",
				userMessageEventId: p.user_message_event_id,
			};
			this.followUpQueue.push(entry);
			recovered.push(entry);
		}
		return recovered;
	}
}

/** Extract a run_id from a RUNTIME_STARTED event payload, if present. */
export function runIdOf(event: EventBase): string | undefined {
	return (event.payload as { run_id?: string }).run_id;
}