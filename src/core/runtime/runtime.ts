/**
 * Event-Sourced Runtime
 *
 * Top-level runtime that assembles EventStore + SessionManager + Reactor.
 * Provides unified interface for UI layers.
 */

import type { AgentMessage } from "../agent/types.js";
import type { EventBase, ImageContent, FileAttachment } from "../event-store/types.js";
import type { EventStore, SubscribeOptions } from "../event-store/store.js";
import type { SessionDescriptor } from "../projection/types.js";
import type { ToolRegistry, ApprovalHandler } from "../intent/types.js";
import type { LLMClient, ModelConfig, ToolDefinition } from "./llm-types.js";
import { SqliteEventStore } from "../event-store/sqlite-store.js";
import { ThreadScopedStore } from "../event-store/thread-scoped-store.js";
import { SessionStore, isSessionStore } from "../event-store/session-store.js";
import { deriveWorkspaceId, getEventDatabasePath } from "../event-store/workspace.js";
import { SessionManager } from "../projection/session-manager.js";
import { SessionProjection } from "../projection/session-projection.js";
import { TimelineProjection, type TimelineQueryOptions } from "../projection/timeline-projection.js";
import { IntentClassifier, type ClassifierConfig } from "../intent/classifier.js";
import { Reactor } from "./reactor.js";
import { generateRunId, TurnState } from "./turn-state.js";
import type { CheckpointRef, RuntimeAdapter, RuntimeStatus } from "./types.js";
import { LocalRuntimeAdapter } from "./local-runtime.js";
import { CompactionEngine, type CompactionEngineSettings } from "../compaction/compaction-engine.js";
import { getAgentDir } from "../../config.js";

// ============================================================================
// Runtime Configuration
// ============================================================================

export interface EventSourcedRuntimeConfig {
	/** Working directory (used to derive workspace_id) */
	cwd: string;
	/** Agent directory for storage */
	agentDir?: string;
	/** SQLite database path for events (overrides default) */
	storagePath?: string;
	/** Pre-configured EventStore (optional, will create if not provided) */
	store?: EventStore;
	/** Close the configured store when this runtime is disposed. */
	ownsStore?: boolean;
	/** Thread ID for event isolation. When set, every appended event carries the current thread id. */
	threadId?: string | (() => string | undefined);
	/** Pre-configured SessionManager (optional, will create if not provided) */
	sessionManager?: SessionManager;
	/** Classifier configuration */
	classifierConfig?: ClassifierConfig;
	/** Tool registry */
	toolRegistry: ToolRegistry;
	/** Runtime adapter for deterministic tool execution and checkpoints */
	runtimeAdapter?: RuntimeAdapter;
	/** Approval handler for UI */
	approvalHandler?: ApprovalHandler;
	/** LLM client */
	llmClient: LLMClient;
	/** System prompt */
	systemPrompt: string;
	/** Model configuration */
	model: ModelConfig;
	/** Tools available to the agent */
	tools: ToolDefinition[];
	/** Context token budget */
	contextBudget?: number;
	/** Retry policy (default: DefaultRetryPolicy). */
	retryPolicy?: import("./policies.js").RetryPolicy;
	/** Whether assistant messages that complete with stop_reason=error should be retried by the reactor. */
	retryAssistantErrorCompletions?: boolean;
	/** Compaction policy (default: NoopCompactionPolicy). */
	compactionPolicy?: import("./policies.js").CompactionPolicy;
	/** Settings for the default event-sourced compaction engine. Ignored when compactionPolicy is provided. */
	compactionEngineSettings?: CompactionEngineSettings;
	/**
	 * Optional callback to rebuild the system prompt when the active session
	 * changes (split/fork/jump). Returns the updated system prompt string.
	 */
	refreshSystemPrompt?: () => string;
	/**
	 * Run at the start of each user-prompt turn (before the first LLM round).
	 * Extension host: fire before_agent_start hooks here so system-prompt
	 * injections apply to the turn. Forwarded to the reactor.
	 */
	beforeAgentStart?: (payload: {
		prompt: string;
		images?: unknown[];
	}) => Promise<{ systemPrompt?: string } | undefined>;
}

