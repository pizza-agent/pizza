/**
 * Reactor — Event-Driven Agent Core
 *
 * Replaces the AgentLoop while-loop with a set of typed handlers that react
 * to events appended to the EventStore. Each handler is a pure async function
 * that may emit new events. The reactor itself is stateless — all mutable
 * state lives in the EventStore.
 *
 * Event flow:
 *
 *   USER_MESSAGE / USER_INTERRUPT / TOOL_RESULTS_AGGREGATED / RETRY_SCHEDULED
 *         ↓
 *   [onUserMessage]  ──→ emit AGENT_TURN_REQUESTED
 *         ↓
 *   [onAgentTurnRequested]  ──→ emit LLM_CALL_REQUESTED
 *         ↓
 *   [onLlmCallRequested]  ──→ call LLM → emit AGENT_MESSAGE_START/CHUNK/END
 *         ↓
 *   [onAgentMessageEnd]
 *       ├── if no tool_calls → emit AGENT_TURN_COMPLETED
 *       └── if tool_calls → emit INTENT_TOOL_CALL (one per call)
 *         ↓
 *   [onIntentToolCall]  ──→ (approval gate) → emit TOOL_EXECUTION_START/END
 *         ↓
 *   [onToolExecutionEnd]  ──→ track count → if all done → emit TOOL_RESULTS_AGGREGATED
 *         ↓
 *   [onToolResultsAggregated]  ──→ emit AGENT_TURN_REQUESTED  ← loop back
 *
 * Other handlers (run in parallel, do not gate the main flow):
 *   onAgentTurnCompleted  — UI notification
 *   onLlmCallFailed        — retry scheduling
 *   onUserInterrupt        — abort signal + turn completion
 *   onCompactionRequested  — compaction orchestration
 */

import type { EventBase, EventType } from "../event-store/types.js";
import { generateRunId, TurnState, type FollowUpEntry, type TurnTracker } from "./turn-state.js";
import type { EventStore, EventAppendInput } from "../event-store/store.js";
import type {
	ApprovalHandler,
	IntentClassification,
	ToolExecutionUpdate,
	ToolExecutionResult,
	ToolRegistry,
} from "../intent/types.js";
import type { IntentClassifier } from "../intent/classifier.js";
import type { LLMChunk, LLMClient, LLMResponse, ToolDefinition } from "./llm-types.js";
import type { RuntimeAdapter } from "./types.js";
import { extractToolCalls } from "../projection/event-to-message.js";
import type { SessionProjection } from "../projection/session-projection.js";
import type { SessionManager } from "../projection/session-manager.js";
import type { CompactionPolicy, RetryPolicy } from "./policies.js";
import { DefaultRetryPolicy, NoopCompactionPolicy } from "./policies.js";
// ============================================================================
// Types
// ============================================================================

/** Reactor configuration */
export interface ReactorConfig {
	/** Shared turn-level state (follow-ups, retries, trackers, approvals).
	 * When omitted the reactor owns a private instance — the runtime passes
	 * its shared one so queued follow-ups survive reactor restarts. */
	turnState?: TurnState;
	store: EventStore;
	projection: SessionProjection;
	llmClient: LLMClient;
	classifier: IntentClassifier;
	toolRegistry: ToolRegistry;
	approvalHandler?: ApprovalHandler;
	runtimeAdapter: RuntimeAdapter;
	systemPrompt: string;
	model: { provider: string; model_id: string; thinking_level?: string };
	contextBudget: number;
	/** Tool definitions exposed to the LLM */
	tools: ToolDefinition[];
	/** Retry policy (default: DefaultRetryPolicy). */
	retryPolicy?: RetryPolicy;
	/** Whether assistant messages that complete with stop_reason=error should be retried by the reactor. */
	retryAssistantErrorCompletions?: boolean;
	/** Compaction policy (default: NoopCompactionPolicy). */
	compactionPolicy?: CompactionPolicy;
	/** SessionManager for refreshing projection after session splits. */
	sessionManager?: SessionManager;
	/**
	 * Optional callback to rebuild the system prompt when the active session
	 * changes (split/fork/jump). Lets the caller inject session-position
	 * breadcrumbs without the reactor knowing about prompt construction.
	 * Returns the updated system prompt string.
	 */
	refreshSystemPrompt?: () => string;
	/**
	 * Run at the start of each user-prompt turn, before the first LLM round.
	 * Lets the caller fire extension before_agent_start hooks (system-prompt
	 * injection, context messages) with the canonical base prompt. Return the
	 * effective system prompt for this turn, or undefined to keep the current
	 * one. Implementations must build on the canonical base prompt so repeated
	 * turns do not accumulate injections.
	 */
	beforeAgentStart?: (payload: {
		prompt: string;
		images?: unknown[];
	}) => Promise<{ systemPrompt?: string } | undefined>;
}

/** A single event handler. Returns void or void Promise. */
export type EventHandler = (event: EventBase) => void | Promise<void>;
	
/** Mapping from event type to handler */
export type EventHandlerMap = Partial<Record<EventType, EventHandler>>;

type RetryScheduleResult = "scheduled" | "not_retryable" | "max_attempts" | "backoff_exhausted";

/**
 * Safety limit: if the model calls the exact same set of tools (by name AND
 * arguments) in this many consecutive turns, the reactor assumes it is stuck in
 * an unproductive loop and completes the turn instead of requesting another.
 * Prevents runaway loops (e.g. a model repeatedly calling a control tool like
 * session_split with identical arguments).
 *
 * Note: the signature includes a hash of the arguments, so calling the same
 * tool with different arguments (e.g. `cli` with different commands) does NOT
 * count as a loop. Only truly identical rounds are detected.
 */
const MAX_CONSECUTIVE_IDENTICAL_TOOL_ROUNDS = 6;

/**
 * Compute a stable hash of a tool call's arguments for loop detection.
 * Uses FNV-1a (32-bit) — fast, dependency-free, good enough for signatures.
 */