export interface RuntimeCompactOptions {
	reason?: "manual" | "threshold" | "overflow";
	token_count?: number;
}

// ============================================================================
// Event-Sourced Runtime
// ============================================================================

/**
 * EventSourcedRuntime - the primary LLM execution engine.
 *
 * Assembles EventStore + SessionManager + Reactor.
 * Provides unified interface for UI layers.
 */
export class EventSourcedRuntime {
	readonly store: EventStore;
	readonly sessionManager: SessionManager | undefined;
	readonly runtimeAdapter: RuntimeAdapter;
	readonly classifier: IntentClassifier;
	private reactor: Reactor | null = null;
	private config: EventSourcedRuntimeConfig;
	private readonly ownsStore: boolean;
	private readonly rawStore: EventStore;

	/** Working directory for this runtime */
	get cwd(): string { return this.config.cwd; }
	/** Agent data directory */
	get agentDir(): string { return this.config.agentDir ?? getAgentDir(); }
	private _isProcessing = false;
	/** Shared turn-level state across reactor lifecycles (follow-ups, retries,
	 * trackers, approvals). Survives per-prompt reactor restarts. */
	private readonly turnState = new TurnState(generateRunId());
	/** In-flight compaction started while no reactor was alive (idle /compact). */
	private _idleCompaction: Promise<void> | undefined;
	private _idleCompactionAbort: AbortController | undefined;
	private _turnCompletionWaiters: Array<() => void> = [];
	private _turnSubscription: (() => void) | undefined;
	private _resolveSettled: (() => void) | undefined;
	constructor(config: EventSourcedRuntimeConfig) {
		this.config = config;
		this.ownsStore = config.ownsStore ?? !config.store;

		// 1. Create or use provided EventStore
		const workspaceId = deriveWorkspaceId(config.cwd);
		const rawStore = config.store ?? new SqliteEventStore(
			workspaceId,
			config.storagePath ?? getEventDatabasePath(workspaceId, config.agentDir),
		);
		this.rawStore = rawStore;
		this.store = config.threadId ? new ThreadScopedStore(rawStore, config.threadId) : rawStore;

		this.runtimeAdapter = config.runtimeAdapter ?? new LocalRuntimeAdapter({
			workspace_id: this.store.workspace_id,
			cwd: config.cwd,
			agentDir: config.agentDir,
			toolRegistry: config.toolRegistry,
		});

		// 2. Create or use provided SessionManager (optional for migration)
		this.sessionManager = config.sessionManager ?? (config.sessionManager !== undefined ? new SessionManager(
			this.store,
			isSessionStore(rawStore) ? (rawStore as SessionStore) : undefined,
		) : undefined);

		// 3. Create IntentClassifier
		this.classifier = new IntentClassifier(config.classifierConfig);

		this.store.append({
			actor_id: "runtime",
			type: "RUNTIME_STARTED",
			payload: {
				runtime_id: this.runtimeAdapter.runtime_id,
				kind: this.runtimeAdapter.kind,
				cwd: config.cwd,
				// Unique per boot: short-lived turn-state events (e.g.
				// USER_FOLLOWUP_QUEUED) reference it so replay can tell this
				// run's queue entries from previous runs' dead buffers.
				run_id: this.turnState.runId,
			},
		});
	}

	/**
				payload: { content: text, images, files },
	 */
	async prompt(text: string, images?: ImageContent[], files?: FileAttachment[]): Promise<void> {
		if (this._isProcessing) {
			throw new Error(
				"EventSourcedRuntime is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}

		this._isProcessing = true;

		try {
			// An idle-triggered compaction (compact() with no live reactor) may
			// still be running; the new turn must not race it — both rewrite the
			// same context boundary.
			await this._idleCompaction?.catch(() => {});
			this.sessionManager?.ensureActiveSessionWritable("prompt from historical session");
			this.refreshSystemPromptForCurrentSession();
			// Lazy-create the reactor and start it. Reactor lives only as long as the prompt cycle.
			const projection = this.getProjection();

			this.reactor = new Reactor({
				turnState: this.turnState,
				store: this.store,
				projection,
				llmClient: this.config.llmClient,
				classifier: this.classifier,
				toolRegistry: this.config.toolRegistry,
				approvalHandler: this.config.approvalHandler,
				runtimeAdapter: this.runtimeAdapter,
				systemPrompt: this.config.systemPrompt,
				model: this.config.model,
				contextBudget: this.config.contextBudget ?? 128000,
				tools: this.config.tools,
				retryPolicy: this.config.retryPolicy,
				retryAssistantErrorCompletions: this.config.retryAssistantErrorCompletions,
				compactionPolicy: this._buildCompactionPolicy(projection),
			sessionManager: this.sessionManager,
			refreshSystemPrompt: this.config.refreshSystemPrompt,
			beforeAgentStart: this.config.beforeAgentStart,
		});

			await this.reactor.start();

			// Wait until the reactor reaches a fully idle state. The reactor may chain
			// multiple turns (e.g. follow-up queue draining), so we keep waiting until settled.
			// The settled check must be scoped to this prompt's thread: with
			// multiple threads on one store, another thread's USER_MESSAGE would
			// otherwise keep this prompt waiting forever (its own turn completed,
			// but globally lastMsg.sequence > lastCompleted.sequence stays true).
			// The thread id comes from the appended event (ThreadScopedStore tags
			// it); the subscription only fires on turn-completion events, which
			// necessarily happen after the append, so the holder is always set by
			// the time the check runs.
			let promptThreadId: string | undefined;
			const settledPromise = this._waitUntilSettled(() => promptThreadId);

			// Append the user message — the reactor will pick it up
			const userMessage = this.store.append({
				actor_id: "user",
				type: "USER_MESSAGE",
				payload: { content: text, images, files },
			});
			promptThreadId = userMessage.thread_id;

			await settledPromise;
		} finally {
			this._turnSubscription?.();
			this._turnSubscription = undefined;
			this.reactor?.stop();
			this.reactor = null;
			this._isProcessing = false;
			this._resolveSettled = undefined;
			this._resolveIdleWaiters();
		}
	}

	/**
	 * Check if runtime is currently processing.
	 */
	get isRunning(): boolean {
		return this._isProcessing;
	}

	get signal(): AbortSignal | undefined {
		return this.reactor?.signal;
	}

	/**
	 * Resolve when the current prompt cycle is fully settled.
	 */
	waitForIdle(): Promise<void> {
		if (!this._isProcessing && !this._idleCompaction) return Promise.resolve();
		return new Promise((resolve) => {
			this._turnCompletionWaiters.push(resolve);
		});
	}

	private _resolveIdleWaiters(): void {
		const waiters = this._turnCompletionWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	/**
	 * Interrupt current execution.
	 *
	 * Sets _abortedByUser on the reactor, which causes _onAgentTurnCompleted to discard
	 * queued follow-ups and let the reactor settle. The settled promise resolves naturally
	 * when the current turn finishes (via _waitUntilSettled).
	 *
	 * Edge case: if no turn is running (no AGENT_TURN_COMPLETED will fire), also resolve
	 * the settled promise immediately so the caller doesn't hang.
	 */
	abort(): void {
		this.store.append({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: {},
		});
		this.reactor?.interrupt();
		// Cancel a compaction running outside a prompt cycle (idle /compact).
		this._idleCompactionAbort?.abort();
		// The _waitUntilSettled subscription resolves when AGENT_TURN_COMPLETED fires;
		// when idle there is no pending settled promise (_resolveSettled is cleared in
		// prompt()'s finally), so nothing else to do here.
	}

	/**
	 * Inject a steer message — interrupts the current turn and delivers the message
	 * as a follow-up after the current turn settles.
	 */
	steer(text: string, images?: ImageContent[], files?: FileAttachment[]): void {
		if (!this._isProcessing) {
			// Idle: there is no turn to interrupt and no live reactor to pick up a
			// bare USER_MESSAGE — run it as a normal prompt cycle so it is actually
			// answered. If we lose a race with a concurrent prompt(), queue it as a
			// follow-up instead. Only the already-processing race is downgraded —
			// real prompt failures (LLM/tool errors) must not be silently re-queued.
			this.prompt(text, images, files).catch((err: unknown) => {
				if (err instanceof Error && err.message.includes("already processing")) {
					this.followUp(text, images, files);
				}
			});
			return;
		}
		this.store.append({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: { content: text, images, files, reason: "steer" },
		});
	}

	/** Queued follow-up/steer entries (empty when no reactor is alive). */
	get pendingFollowUps(): Array<{ kind: "steer" | "followUp"; content: string | unknown[]; sourceEventId?: string }> {
		return this.reactor?.pendingFollowUps ?? [];
	}

	/**
	 * Clear the pending follow-up queue and record a USER_FOLLOWUP_DROPPED event so
	 * reactor restarts do not resurrect the cleared messages. Returns the cleared
	 * entries split by kind (for the UI to restore them into the editor).
	 */
	clearQueuedFollowUps(): {
		steering: Array<{ content: string | unknown[]; sourceEventId?: string }>;
		followUp: Array<{ content: string | unknown[]; sourceEventId?: string }>;
	} {
		const entries = this.reactor?.pendingFollowUps ?? [];
		if (entries.length === 0) return { steering: [], followUp: [] };

		this.reactor?.clearFollowUpQueue();
		const droppedIds = entries
			.map((e) => e.sourceEventId)
			.filter((id): id is string => typeof id === "string");
		if (droppedIds.length > 0) {
			this.store.append({
				actor_id: "runtime",
				type: "USER_FOLLOWUP_DROPPED",
				payload: { dropped_event_ids: droppedIds, reason: "user_clear" },
			});
		}
		return {
			steering: entries.filter((e) => e.kind === "steer").map(({ content, sourceEventId }) => ({ content, sourceEventId })),
			followUp: entries.filter((e) => e.kind === "followUp").map(({ content, sourceEventId }) => ({ content, sourceEventId })),
		};
	}

	/**
	 * Cancel ONE queued follow-up by its source event id. Removes it from the
	 * in-memory queue and records a USER_FOLLOWUP_DROPPED event so reactor
	 * restarts do not resurrect it. Returns true when an entry was removed.
	 */
	cancelQueuedFollowUp(sourceEventId: string): boolean {
		return this._takeQueuedFollowUp(sourceEventId, "user_cancel") !== undefined;
	}

	/**
	 * Promote ONE queued follow-up to a steer: remove it from the queue (with a
	 * USER_FOLLOWUP_DROPPED so it cannot be resurrected or double-delivered) and
	 * re-inject its content via steer() — which interrupts the running turn and
	 * delivers the message immediately after it settles. Returns false when the
	 * entry is gone (already drained into a turn or cancelled) — in that case
	 * nothing is injected: the message is either already being answered or was
	 * deliberately removed.
	 */
	steerQueuedFollowUp(sourceEventId: string): boolean {
		const entry = this._takeQueuedFollowUp(sourceEventId, "promoted_to_steer");
		if (!entry) return false;
		if (!this._isProcessing) {
			// Idle: nothing to interrupt — same fallback as steer(-while-idle).
			const text = typeof entry.content === "string"
				? entry.content
				: entry.content
					.map((b) => (b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string" ? (b as { text: string }).text : ""))
					.filter(Boolean)
					.join("\n");
			this.steer(text, entry.images as ImageContent[] | undefined);
			return true;
		}
		// Mid-turn: append USER_INTERRUPT ourselves (steer path) so we know the
		// event id. Store subscribers run synchronously, so by the time append
		// returns, the reactor has re-queued the content at the END of the
		// follow-up queue keyed by this event id — promote it to the FRONT,
		// otherwise "send NOW" would paradoxically run last behind every other
		// queued message (the drain delivers front-first).
		const interruptEvent = this.store.append({
			actor_id: "user",
			type: "USER_INTERRUPT",
			payload: { content: entry.content, images: entry.images, reason: "steer" },
		});
		this.reactor?.promoteFollowUpToFront(interruptEvent.event_id);
		return true;
	}

	/** Atomically remove a queued entry by source event id, recording WHY. */
	private _takeQueuedFollowUp(
		sourceEventId: string,
		reason: "user_cancel" | "promoted_to_steer",
	): import("./turn-state.js").FollowUpEntry | undefined {
		const entry = this.reactor?.takeFollowUp(sourceEventId);
		if (entry) {
			this.store.append({
				actor_id: "runtime",
				type: "USER_FOLLOWUP_DROPPED",
				payload: { dropped_event_ids: [sourceEventId], reason },
			});
		}
		return entry;
	}

	/**
	 * Queue a follow-up message — delivered after the current turn naturally completes.
	 * If the runtime is not processing, queues it for the next prompt.
	 */
	followUp(text: string, images?: ImageContent[], files?: FileAttachment[]): void {
		this.store.append({
			actor_id: "user",
			type: "USER_FOLLOWUP_QUEUED",
			payload: { content: text, images, files, run_id: this.turnState.runId },
		});
	}

	/**
	 * Request context compaction. The active reactor handles this immediately when
	 * running; otherwise the request is recorded for the event stream.
	 */
	compact(options?: RuntimeCompactOptions): void {
		const requested = this.store.append({
			actor_id: "user",
			type: "COMPACTION_REQUESTED",
			payload: {
				reason: options?.reason ?? "manual",
				token_count: options?.token_count ?? 0,
			},
		});
		// A live reactor consumes COMPACTION_REQUESTED via its subscription. With
		// no reactor (idle — the common case for a manual /compact between turns)
		// the event used to be recorded and silently never handled. Run the
		// compaction inline instead so idle /compact actually compacts.
		if (!this.reactor && !this._idleCompaction) {
			this._idleCompaction = this._runIdleCompaction(requested.event_id, options?.reason ?? "manual", options?.token_count ?? 0)
				.finally(() => {
					this._idleCompaction = undefined;
					this._idleCompactionAbort = undefined;
					this._resolveIdleWaiters();
				});
		}
	}

	/**
	 * Execute a compaction outside any prompt cycle. Mirrors the reactor's
	 * _onCompactionRequested handling (START → policy.compact → END/ABORTED)
	 * so projections see the same event shapes regardless of who ran it.
	 *
	 * NEVER rejects: dispose() may close the store while a compaction is in
	 * flight (shutdown between two of its appends), and every append below
	 * then throws "database is not open". A rejection here used to escape as
	 * an unhandled promise rejection (vitest fails the run on it). A
	 * compaction that dies at shutdown is simply abandoned — the
	 * COMPACTION_REQUESTED event stays in the log and the next run can
	 * compact again.
	 */
	private async _runIdleCompaction(causedBy: string, reason: "manual" | "threshold" | "overflow", tokenCount: number): Promise<void> {
		const abortController = new AbortController();
		this._idleCompactionAbort = abortController;
		try {
			this.store.append({
				actor_id: "compactor",
				type: "COMPACTION_START",
				payload: { token_count: tokenCount },
				caused_by: causedBy,
			});
			const policy = this._buildCompactionPolicy(this.getProjection());
			const outcome = await policy.compact(reason, abortController.signal);
			this.store.append({
				actor_id: "compactor",
				type: "COMPACTION_END",
				payload: { ...outcome },
				caused_by: causedBy,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			try {
				this.store.append({
					actor_id: "compactor",
					type: "COMPACTION_ABORTED",
					payload: {
						reason: abortController.signal.aborted ? "user_cancelled" : "error",
						message: msg,
						token_count: tokenCount,
					},
					caused_by: causedBy,
				});
			} catch (appendErr) {
				// The store is already closed (runtime disposed mid-compaction) —
				// there is nothing left to record the abort on. Expected at
				// shutdown; not an error.
				const appendMsg = appendErr instanceof Error ? appendErr.message : String(appendErr);
				console.warn(`Idle compaction failed (${msg}) and its COMPACTION_ABORTED event could not be recorded: ${appendMsg}`);
			}
		}
	}

	private _buildCompactionPolicy(projection: SessionProjection): import("./policies.js").CompactionPolicy {
		return this.config.compactionPolicy ?? new CompactionEngine({
			store: this.store,
			projection,
			llmClient: this.config.llmClient,
			model: this.config.model,
			settings: {
				contextWindow: this.config.contextBudget ?? 128000,
				...this.config.compactionEngineSettings,
			},
		});
	}

	setModel(provider: string, modelId: string): void {
		const previous_provider = this.config.model.provider;
		const previous_model_id = this.config.model.model_id;
		this.config.model.provider = provider;
		this.config.model.model_id = modelId;
		this.store.append({
			actor_id: "user",
			type: "MODEL_CHANGED",
			payload: {
				provider,
				model_id: modelId,
				previous_provider,
				previous_model_id,
			},
		});
	}

	/**
	 * Replace the LLM client at runtime. Used when the facade was created
	 * without a model (first-run setup mode, llmClient=undefined) and a real
	 * model is later configured via reload_providers — without this the reactor
	 * would call into a null client and crash on the first prompt.
	 */
	setLlmClient(llmClient: LLMClient): void {
		this.config.llmClient = llmClient;
	}

	getModel(): ModelConfig {
		return { ...this.config.model };
	}

	setThinkingLevel(level: string): void {
		const previous_level = this.config.model.thinking_level;
		this.config.model.thinking_level = level;
		this.store.append({
			actor_id: "user",
			type: "THINKING_LEVEL_CHANGED",
			payload: { level, previous_level },
		});
	}

	getThinkingLevel(): string | undefined {
		return this.config.model.thinking_level;
	}

	getProjection(): SessionProjection {
		return this.sessionManager?.getActiveSession() ?? this._createDefaultProjection();
	}

	getTools(): ToolDefinition[] {
		return [...this.config.tools];
	}

	setTools(tools: ToolDefinition[]): void {
		this.config.tools.splice(0, this.config.tools.length, ...tools);
		this.store.append({
			actor_id: "user",
			type: "USER_CONFIG_CHANGE",
			payload: { key: "tools", old_value: undefined, new_value: tools.map((tool) => tool.name) },
		});
	}

	getSystemPrompt(): string {
		return this.config.systemPrompt;
	}

	setSystemPrompt(prompt: string): void {
		const old_value = this.config.systemPrompt;
		if (old_value === prompt) return;
		this.config.systemPrompt = prompt;
		this.store.append({
			actor_id: "user",
			type: "USER_CONFIG_CHANGE",
			payload: { key: "systemPrompt", old_value, new_value: prompt },
		});
	}

	setApprovalHandler(approvalHandler: ApprovalHandler): void {
		this.config.approvalHandler = approvalHandler;
	}
	/**
	 * Toggle safe mode at runtime. When on, risky tool calls require explicit
	 * user approval before executing. Pass `undefined` to defer to the
	 * per-category require_approval_* gates the runtime was configured with.
	 */
	setSafeMode(enabled: boolean | undefined): void {
		this.classifier.setSafeMode(enabled);
	}

	/** Update per-category approval gates live (effective when safe mode is auto). */
	setApprovalGates(gates: { writes?: boolean; edits?: boolean; shellModerate?: boolean; unknown?: boolean }): void {
		this.classifier.setApprovalGates(gates);
	}

	/** Whether safe mode is currently active. */
	get isSafeMode(): boolean {
		return this.classifier.isSafeMode;
	}

	private _createDefaultProjection(): SessionProjection {
		const desc: SessionDescriptor = {
			session_id: "default",
			thread_id: "default",
			workspace_id: this.store.workspace_id,
			event_range: { start_event_id: "ORIGIN", end_event_id: "HEAD" },
			created_by: "user_explicit",
			created_at: Date.now(),
		};
		return new SessionProjection(this.store, desc);
	}

	/**
	 * Wait until the reactor has settled — i.e. an AGENT_TURN_COMPLETED fires AND
	 * no further USER_MESSAGE has been appended in the same tick (e.g. by follow-up draining).
	 */
	private _waitUntilSettled(threadId?: () => string | undefined): Promise<void> {
		return new Promise<void>((resolve) => {
			this._resolveSettled = resolve;
			let pendingCheck = false;
			const unsub = this.store.subscribe(
				() => {
					if (pendingCheck) return;
					pendingCheck = true;
					queueMicrotask(() => {
						pendingCheck = false;
						const followUpsRemaining = this.reactor?.pendingFollowUpCount ?? 0;
						if (followUpsRemaining > 0) return;
						const retriesRemaining = this.reactor?.pendingRetryCount ?? 0;
						if (retriesRemaining > 0) return;
						// A compaction triggered by the completed turn may still be running —
						// the runtime is not idle until it finishes (it may deliver follow-ups
						// queued while it ran).
						if (this.reactor?.isCompacting) return;
						// Scope to this prompt's thread so concurrent threads on the same
						// store cannot stall (or prematurely settle) this wait.
						const thread = threadId?.();
						const lastMsg = this.store.query({ types: ["USER_MESSAGE"], thread_id: thread, reverse: true, limit: 1 })[0];
						const lastCompleted = this.store.query({
							types: ["AGENT_TURN_COMPLETED"],
							thread_id: thread,
							reverse: true,
							limit: 1,
						})[0];
						if (lastMsg && lastCompleted && lastMsg.sequence > lastCompleted.sequence) return;
						unsub();
						resolve();
					});
				},
				// COMPACTION_END/ABORTED re-run the check so we don't hang when compaction
				// outlives the last AGENT_TURN_COMPLETED.
				{ types: ["AGENT_TURN_COMPLETED", "COMPACTION_END", "COMPACTION_ABORTED"] },
			);
			this._turnSubscription = unsub;
		});
	}

	/**
	 * Approve a pending intent.
	 */
	approve(intentEventId: string): void {
		this.store.append({
			actor_id: "user",
			type: "USER_APPROVAL",
			payload: { intent_event_id: intentEventId },
		});
	}

	/**
	 * Reject a pending intent.
	 */
	reject(intentEventId: string): void {
		this.store.append({
			actor_id: "user",
			type: "USER_REJECTION",
			payload: { intent_event_id: intentEventId },
		});
	}

	/**
	 * Subscribe to real-time events (for UI).
	 */
	subscribe(handler: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		return this.store.subscribe(handler, options);
	}

	/**
	 * Query the activity timeline (for UI rendering).
	 */
	getTimeline(options?: TimelineQueryOptions) {
		const projection = new TimelineProjection(this.store);
		return projection.query(options);
	}

	/**
	 * Fork session at a specific event.
	 */
	fork(eventId: string): SessionDescriptor {
		const desc = this.sessionManager?.forkAt(eventId) as any;
		this.refreshSystemPromptForCurrentSession();
		return desc;
	}

	/**
	 * Switch to a different session.
	 */
	switchSession(sessionId: string): void {
		this.sessionManager?.switchTo(sessionId);
		this.refreshSystemPromptForCurrentSession();
	}

	/**
	 * Create a new session.
	 */
	createSession(name?: string): SessionDescriptor {
		const desc = this.sessionManager?.createSession("user_explicit", name) as any;
		this.refreshSystemPromptForCurrentSession();
		return desc;
	}

	/**
	 * Rebuild prompt fragments that depend on the active session. This keeps
	 * session breadcrumbs fresh even when the UI changes sessions between turns.
	 */
	refreshSystemPromptForCurrentSession(): string {
		if (!this.config.refreshSystemPrompt) return this.config.systemPrompt;
		this.config.systemPrompt = this.config.refreshSystemPrompt();
		return this.config.systemPrompt;
	}

	/**
	 * Get current session descriptor.
	 */
	getCurrentSession(): SessionDescriptor | undefined {
		const sessionId = this.sessionManager?.getActiveSessionId();
		return sessionId ? this.sessionManager?.getSession(sessionId) : undefined;
	}

	async createCheckpoint(label?: string): Promise<CheckpointRef> {
		const checkpoint = await this.runtimeAdapter.createCheckpoint({
			cwd: this.config.cwd,
			event_head: this.store.head,
			event_head_sequence: this.store.head_sequence,
			label,
		});
		this.store.append({
			actor_id: "runtime",
			type: "CHECKPOINT_CREATED",
			payload: checkpoint,
			caused_by: this.store.head,
		});
		return checkpoint;
	}

	async restoreCheckpoint(checkpoint: CheckpointRef): Promise<void> {
		try {
			await this.runtimeAdapter.restoreCheckpoint(checkpoint);
			this.store.append({
				actor_id: "runtime",
				type: "CHECKPOINT_RESTORED",
				payload: checkpoint,
				caused_by: checkpoint.event_head,
			});
		} catch (error) {
			this.store.append({
				actor_id: "runtime",
				type: "CHECKPOINT_FAILED",
				payload: {
					checkpoint,
					error_message: error instanceof Error ? error.message : String(error),
				},
				caused_by: checkpoint.event_head,
			});
			throw error;
		}
	}

	async getRuntimeStatus(): Promise<RuntimeStatus> {
		return this.runtimeAdapter.getStatus();
	}

	/**
	 * Dispose the runtime.
	 */
	dispose(): void {
		// Cancel an in-flight idle compaction before the store goes away. Its
		// remaining appends then fail closed inside _runIdleCompaction (which
		// never rejects), so nothing escapes as an unhandled rejection here.
		this._idleCompactionAbort?.abort();
		this.sessionManager?.dispose();
		if (this.ownsStore) {
			(this.rawStore as { close?: () => void }).close?.();
		}
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an EventSourcedRuntime from existing components.
 */
/**
 * Create an EventSourcedRuntime from existing components.
 *
 * Note: This factory bypasses the constructor to allow injection of
 * pre-configured EventStore and SessionManager instances.
 */
export function createEventSourcedRuntime(
	store: EventStore,
	sessionManager: SessionManager,
	config: Omit<EventSourcedRuntimeConfig, "cwd" | "storagePath">,
): EventSourcedRuntime {
	return new EventSourcedRuntime({
		cwd: store.workspace_id, // workspace_id is used as cwd proxy
		store,
		sessionManager,
		toolRegistry: config.toolRegistry,
		classifierConfig: config.classifierConfig,
		runtimeAdapter: config.runtimeAdapter,
		approvalHandler: config.approvalHandler,
		llmClient: config.llmClient,
		systemPrompt: config.systemPrompt,
		model: config.model,
		tools: config.tools,
		contextBudget: config.contextBudget,
		retryPolicy: config.retryPolicy,
		compactionPolicy: config.compactionPolicy,
		compactionEngineSettings: config.compactionEngineSettings,
		refreshSystemPrompt: config.refreshSystemPrompt,
	});
}