function hashArguments(args: unknown): string {
	const s = typeof args === "string" ? args : JSON.stringify(args);
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

// ============================================================================
// Tool Call Tracking (join-pattern for parallel tool execution)
// ============================================================================

export class Reactor {
	private config: ReactorConfig;
	private abortController: AbortController | undefined;
	private handlers: EventHandlerMap = {};
	private unsubscribers: Array<() => void> = [];
	private _isRunning = false;
	/** Context built in onAgentTurnRequested, consumed by onLlmCallRequested. */
	private _pendingContext: ReturnType<SessionProjection["buildContext"]> | undefined;
	/** Active retry policy. */
	private retryPolicy: RetryPolicy;
	/** Active compaction policy. */
	private compactionPolicy: CompactionPolicy;

	// ── Turn-level state: owned by TurnState, accessed through delegating
	// getters so handler code keeps reading naturally while every mutation
	// funnels through one explicitly-owned, log-replayable object. ─────────
	private readonly turnState: TurnState;

	private get turnTrackers():Map<string,TurnTracker> { return this.turnState.turnTrackers; }
	private get followUpQueue():TurnState["followUpQueue"] { return this.turnState.followUpQueue; }
	private get retryTimers():TurnState["retryTimers"] { return this.turnState.retryTimers; }
	private get _abortedByUser():boolean { return this.turnState.abortedByUser; }
	private set _abortedByUser(v:boolean) { this.turnState.abortedByUser = v; }
	private get _turnInFlight():boolean { return this.turnState.turnInFlight; }
	private set _turnInFlight(v:boolean) { this.turnState.turnInFlight = v; }
	private get _toolRoundSignatures():string[][] { return this.turnState.toolRoundSignatures; }
	private set _toolRoundSignatures(v:string[][]) { this.turnState.toolRoundSignatures = v; }

	/** Aborter for the current compaction run (if any). */
	private compactionAbort: AbortController | undefined;
	/**
	 * Stream-idle watchdog: if no AGENT_MESSAGE_CHUNK arrives within this
	 * many ms, the LLM call is aborted so the reactor emits LLM_CALL_FAILED
	 * instead of hanging forever (provider accepted the connection but
	 * stopped sending data mid-stream). Default: 10 minutes.
	 */
	private _streamIdleTimeoutMs = 10 * 60_000;
	private _streamIdleTimer: ReturnType<typeof setTimeout> | undefined;
	constructor(config: ReactorConfig) {
		this.config = config;
		this.retryPolicy = config.retryPolicy ?? new DefaultRetryPolicy();
		this.compactionPolicy = config.compactionPolicy ?? new NoopCompactionPolicy();
		// Shared (runtime-owned) or per-reactor turn state. The runtime passes
		// one instance so follow-ups queued outside a prompt cycle survive
		// reactor restarts, and so replay can be driven centrally.
		this.turnState = config.turnState ?? new TurnState(generateRunId());
		this._registerAllHandlers();
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/** Subscribe to all events and start the reactor. */
	async start(): Promise<void> {
		if (this._isRunning) return;
		this._isRunning = true;
		this.abortController = new AbortController();

		// Subscribe to the event store — all events flow through the store
		const unsub = this.config.store.subscribe(
			(event) => this._dispatch(event),
			// No type filter here; individual handlers decide what they care about
		);
		this.unsubscribers.push(unsub);

		// Replay any pre-existing follow-up events that were queued while the reactor was idle
		this._replayPendingFollowUps();

		// Emit RUNTIME_STARTED if the store is fresh
		if (this.config.store.size === 0) {
			this._emit({
				actor_id: "runtime",
				type: "RUNTIME_STARTED",
				payload: {},
			});
		}
	}

	/**
	 * Replay USER_FOLLOWUP_QUEUED events that were appended while the reactor was idle.
	 *
	 * A follow-up is replayed only when ALL of these hold:
	 *   1. It was queued during THIS process run — i.e. its log sequence is after the
	 *      most recent RUNTIME_STARTED. The follow-up event is durable, but the in-memory
	 *      queue it backs is not; a follow-up left over from a previous run has no live
	 *      buffer to belong to, and replaying it would resurrect "ghost" user messages
	 *      days later. (runtime_id is a constant in local mode, so the RUNTIME_STARTED
	 *      position in the log is what actually distinguishes process runs. Sequence is
	 *      used instead of timestamp: wall clocks can go backwards and same-millisecond
	 *      restarts would mis-classify, while the log sequence is strictly monotonic.)
	 *   2. It has not already been delivered: no USER_MESSAGE references it via caused_by.
	 *   3. It has not been explicitly dropped: no USER_FOLLOWUP_DROPPED event lists its id.
	 */
	private _replayPendingFollowUps(): void {
		// Delegated to TurnState: run_id-scoped (or legacy sequence-scoped)
		// requeue of undelivered follow-ups. Crash compensation of dangling
		// turns runs once at startup (workspace lock held), not per reactor.
		this.turnState.replayFollowUpsFromLog(this.config.store);
	}

	/** Stop the reactor. Clears all subscriptions. */
	stop(): void {
		this._isRunning = false;
		this.abortController?.abort();
		for (const { timeout } of this.retryTimers.values()) {
			clearTimeout(timeout);
		}
		this.retryTimers.clear();
		this._drainPendingApprovals();
		for (const unsub of this.unsubscribers) unsub();
		this.unsubscribers = [];
	}

	/** Check if the reactor is running. */
	get isRunning(): boolean {
		return this._isRunning;
	}

	/** Abort signal for the currently active reactor run. */
	get signal(): AbortSignal | undefined {
		return this.abortController?.signal;
	}

	// =========================================================================
	// Event dispatch
	// =========================================================================

	private async _dispatch(event: EventBase): Promise<void> {
		const handler = this.handlers[event.type];
		if (!handler) return;

		try {
			await handler(event);
		} catch (err) {
			// Emit as RUNTIME_ERROR instead of throwing — the reactor must keep running
			const msg = err instanceof Error ? err.message : String(err);
			this._emit({
				actor_id: "runtime",
				type: "RUNTIME_ERROR",
				payload: { error: msg, stack: err instanceof Error ? err.stack : undefined, causing_event_id: event.event_id },
			});
		}
	}

	private _emit(input: EventAppendInput): EventBase {
		return this.config.store.append(input);
	}

	/** Check if the reactor has been asked to stop. */
	private _shouldInterrupt(): boolean {
		return this.abortController?.signal.aborted ?? false;
	}

	/** Interrupt the reactor. */
	interrupt(): void {
		this._stopStreamIdleWatchdog();
		this.abortController?.abort();
	}

	// =========================================================================
	// Handler registration
	// =========================================================================

	private _registerAllHandlers(): void {
		this.handlers = {
			USER_MESSAGE: this._onUserMessage.bind(this),
			USER_INTERRUPT: this._onUserInterrupt.bind(this),
			USER_FOLLOWUP_QUEUED: this._onUserFollowupQueued.bind(this),
			AGENT_TURN_REQUESTED: this._onAgentTurnRequested.bind(this),
			LLM_CALL_REQUESTED: this._onLlmCallRequested.bind(this),
			AGENT_MESSAGE_END: this._onAgentMessageEnd.bind(this),
			INTENT_TOOL_CALL: this._onIntentToolCall.bind(this),
			TOOL_EXECUTION_END: this._onToolExecutionEnd.bind(this),
			TOOL_RESULTS_AGGREGATED: this._onToolResultsAggregated.bind(this),
			LLM_CALL_FAILED: this._onLlmCallFailed.bind(this),
			AGENT_TURN_COMPLETED: this._onAgentTurnCompleted.bind(this),
			USER_APPROVAL: this._onUserApproval.bind(this),
			USER_REJECTION: this._onUserRejection.bind(this),
			COMPACTION_REQUESTED: this._onCompactionRequested.bind(this),
			COMPACTION_END: this._onCompactionSettled.bind(this),
			COMPACTION_ABORTED: this._onCompactionSettled.bind(this),
			SESSION_BOUNDARY_INFERRED: this._onSessionBoundaryInferred.bind(this),
			SESSION_FORKED: this._onSessionBoundaryInferred.bind(this),
			SESSION_JUMPED: this._onSessionBoundaryInferred.bind(this),
		};
	}

	// =========================================================================
	// User-facing entry points (used by modes)
	// =========================================================================

	/**
	 * Send a user message to the agent (idle path).
	 * For interrupt-while-streaming use steer(). For after-turn-completion use followUp().
	 */
	prompt(
		content: string | Array<{ type: string; [key: string]: unknown }>,
		images?: Array<{ type: "image"; data: string; mime_type: string }>,
	): void {
		this._emit({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content, images },
		});
	}

	/**
	 * Steer: interrupt current turn with a new user message.
	 * The reactor aborts the current LLM call (if any) and treats the steer message
	 * as a fresh USER_MESSAGE once the turn settles.
	 */
	steer(
		content: string | Array<{ type: string; [key: string]: unknown }>,
		images?: Array<{ type: "image"; data: string; mime_type: string }>,
	): void {
		this._emit({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: { content, images, reason: "steer" },
		});
	}

	/**
	 * Follow-up: queue a message to be delivered after the current turn naturally completes.
	 * Does not interrupt. If the reactor is idle, behaves like prompt().
	 */
	followUp(
		content: string | Array<{ type: string; [key: string]: unknown }>,
		images?: Array<{ type: "image"; data: string; mime_type: string }>,
	): void {
		this._emit({
			actor_id: "user",
			type: "USER_FOLLOWUP_QUEUED",
			payload: { content, images },
		});
	}

	/** Number of pending follow-up messages. */
	get pendingFollowUpCount(): number {
		return this.followUpQueue.length;
	}

	/** Number of scheduled retries waiting to re-enter the turn loop. */
	get pendingRetryCount(): number {
		return this.retryTimers.size;
	}

	/** Whether a compaction run is currently in flight. */
	get isCompacting(): boolean {
		return this.compactionAbort !== undefined;
	}

	/** Snapshot of the pending follow-up queue (for UI display). */
	get pendingFollowUps(): Array<{ kind: "steer" | "followUp"; content: string | unknown[]; sourceEventId?: string }> {
		return this.followUpQueue.map((e) => ({ kind: e.kind, content: e.content, sourceEventId: e.sourceEventId }));
	}

	/** Clear pending follow-ups (e.g. on user-explicit cancel). */
	clearFollowUpQueue(): void {
		this.followUpQueue.length = 0;
	}

	/** Take ONE pending follow-up by its source event id (per-item cancel/steer). */
	takeFollowUp(sourceEventId: string): FollowUpEntry | undefined {
		return this.turnState.removeFollowUp(sourceEventId);
	}

	/** Move a queued entry to the front of the queue ("send now" semantics). */
	promoteFollowUpToFront(sourceEventId: string): boolean {
		return this.turnState.moveFollowUpToFront(sourceEventId);
	}

	// =========================================================================
	// HANDLERS
	// =========================================================================

	// ─── USER_MESSAGE ───────────────────────────────────────────────────────

	private async _onUserMessage(event: EventBase): Promise<void> {
		const payload = event.payload as { content: unknown; images?: unknown };
		if (this._shouldInterrupt()) return;

		// A turn is already in flight (LLM streaming, tool running, retry
		// pending, or compaction): starting another reactor turn here would
		// interleave two turns in one thread — their events interleave in the
		// log and a long-running tool's result lands after other turns'
		// messages, breaking the tool_use → tool_result adjacency that strict
		// providers (Anthropic/Bedrock) require. Queue as a follow-up instead;
		// _onAgentTurnCompleted drains it when the current turn settles.
		if (this._turnInFlight || this.retryTimers.size > 0 || this.compactionAbort !== undefined) {
			// Durable queue marker referencing the raw message; the queued-event
			// handler queues it and the turn-completion drain delivers it.
			this._emit({
				actor_id: "user",
				type: "USER_FOLLOWUP_QUEUED",
				payload: {
					content: payload.content,
					images: payload.images,
					reason: "turn_in_flight",
					user_message_event_id: event.event_id,
					run_id: this.turnState.runId,
				},
				caused_by: event.event_id,
			});
			return;
		}


		// A turn starts here — queued follow-ups must wait for its completion.
		this._turnInFlight = true;

		// Run before_agent_start extension hooks so system-prompt injections
		// (e.g. built-in extensions like agent-browser) apply to this turn.
		// Fires once per user prompt — not per tool-results round.
		if (this.config.beforeAgentStart) {
			try {
				const result = await this.config.beforeAgentStart({
					prompt: typeof payload.content === "string" ? payload.content : "",
					images: Array.isArray(payload.images) ? payload.images : undefined,
				});
				if (result?.systemPrompt) this.config.systemPrompt = result.systemPrompt;
			} catch {
				// A failing hook must not block the turn.
			}
		}

		// Reset loop detection for a new prompt cycle
		this._toolRoundSignatures = [];

		// Emit thinking start
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_THINKING_START",
			payload: { model: this.config.model.model_id },
			caused_by: event.event_id,
		});

		// Emit turn requested — this kicks off the reactor loop
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_REQUESTED",
			payload: { reason: "user_message" },
			caused_by: event.event_id,
		});
	}

	// ─── USER_INTERRUPT ─────────────────────────────────────────────────────
	private async _onUserInterrupt(event: EventBase): Promise<void> {
		const payload = event.payload as { content?: unknown; images?: unknown };

		// Steer with no turn in flight (and nothing that will re-enter the turn loop):
		// there is nothing to interrupt — deliver the content as a fresh turn now.
		// Without this the message strands in the queue, because the queue is only
		// drained on AGENT_TURN_COMPLETED, which already fired.
		if (payload.content !== undefined && this._canDeliverFollowUpNow()) {
			this.followUpQueue.push({
				content: payload.content as string | unknown[],
				images: payload.images as unknown[] | undefined,
				sourceEventId: event.event_id,
				kind: "steer",
			});
			this._deliverFollowUpNow(event.event_id);
			return;
		}

		this.interrupt();
		// Track hard abort (no new content) so _onAgentTurnCompleted doesn't drain follow-ups.
		if (payload.content === undefined) {
			this._abortedByUser = true;
		}
		// If steer carried new content, queue it as a follow-up so the turn-completion
		// handler picks it up after the current turn settles (aborted state).
		if (payload.content !== undefined) {
			this.followUpQueue.push({
				content: payload.content as string | unknown[],
				images: payload.images as unknown[] | undefined,
				sourceEventId: event.event_id,
				kind: "steer",
			});
		}
		// Cancel any pending compaction so we don't block turn completion
		this.compactionAbort?.abort();
		// Reject any approval the user was still being asked about. Without this the
		// promise in _onIntentToolCall never settles and the turn hangs forever.
		this._drainPendingApprovals();

		if (this.retryTimers.size > 0) {
			for (const [scheduledEventId, retry] of this.retryTimers) {
				clearTimeout(retry.timeout);
				this._emit({
					actor_id: "runtime",
					type: "RETRY_ABORTED",
					payload: {
						attempt: retry.attempt,
						reason: "user_interrupt",
						error_message: retry.errorMessage,
						scheduled_event_id: scheduledEventId,
					},
					caused_by: event.event_id,
				});
			}
			this.retryTimers.clear();
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_END",
				payload: { tool_calls_count: 0 },
				caused_by: event.event_id,
			});
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "aborted" },
				caused_by: event.event_id,
			});
		} else if (payload.content === undefined && !this._turnInFlight) {
			// Hard abort with nothing in flight and no retry pending: no AGENT_TURN_COMPLETED
			// will ever fire on its own. Emit one so the runtime's settled promise resolves
			// instead of hanging (this can happen when the abort lands in the window between
			// turn completion and the runtime stopping the reactor).
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_END",
				payload: { tool_calls_count: 0 },
				caused_by: event.event_id,
			});
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "aborted" },
				caused_by: event.event_id,
			});
		}
	}
	// ─── USER_FOLLOWUP_QUEUED ───────────────────────────────────────────────

	private async _onUserFollowupQueued(event: EventBase): Promise<void> {
		const payload = event.payload as { content: string | unknown[]; images?: unknown[]; user_message_event_id?: string };
		this.followUpQueue.push({
			content: payload.content,
			images: payload.images,
			sourceEventId: event.event_id,
			kind: "followUp",
			userMessageEventId: payload.user_message_event_id,
		});
		// If the reactor is idle (no turn, retry, or compaction in flight) the queue is
		// never drained by _onAgentTurnCompleted — deliver immediately instead, otherwise
		// the message strands in the queue and the runtime's settled promise hangs.
		if (this._canDeliverFollowUpNow()) {
			this._deliverFollowUpNow(event.event_id);
		}
	}

	// ─── AGENT_TURN_REQUESTED ───────────────────────────────────────────────

	private async _onAgentTurnRequested(event: EventBase): Promise<void> {
		if (this._shouldInterrupt()) {
			// Abort fired between turns — emit completion so the runtime
			// settles and the UI exits the "streaming" state.
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_END",
				payload: { tool_calls_count: 0 },
				caused_by: event.event_id,
			});
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "aborted" },
				caused_by: event.event_id,
			});
			return;
		}

		// Covers every turn (re)start: user message, tool-result rounds, and retry
		// re-entry. Queued follow-ups must wait while a turn is in flight.
		this._turnInFlight = true;

		const payload = event.payload as { reason: string; retry_attempt?: number };

		// Build context from projection
		const context = this.config.projection.buildContext({
			max_tokens: this.config.contextBudget,
		});

		// Stash context for the LLM_CALL_REQUESTED handler. MUST be set before _emit
		// because store subscribers fire synchronously and _onLlmCallRequested reads
		// _pendingContext during its sync portion before awaiting the LLM call.
		this._pendingContext = context;

		// Emit turn start
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_START",
			payload: { message_count: context.messages.length },
			caused_by: event.event_id,
		});

		// Request an LLM call
		this._emit({
			actor_id: "coder_agent",
			type: "LLM_CALL_REQUESTED",
			payload: { message_count: context.messages.length },
			caused_by: event.event_id,
		});
	}

	// ─── LLM_CALL_REQUESTED ─────────────────────────────────────────────────

	private async _onLlmCallRequested(event: EventBase): Promise<void> {
		if (this._shouldInterrupt()) return;

		const context = this._pendingContext ?? this.config.projection.buildContext({ max_tokens: this.config.contextBudget });
		this._pendingContext = undefined;

		// Emit AGENT_MESSAGE_START up front so chunks have a parent in the causal chain.
		const msgStart = this._emit({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_START",
			payload: { model: { provider: this.config.model.provider, model_id: this.config.model.model_id } },
			caused_by: event.event_id,
		});

		try {
			// Start the stream-idle watchdog. It fires if no chunk arrives
			// within the timeout window, aborting the hung LLM call so the
			// reactor emits LLM_CALL_FAILED instead of hanging forever.
			this._startStreamIdleWatchdog();
			const response = await this.config.llmClient.complete({
				messages: context.messages,
				systemPrompt: this.config.systemPrompt,
				model: this.config.model,
				tools: this.config.tools,
				signal: this.abortController?.signal,
				onChunk: (chunk: LLMChunk) => {
					// Reset the idle timer on each chunk — the stream is alive.
					this._resetStreamIdleWatchdog();
					// Translate LLMChunk into an AGENT_MESSAGE_CHUNK event so projections / UI
					// can render the streaming response in real time.
					this._emit({
						actor_id: "coder_agent",
						type: "AGENT_MESSAGE_CHUNK",
						payload: { chunk: chunk as any },
						caused_by: msgStart.event_id,
					});
				},
			});

			this._stopStreamIdleWatchdog();
			this._handleLlmResponse(response, event.event_id, msgStart.event_id);
		} catch (err) {
			this._stopStreamIdleWatchdog();
			const msg = err instanceof Error ? err.message : String(err);
			const isRetryable = this.retryPolicy.isRetryable({ message: msg });

			this._emit({
				actor_id: "runtime",
				type: "LLM_CALL_FAILED",
				payload: { error: msg, retryable: isRetryable },
				caused_by: event.event_id,
			});
		}
	}

	/** Start (or restart) the stream-idle watchdog timer. */
	private _startStreamIdleWatchdog(): void {
		this._resetStreamIdleWatchdog();
	}

	/** Reset the watchdog — called on each chunk to prove the stream is alive. */
	private _resetStreamIdleWatchdog(): void {
		if (this._streamIdleTimer) clearTimeout(this._streamIdleTimer);
		this._streamIdleTimer = setTimeout(() => {
			this._streamIdleTimer = undefined;
			// Abort the in-flight LLM call. This causes the `await` in
			// _onLlmCallRequested to reject with an AbortError, which flows
			// into the catch block and emits LLM_CALL_FAILED.
			this.abortController?.abort();
		}, this._streamIdleTimeoutMs);
	}

	/** Clear the watchdog timer (call when the LLM response completes/fails). */
	private _stopStreamIdleWatchdog(): void {
		if (this._streamIdleTimer) {
			clearTimeout(this._streamIdleTimer);
			this._streamIdleTimer = undefined;
		}
	}

	private _handleLlmResponse(response: LLMResponse, causedBy: string, msgStartEventId?: string): void {
		// AGENT_MESSAGE_START is now emitted by _onLlmCallRequested before the call so chunks
		// can reference it. For backwards compat with callers that don't stream, emit it here
		// if not already emitted.
		if (!msgStartEventId) {
			const started = this._emit({
				actor_id: "coder_agent",
				type: "AGENT_MESSAGE_START",
				payload: { model: { provider: response.provider, model_id: response.model } },
				caused_by: causedBy,
			});
			msgStartEventId = started.event_id;
		}

		// Emit message end (the chunking is optional; for now we skip to end for simplicity)
		const toolCalls = extractToolCalls(response.content);

		// Append the AGENT_MESSAGE_END event.
		const msgEnd = this._emit({
			actor_id: "coder_agent",
			type: "AGENT_MESSAGE_END",
			payload: {
				content: response.content,
				model: { provider: response.provider, model_id: response.model },
				usage: response.usage,
				stop_reason: response.stopReason,
				error_message: response.errorMessage,
			},
			caused_by: causedBy,
		});

		// Emit thinking end (turn_end is now emitted in _onAgentMessageEnd)
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_THINKING_END",
			payload: {},
			caused_by: msgEnd.event_id,
		});

		// The ON_AGENT_MESSAGE_END handler will dispatch tool calls or complete the turn
	}

	// ─── AGENT_MESSAGE_END ──────────────────────────────────────────────────

	private async _onAgentMessageEnd(event: EventBase): Promise<void> {
		const payload = event.payload as {
			content: unknown[];
			stop_reason: string;
			error_message?: string;
		};

		const toolCalls = extractToolCalls(payload.content as Parameters<typeof extractToolCalls>[0]);

		if (this._shouldInterrupt()) {
			// Emit turn end before completion when interrupted
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_END",
				payload: { tool_calls_count: toolCalls.length },
				caused_by: event.event_id,
			});
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "aborted" },
				caused_by: event.event_id,
			});
			return;
		}

		if (toolCalls.length === 0 || payload.stop_reason !== "tool_use") {
			// No tool calls — emit turn end and complete the turn
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_END",
				payload: { tool_calls_count: 0 },
				caused_by: event.event_id,
			});
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: payload.stop_reason as "stop" | "length" | "error", error_message: payload.error_message },
				caused_by: event.event_id,
			});
			return;
		}

		// Track this turn's tool executions
		const tracker: TurnTracker = {
			assistantMessageEventId: event.event_id,
			expectedCount: toolCalls.length,
			expectedToolCallIds: new Set(toolCalls.map((toolCall) => toolCall.id)),
			received: [],
			abortSignal: this.abortController?.signal,
		};
		this.turnTrackers.set(event.event_id, tracker);

		// Record the sorted signature (tool name + argument hash) for loop detection.
		// Including arguments prevents false positives when the model calls the same
		// tool (e.g. `cli`) repeatedly with different commands — a normal workflow.
		const signature = toolCalls
			.map((tc) => `${tc.name}:${hashArguments(tc.arguments)}`)
			.sort();
		this._toolRoundSignatures.push(signature);

		// Emit one INTENT_TOOL_CALL per tool call
		for (const toolCall of toolCalls) {
			const classification = this.config.classifier.classify(toolCall.name, toolCall.arguments);
			this._emit({
				actor_id: "coder_agent",
				type: "INTENT_TOOL_CALL",
				payload: {
					tool_call_id: toolCall.id,
					tool_name: toolCall.name,
					arguments: toolCall.arguments,
					assistant_message_event_id: event.event_id,
					requires_approval: classification.requires_approval,
					classification,
				},
				caused_by: event.event_id,
			});
		}
	}

	// ─── INTENT_TOOL_CALL ──────────────────────────────────────────────────

	private get _pendingApprovals() {
		return this.turnState.pendingApprovals;
	}

	/**
	 * Resolve every pending approval as rejected and notify the UI to dismiss its
	 * dialogs. Called on user interrupt and on stop() so the `await` inside
	 * _onIntentToolCall can never be left dangling — a dangling approval promise
	 * would strand its turn tracker and hang the turn forever.
	 */
	private _drainPendingApprovals(): void {
		if (this._pendingApprovals.size === 0) return;
		const pending = [...this._pendingApprovals.entries()];
		this._pendingApprovals.clear();
		for (const [intentEventId, entry] of pending) {
			try {
				this.config.approvalHandler?.cancelApproval(intentEventId);
			} catch {
				// A failing UI handler must not block the remaining resolutions.
			}
			entry.resolve(false);
		}
	}

	private async _onIntentToolCall(event: EventBase): Promise<void> {
		if (this._shouldInterrupt()) return;

		const payload = event.payload as {
			tool_call_id: string;
			tool_name: string;
			arguments: Record<string, unknown>;
			requires_approval: boolean;
			classification?: IntentClassification;
		};

		if (payload.requires_approval) {
			if (!this.config.approvalHandler) {
				this._emitToolExecutionRejected(payload.tool_call_id, payload.tool_name, {
					content: [{ type: "text", text: "Tool execution requires approval, but no approval handler is available." }],
					is_error: true,
					error_message: "Approval required but no approval handler is available",
				}, event.event_id);
				return;
			}

			// Wait for user approval/rejection
			const approved = await new Promise<boolean>((resolve) => {
				this._pendingApprovals.set(event.event_id, {
					resolve,
					tool_call_id: payload.tool_call_id,
					tool_name: payload.tool_name,
					arguments: payload.arguments,
				});
				this.config.approvalHandler?.requestApproval(
					event.event_id,
					payload.classification!,
					payload.tool_name,
					payload.arguments,
				);
			});

			if (!approved) {
				this._emitToolExecutionRejected(payload.tool_call_id, payload.tool_name, {
					content: [{ type: "text", text: "Tool execution rejected by user." }],
					is_error: true,
					error_message: "User rejected the tool call",
				}, event.event_id);
				return;
			}
		}

		// Execute the tool
		await this._executeTool(event.event_id, payload.tool_call_id, payload.tool_name, payload.arguments);
	}

	private async _executeTool(causedBy: string, tool_call_id: string, tool_name: string, args: Record<string, unknown>): Promise<void> {
		const startTime = Date.now();

		this._emit({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: { tool_call_id, tool_name, arguments: args },
			caused_by: causedBy,
		});

		try {
			const result = await this.config.runtimeAdapter.executeTool({
				tool_call_id,
				tool_name,
				arguments: args,
				caused_by: causedBy,
				signal: this.abortController?.signal,
				onUpdate: (partial) => {
					this._emitToolExecutionUpdate(tool_call_id, partial, causedBy);
				},
			});
			this._emitToolExecutionEnd(tool_call_id, tool_name, result, causedBy, startTime);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this._emitToolExecutionEnd(tool_call_id, tool_name, {
				content: [{ type: "text", text: msg }],
				is_error: true,
				error_message: msg,
			}, causedBy, startTime);
		}
	}

	private _emitToolExecutionUpdate(
		tool_call_id: string,
		partial: ToolExecutionUpdate,
		causedBy: string,
	): void {
		this._emit({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_UPDATE",
			payload: {
				tool_call_id,
				update: stringifyToolUpdate(partial),
				progress: partial.progress,
			},
			caused_by: causedBy,
		});
	}

	private _emitToolExecutionEnd(
		tool_call_id: string,
		tool_name: string,
		result: ToolExecutionResult,
		causedBy: string,
		startTime?: number,
	): void {
		this._emit({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_END",
			payload: {
				tool_call_id,
				tool_name,
				result: result.content,
				details: result.details,
				is_error: result.is_error,
				duration_ms: startTime !== undefined ? Date.now() - startTime : 0,
				file_mutations: result.file_mutations,
			},
			caused_by: causedBy,
		});
	}
	// Emit a START→END pair for tool calls that never actually execute (e.g.
	// rejected by user, or approval required but no handler available). Previously
	// these branches emitted only END, leaving an unpaired event in the log and
	// breaking START/END matching for projections/timeline UI.
	private _emitToolExecutionRejected(
		tool_call_id: string,
		tool_name: string,
		result: ToolExecutionResult,
		causedBy: string,
	): void {
		this._emit({
			actor_id: "runtime",
			type: "TOOL_EXECUTION_START",
			payload: { tool_call_id, tool_name, arguments: {} },
			caused_by: causedBy,
		});
		this._emitToolExecutionEnd(tool_call_id, tool_name, result, causedBy);
	}

	// ─── TOOL_EXECUTION_END ─────────────────────────────────────────────────

	private async _onToolExecutionEnd(event: EventBase): Promise<void> {
		const payload = event.payload as {
			tool_call_id: string;
			tool_name: string;
			result: unknown[];
			details?: unknown;
			is_error: boolean;
			file_mutations?: Array<{ path: string; operation: string; diff?: string }>;
		};

		// Emit FILE_MUTATION_APPLIED for each mutation reported by the tool
		if (payload.file_mutations?.length) {
			for (const mutation of payload.file_mutations) {
				this._emit({
					actor_id: "runtime",
					type: "FILE_MUTATION_APPLIED",
					payload: {
						path: mutation.path,
						operation: mutation.operation,
						diff: mutation.diff,
						tool_name: payload.tool_name,
						tool_call_id: payload.tool_call_id,
					},
					caused_by: event.event_id,
				});
			}
		}

		// Locate the tracker via the INTENT_TOOL_CALL event (caused_by), which
		// carries the assistant_message_event_id directly — no causal-chain walk,
		// no cross-tracker tool_call_id scan (provider ids may collide).
		const intentEvent = event.caused_by ? this.config.store.get(event.caused_by) : undefined;
		const assistantMessageEventId =
			intentEvent?.type === "INTENT_TOOL_CALL"
				? (intentEvent.payload as { assistant_message_event_id?: string }).assistant_message_event_id
				: undefined;
		const tracker = assistantMessageEventId ? this.turnTrackers.get(assistantMessageEventId) : undefined;

		if (!tracker || !assistantMessageEventId) return;
		if (tracker.received.some((result) => result.tool_call_id === payload.tool_call_id)) return;

		tracker.received.push({
			tool_call_id: payload.tool_call_id,
			tool_name: payload.tool_name,
			result: { content: payload.result as ToolExecutionResult["content"], is_error: payload.is_error },
			is_error: payload.is_error,
		});

		// If all tools have completed, emit TOOL_RESULTS_AGGREGATED
		if (tracker.received.length === tracker.expectedCount) {
			this.turnTrackers.delete(assistantMessageEventId);
			this._emit({
				actor_id: "coder_agent",
				type: "TOOL_RESULTS_AGGREGATED",
				payload: {
					assistant_message_event_id: assistantMessageEventId,
					tool_call_count: tracker.expectedCount,
					any_error: tracker.received.some((r) => r.is_error),
				},
				caused_by: event.event_id,
			});
		}
	}

	// ─── TOOL_RESULTS_AGGREGATED ────────────────────────────────────────────

	private async _onToolResultsAggregated(event: EventBase): Promise<void> {
		const payload = event.payload as { tool_call_count: number; any_error: boolean };

		if (this._shouldInterrupt()) {
			// Emit turn end before completion when interrupted
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_END",
				payload: { tool_calls_count: payload.tool_call_count },
				caused_by: event.event_id,
			});
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "aborted" },
				caused_by: event.event_id,
			});
			return;
		}

		// Emit turn end to signal completion of this tool-call turn
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_END",
			payload: { tool_calls_count: payload.tool_call_count },
			caused_by: event.event_id,
		});

		// Loop detection: if the model has called the exact same set of tools
		// (by name) in too many consecutive rounds, break the loop by completing
		// the turn instead of requesting another LLM round.
		if (this._isInToolLoop()) {
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "loop_detected" },
				caused_by: event.event_id,
			});
			return;
		}

		// Kick off the next turn with the tool results
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_REQUESTED",
			payload: { reason: "tool_results" },
			caused_by: event.event_id,
		});
	}

	// ─── SESSION_BOUNDARY_INFERRED / SESSION_FORKED / SESSION_JUMPED ────────

	/**
	 * When the active session changes (split, fork, or history-tree jump),
	 * refresh the projection to point to the new session so buildContext()
	 * reflects the new context. For splits, the new session's start_event_id
	 * is set to the current USER_MESSAGE, so the model keeps the user's request
	 * + tool results but drops old conversation history.
	 */
	private _onSessionBoundaryInferred(_event: EventBase): void {
		if (!this.config.sessionManager) return;
		const newProjection = this.config.sessionManager.getActiveSession();
		if (newProjection) {
			this.config.projection = newProjection;
		}
		// Refresh system prompt so session-position breadcrumbs stay current.
		if (this.config.refreshSystemPrompt) {
			this.config.systemPrompt = this.config.refreshSystemPrompt();
		}
	}

	/**
	 * Check whether the model is stuck in a loop — calling the exact same set
	 * of tools (by name AND arguments) in too many consecutive rounds.
	 */
	private _isInToolLoop(): boolean {
		const sigs = this._toolRoundSignatures;
		if (sigs.length < MAX_CONSECUTIVE_IDENTICAL_TOOL_ROUNDS) return false;
		const recent = sigs.slice(-MAX_CONSECUTIVE_IDENTICAL_TOOL_ROUNDS);
		const first = recent[0]!.join(",");
		return recent.every((sig) => sig.join(",") === first);
	}

	// ─── AGENT_TURN_COMPLETED ───────────────────────────────────────────────
	//
	// Drain the followUp queue (if any) or let the reactor go idle.
	// Also triggers compaction check after a non-error turn.

	private _onAgentTurnCompleted(event: EventBase): void {
		const payload = event.payload as { reason: string; error_message?: string };

		// The turn is over from the reactor's perspective. If a queued follow-up is
		// delivered below, its USER_MESSAGE handler re-sets this to true synchronously.
		this._turnInFlight = false;

		// If abort() was called, discard any pending follow-ups so the reactor stops.
		// _abortedByUser is set by _onUserInterrupt when the interrupt has no new content.
		if (this._abortedByUser) {
			// Record the follow-ups we are about to discard so _replayPendingFollowUps does
			// not resurrect them on the next reactor restart. Only entries that originated
			// from a USER_FOLLOWUP_QUEUED event have a sourceEventId worth recording.
			const droppedIds = this.followUpQueue
				.map((f) => f.sourceEventId)
				.filter((id): id is string => typeof id === "string");
			if (droppedIds.length > 0) {
				this._emit({
					actor_id: "runtime",
					type: "USER_FOLLOWUP_DROPPED",
					payload: { dropped_event_ids: droppedIds, reason: "user_interrupt" },
					caused_by: event.event_id,
				});
			}
			this.followUpQueue.length = 0;
			this._abortedByUser = false;
			return;
		}

		if (this._scheduleRetryForCompletedError(event)) {
			// A retry is pending — the turn loop will re-enter, so stay busy.
			this._turnInFlight = true;
			return;
		}

		// If a steer or follow-up message is queued, deliver it as a new USER_MESSAGE
		// so the turn cycle restarts.
		if (this.followUpQueue.length > 0) {
			this._deliverFollowUpNow(event.event_id);
			return;
		}

		// Check compaction policy after a non-aborted turn
		if (payload.reason !== "aborted") {
			this._checkCompaction(event);
		}
	}

	// ─── Follow-up delivery helpers ──────────────────────────────────────────

	/**
	 * Whether the reactor is fully idle and can start a turn for a queued
	 * follow-up right now: no turn in flight, no retry backoff pending, and no
	 * compaction running (a follow-up queued during compaction is delivered by
	 * _onCompactionSettled once the compaction finishes).
	 */
	private _canDeliverFollowUpNow(): boolean {
		return !this._turnInFlight && this.retryTimers.size === 0 && this.compactionAbort === undefined;
	}

	/**
	 * Deliver the head of the follow-up queue as a fresh USER_MESSAGE turn.
	 * Shared by the turn-completion drain, idle-time queueing, and post-compaction
	 * delivery. Resets the abort controller first — the previous turn's interrupt
	 * (if any) has already been handled, and _onUserMessage drops messages while
	 * the signal is aborted.
	 *
	 * Uses the source event id (USER_FOLLOWUP_QUEUED or USER_INTERRUPT) as
	 * caused_by so _replayPendingFollowUps can detect the follow-up as consumed
	 * on restart; falls back to the completion event id for legacy entries
	 * without a source id.
	 */
	private _deliverFollowUpNow(causedByFallback: string): void {
		if (this.followUpQueue.length === 0) return;
		this.abortController = new AbortController();
		const next = this.followUpQueue.shift()!;
		// Queued from a raw USER_MESSAGE that arrived mid-turn: the content is
		// already in the log (and the context). Start a turn for it directly —
		// appending another USER_MESSAGE would duplicate it in the context.
		if (next.userMessageEventId) {
			this._turnInFlight = true;
			this._toolRoundSignatures = [];
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_THINKING_START",
				payload: { model: this.config.model.model_id },
				caused_by: next.userMessageEventId,
			});
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_REQUESTED",
				payload: { reason: "user_message" },
				caused_by: next.userMessageEventId,
			});
			return;
		}
		this._emit({
			actor_id: "user",
			type: "USER_MESSAGE",
			payload: { content: next.content, images: next.images },
			caused_by: next.sourceEventId ?? causedByFallback,
		});
	}

	/** After compaction settles, deliver any follow-ups queued while it ran. */
	private _onCompactionSettled(event: EventBase): void {
		if (this._canDeliverFollowUpNow()) {
			this._deliverFollowUpNow(event.event_id);
		}
	}

	// ─── LLM_CALL_FAILED ────────────────────────────────────────────────────

	private async _onLlmCallFailed(event: EventBase): Promise<void> {
		const payload = event.payload as { error: string; retryable: boolean };

		// If the call failed because the user aborted, don't retry — emit
		// turn completion so the runtime settles and the UI exits streaming.
		if (this._shouldInterrupt()) {
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_END",
				payload: { tool_calls_count: 0 },
				caused_by: event.event_id,
			});
			this._emit({
				actor_id: "coder_agent",
				type: "AGENT_TURN_COMPLETED",
				payload: { reason: "aborted" },
				caused_by: event.event_id,
			});
			return;
		}

		const retryResult = this._scheduleRetry(event, payload.error, payload.retryable);
		if (retryResult === "scheduled") return;

		// Emit turn end before completion
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_END",
			payload: { tool_calls_count: 0 },
			caused_by: event.event_id,
		});
		this._emit({
			actor_id: "coder_agent",
			type: "AGENT_TURN_COMPLETED",
			payload: {
				reason: "error",
				error_message:
					retryResult === "max_attempts"
						? `Max retries (${this.retryPolicy.maxAttempts}) exceeded: ${payload.error}`
						: retryResult === "backoff_exhausted"
							? `Retry backoff exhausted: ${payload.error}`
							: payload.error,
			},
			caused_by: event.event_id,
		});
	}

	private _scheduleRetryForCompletedError(event: EventBase): boolean {
		if (this.config.retryAssistantErrorCompletions === false) return false;

		const payload = event.payload as { reason?: string; error_message?: string };
		if (payload.reason !== "error") return false;
		if (this._errorAlreadyHandledByLlmFailure(event)) return false;

		const errorMessage = payload.error_message ?? "Agent turn completed with error";
		return this._scheduleRetry(event, errorMessage, this.retryPolicy.isRetryable({ message: errorMessage })) === "scheduled";
	}

	private _errorAlreadyHandledByLlmFailure(event: EventBase): boolean {
		const causedBy = event.caused_by ? this.config.store.get(event.caused_by) : undefined;
		return causedBy?.type === "LLM_CALL_FAILED";
	}

	private _scheduleRetry(event: EventBase, error: string, retryable: boolean): RetryScheduleResult {
		const attempt = this._attemptCount(event.event_id);
		if (!retryable || attempt >= this.retryPolicy.maxAttempts) {
			return retryable ? "max_attempts" : "not_retryable";
		}
		const nextAttempt = attempt + 1;
		const delayMs = this.retryPolicy.nextDelayMs(nextAttempt);
		if (delayMs === null) {
			return "backoff_exhausted";
		}

		const retryScheduled = this._emit({
			actor_id: "runtime",
			type: "RETRY_SCHEDULED",
			payload: {
				attempt: nextAttempt,
				max_attempts: this.retryPolicy.maxAttempts,
				delay_ms: delayMs,
				error_message: error,
			},
			caused_by: event.event_id,
		});

		const timeout = setTimeout(() => {
			this.retryTimers.delete(retryScheduled.event_id);
			if (!this._shouldInterrupt()) {
				this._emit({
					actor_id: "coder_agent",
					type: "AGENT_TURN_REQUESTED",
					payload: { reason: "retry", retry_attempt: nextAttempt },
					caused_by: retryScheduled.event_id,
				});
			}
		}, delayMs);
		this.retryTimers.set(retryScheduled.event_id, {
			scheduled_event_id: retryScheduled.event_id,
			timeout,
			attempt: nextAttempt,
			errorMessage: error,
			retry: () => {},
		});
		return "scheduled";
	}

	/** Walk causal chain back to find the highest retry_attempt seen. */
	private _attemptCount(eventId: string): number {
		const chain = this.config.store.getCausalChain(eventId);
		let attempt = 0;
		for (const e of chain) {
			if (e.type === "AGENT_TURN_REQUESTED") {
				const p = e.payload as { retry_attempt?: number };
				if (p.retry_attempt !== undefined && p.retry_attempt > attempt) {
					attempt = p.retry_attempt;
				}
			}
		}
		return attempt;
	}

	// ─── USER_APPROVAL ──────────────────────────────────────────────────────

	private async _onUserApproval(event: EventBase): Promise<void> {
		const payload = event.payload as { intent_event_id: string };
		const pending = this._pendingApprovals.get(payload.intent_event_id);
		if (pending) {
			this._pendingApprovals.delete(payload.intent_event_id);
			pending.resolve(true);
		}
	}

	// ─── USER_REJECTION ─────────────────────────────────────────────────────

	private async _onUserRejection(event: EventBase): Promise<void> {
		const payload = event.payload as { intent_event_id: string };
		const pending = this._pendingApprovals.get(payload.intent_event_id);
		if (pending) {
			this._pendingApprovals.delete(payload.intent_event_id);
			pending.resolve(false);
		}
	}

	// ─── COMPACTION ─────────────────────────────────────────────────────────

	private async _onCompactionRequested(event: EventBase): Promise<void> {
		if (this.compactionAbort) return; // Already running

		const payload = event.payload as { reason: "manual" | "threshold" | "overflow"; token_count: number };
		const abortController = new AbortController();
		this.compactionAbort = abortController;

		this._emit({
			actor_id: "compactor",
			type: "COMPACTION_START",
			payload: { token_count: payload.token_count },
			caused_by: event.event_id,
		});

		try {
			const outcome = await this.compactionPolicy.compact(payload.reason, abortController.signal);
			this._emit({
				actor_id: "compactor",
				type: "COMPACTION_END",
				payload: { ...outcome },
				caused_by: event.event_id,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (abortController.signal.aborted) {
				this._emit({
					actor_id: "compactor",
					type: "COMPACTION_ABORTED",
					payload: {
						reason: "user_cancelled",
						message: msg,
						token_count: payload.token_count,
					},
					caused_by: event.event_id,
				});
				return;
			}
			// A failed compaction must NOT emit COMPACTION_END: projections treat END
			// as a context boundary, and an empty first_kept_event_id would truncate
			// the entire pre-compaction context (falling back to sequence + 1).
			this._emit({
				actor_id: "compactor",
				type: "COMPACTION_ABORTED",
				payload: {
					reason: "error",
					message: msg,
					token_count: payload.token_count,
				},
				caused_by: event.event_id,
			});
		} finally {
			this.compactionAbort = undefined;
		}
	}

	/**
	 * Check compaction policy after a non-error turn. Emits COMPACTION_REQUESTED if
	 * threshold or overflow conditions are met.
	 */
	private _checkCompaction(turnCompletedEvent: EventBase): void {
		const policy = this.compactionPolicy;

		// Walk the causal chain to find the AGENT_MESSAGE_END that produced this turn completion.
		// This avoids mutable state (_lastAssistantMessageEvent) that races with synchronous event dispatch.
		const lastAssistant = this._findLastAssistantMessage(turnCompletedEvent.event_id);

		// Overflow takes priority — when it fires we skip the threshold check entirely.
		// This prevents both "overflow" and "threshold" COMPACTION_REQUESTED events from
		// being emitted in the same turn (overflow implies context is over threshold too).
		if (policy.isOverflow(lastAssistant)) {
			const tokens = policy.estimateContextTokens();
			this._emit({
				actor_id: "runtime",
				type: "COMPACTION_REQUESTED",
				payload: { reason: "overflow", token_count: tokens },
				caused_by: turnCompletedEvent.event_id,
			});
			return;
		}

		const tokens = policy.estimateContextTokens();
		const window = policy.contextWindow();
		if (window > 0 && window !== Number.MAX_SAFE_INTEGER && tokens > window * policy.threshold()) {
			this._emit({
				actor_id: "runtime",
				type: "COMPACTION_REQUESTED",
				payload: { reason: "threshold", token_count: tokens },
				caused_by: turnCompletedEvent.event_id,
			});
		}
	}

	/**
	 * Walk causal chain back from the given event to find the most recent AGENT_MESSAGE_END.
	 * Replaces the mutable _lastAssistantMessageEvent field which races with synchronous dispatch.
	 */
	private _findLastAssistantMessage(eventId: string): EventBase | undefined {
		const chain = this.config.store.getCausalChain(eventId);
		for (let i = chain.length - 1; i >= 0; i--) {
			if (chain[i].type === "AGENT_MESSAGE_END") return chain[i];
		}
		return undefined;
	}

}

function stringifyToolUpdate(partial: ToolExecutionUpdate): string {
	const text = partial.content
		.filter((block): block is { type: string; text: string } => {
			return block.type === "text" && "text" in block && typeof block.text === "string";
		})
		.map((block) => block.text)
		.join("\n");
	if (text) return text;
	if (partial.content.length > 0) return JSON.stringify(partial.content);
	if (partial.details !== undefined) return JSON.stringify(partial.details);
	return "";
}
