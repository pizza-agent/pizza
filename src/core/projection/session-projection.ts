/**
 * Session Projection
 *
 * Session is a query view over EventStore, not a data holder.
 * Builds LLM context from event queries.
 */

import type { AgentMessage } from "../agent/types.js";
import type { EventBase, EventType } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";
import type { SessionDescriptor, SessionSourceRef, BuildContextOptions, BuiltContext } from "./types.js";
import type { TimelineEntry, TimelineEntryKind } from "./timeline-projection.js";
import { eventsToMessages } from "./event-to-message.js";
import { sanitizeToolPairing } from "./context-sanitizer.js";
import { DEFAULT_MASK_MIN_CHARS, isMaskCompaction, maskToolResultEvents } from "../compaction/tool-result-masking.js";
import { estimateTokens } from "../compaction/compaction.js";

// ============================================================================
// Constants
// ============================================================================

/** Event types that participate in LLM context */
const CONTEXT_RELEVANT_EVENT_TYPES: EventType[] = [
	"USER_MESSAGE",
	"AGENT_MESSAGE_END",
	"TOOL_EXECUTION_END",
	"COMPACTION_END",
	"FILE_MUTATION_APPLIED",
	"BASH_EXECUTION",
	"CUSTOM_MESSAGE",
	"BRANCH_SUMMARY",
];

// ============================================================================
// Session Projection
// ============================================================================

/**
 * SessionProjection builds LLM context from EventStore queries.
 *
 * Session is a projection/view over events, not a data holder.
 * Multiple sessions can coexist - same events can belong to multiple session views.
 */
/**
 * Resolve a cross-workspace fork source into a built context (zero-copy fork).
 * Injected by SessionManager — the projection itself never opens foreign
 * stores. Returns undefined when the source cannot be resolved (workspace
 * deleted, session missing): context then degrades to the session's own range.
 */
export type ResolveSourceContext = (ref: SessionSourceRef) => BuiltContext | undefined;

export class SessionProjection {
	/** Session this projection reads — SessionManager uses it to key its
	 * projection cache (a new descriptor ⇒ stale projection). */
	readonly descriptor: SessionDescriptor;

	/**
	 * buildContext() re-scans the whole session event range and re-parses every
	 * payload — for a long session that is MBs of work, repeated per footer
	 * render, per get_state, and per turn. Events are append-only, so the built
	 * result is valid until the persisted store head changes or the descriptor is
	 * mutated. Cache the last result keyed on both.
	 */
	private _contextCache: { head: string | undefined; maxTokens: number | undefined; value: BuiltContext } | undefined;
	/** Frozen parent/source contexts are immutable; cache them per descriptor. */
	private _parentContextCache: { key: string; value: BuiltContext | undefined } | undefined;
	private _sourceContextCache: { key: string; value: BuiltContext | undefined } | undefined;

	constructor(
		private store: EventStore,
		descriptor: SessionDescriptor,
		private resolveSession?: (sessionId: string) => SessionDescriptor | undefined,
		private resolveSourceContext?: ResolveSourceContext,
	) {
		this.descriptor = descriptor;
	}

	/**
	 * Build LLM-usable context message list.
	 *
	 * Logic:
	 * 1. Query all context-relevant events from event_range
	 * 2. If summary_event_id exists, inject compaction summary first
	 * 3. Convert events to AgentMessage[] format
	 * 4. Apply token budget truncation if needed
	 */
	buildContext(options?: BuildContextOptions): BuiltContext {
		// head is read from SQLite: the local sequence allocator does not advance
		// when another process writes to the same workspace.
		const cacheKey = this.store.head;
		if (this._contextCache && this._contextCache.head === cacheKey && this._contextCache.maxTokens === options?.max_tokens) {
			return this._contextCache.value;
		}
		// Zero-copy cross-workspace fork: prepend the SOURCE workspace's context
		// (read-only, via the injected resolver) instead of cloned events. The
		// source is frozen — cache the resolution (including failures) so a
		// missing source store isn't re-probed on every build.
		let sourceContext: BuiltContext | undefined;
		const srcRef = this.descriptor.source_ref;
		if (srcRef && this.resolveSourceContext) {
			const srcKey = `${srcRef.workspace_id}|${srcRef.session_id}`;
			sourceContext = this._sourceContextCache?.key === srcKey
				? this._sourceContextCache.value
				: (this._sourceContextCache = { key: srcKey, value: this.resolveSourceContext(srcRef) }).value;
		}

		const parentContext = this._buildContextParent(options);
		const { start, end } = this._getEventRange();
		const rawEvents = this.store.query({
			after: start,
			before: end,
			types: CONTEXT_RELEVANT_EVENT_TYPES,
		}).filter((e) => !e.thread_id || e.thread_id === this.descriptor.thread_id);
		const events = this._applyCompactionBoundary(rawEvents);

		// Repair tool_use ↔ tool_result pairing: interleaved turns (concurrent
		// reactors) and crash-truncated executions can leave toolResults that do
		// not directly follow their assistant tool_use message — strict providers
		// (Anthropic/Bedrock) reject the whole request for that. The sanitizer
		// repositions/drops/synthesizes so any log yields a well-formed context.
		let messages = sanitizeToolPairing([
			...(sourceContext?.messages ?? []),
			...(parentContext?.messages ?? []),
			...eventsToMessages(events),
		]);

		// Inject compaction summary if present
		if (this.descriptor.summary_event_id) {
			const summaryAlreadyInRange = events.some((event) => event.event_id === this.descriptor.summary_event_id);
			const summaryEvent = this.store.get(this.descriptor.summary_event_id);
			if (!summaryAlreadyInRange && summaryEvent && summaryEvent.type === "COMPACTION_END" && !isMaskCompaction(summaryEvent)) {
				const summaryPayload = summaryEvent.payload as {
					summary: string;
					tokens_before: number;
				};
				// Use compactionSummary message type
				messages.unshift({
					role: "compactionSummary",
					summary: summaryPayload.summary,
					tokensBefore: summaryPayload.tokens_before,
					timestamp: summaryEvent.timestamp,
				} as AgentMessage);
			}
		}

		// Apply token budget if specified
		if (options?.max_tokens) {
			messages = sanitizeToolPairing(this._truncateByTokens(messages, options.max_tokens));
		}

		const built: BuiltContext = {
			messages,
			events: [...(sourceContext?.events ?? []), ...(parentContext?.events ?? []), ...events],
			descriptor: this.descriptor,
			contextPrefixEventCount: (sourceContext?.events.length ?? 0) + (parentContext?.events.length ?? 0),
		};
		this._contextCache = { head: cacheKey, maxTokens: options?.max_tokens, value: built };
		return built;
	}

	/**
	 * Get timeline view for UI display.
	 *
	 * Returns all events in the session's event range, ordered by time.
	 */
	getTimeline(): TimelineEntry[] {
		const parent = this._getContextParentDescriptor();
		const parentTimeline = parent
			? new SessionProjection(this.store, parent, this.resolveSession).getTimeline()
			: [];
		const { start, end } = this._getEventRange();
		const events = this.store.query({
			after: start,
			before: end,
			reverse: false,
		}).filter((e) => !e.thread_id || e.thread_id === this.descriptor.thread_id);

		return [...parentTimeline, ...events.map((e) => ({
			event_id: e.event_id,
			kind: this._eventTypeToKind(e.type),
			actor_id: e.actor_id,
			timestamp: e.timestamp,
			summary: this._summarizeEvent(e),
			caused_by: e.caused_by,
			metadata: { event_type: e.type },
		}))];
	}

	/**
	 * Get the session descriptor.
	 */
	getDescriptor(): SessionDescriptor {
		return this.descriptor;
	}

	/**
	 * Update the session descriptor.
	 */
	updateDescriptor(updates: Partial<SessionDescriptor>): void {
		Object.assign(this.descriptor, updates);
		this._contextCache = undefined;
		this._parentContextCache = undefined;
		this._sourceContextCache = undefined;
	}

	/**
	 * Fork: create a new session VIEW starting at a specific event.
	 *
	 * This is a branch view, not a rewind: the forked range is
	 * [at_event_id → HEAD] (exclusive of the fork point), so events that
	 * came after at_event_id remain inside the view. Because the event log
	 * is immutable and a session range is one contiguous span, "drop
	 * everything after point E and continue from there" cannot be
	 * expressed — the descendants of E are unavoidable. If a true rewind
	 * is ever wanted, it needs a different mechanism (e.g. a summary
	 * boundary or an exclusion set), not a wider range.
	 */
	fork(at_event_id: string): SessionDescriptor {
		return {
			session_id: this._generateSessionId(),
			thread_id: this.descriptor.thread_id,
			workspace_id: this.store.workspace_id,
			event_range: {
				start_event_id: at_event_id,
				end_event_id: "HEAD",
			},
			created_by: "fork",
			parent_session_id: this.descriptor.session_id,
			created_at: Date.now(),
		};
	}

	/**
	 * Get effective start event_id (ORIGIN if not set).
	 */
	getEffectiveStart(): string {
		return this.descriptor.event_range.start_event_id;
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private _getEventRange(): { start: string | undefined; end: string | undefined } {
		const start = this.descriptor.event_range.start_event_id === "ORIGIN" ? undefined : this.descriptor.event_range.start_event_id;
		const end = this.descriptor.event_range.end_event_id === "HEAD" ? undefined : this.descriptor.event_range.end_event_id;
		return { start, end };
	}

	private _getContextParentDescriptor(): SessionDescriptor | undefined {
		const parentId = this.descriptor.context_parent_session_id;
		if (!parentId || !this.resolveSession) return undefined;
		if (parentId === this.descriptor.session_id) return undefined;
		return this.resolveSession(parentId);
	}

	private _buildContextParent(options?: BuildContextOptions): BuiltContext | undefined {
		const parent = this._getContextParentDescriptor();
		if (!parent) return undefined;
		// The parent session is closed by definition — its event range is
		// frozen, so its built context is immutable until the descriptor
		// changes. Cache on the invariants instead of re-scanning the parent
		// range on every context rebuild.
		const key = `${parent.session_id}|${parent.event_range.start_event_id}|${parent.event_range.end_event_id}|${parent.summary_event_id ?? ""}`;
		if (this._parentContextCache?.key === key) return this._parentContextCache.value;
		const value = new SessionProjection(this.store, parent, this.resolveSession, this.resolveSourceContext).buildContext({
			...options,
			max_tokens: undefined,
		});
		this._parentContextCache = { key, value };
		return value;
	}

	private _applyCompactionBoundary(events: EventBase[]): EventBase[] {
		let latestCompaction: EventBase | undefined;
		let maskBeforeSequence = -1;
		let maskMinChars = DEFAULT_MASK_MIN_CHARS;
		for (const event of events) {
			if (event.type !== "COMPACTION_END") continue;
			if (!isMaskCompaction(event)) {
				latestCompaction = event;
				continue;
			}
			// Masking is monotonic: furthest boundary + smallest min-chars, so a later
			// mask never un-masks results an earlier one cleared.
			const payload = event.payload as { mask_before_event_id?: string; mask_min_chars?: number };
			const boundary = payload.mask_before_event_id ? this.store.get(payload.mask_before_event_id) : undefined;
			if (!boundary) continue;
			const minChars = payload.mask_min_chars ?? DEFAULT_MASK_MIN_CHARS;
			maskMinChars = maskBeforeSequence < 0 ? minChars : Math.min(maskMinChars, minChars);
			maskBeforeSequence = Math.max(maskBeforeSequence, boundary.sequence);
		}

		let result = events.filter((event) => event.type !== "COMPACTION_END");
		if (latestCompaction) {
			const payload = latestCompaction.payload as { first_kept_event_id?: string };
			const firstKept = payload.first_kept_event_id ? this.store.get(payload.first_kept_event_id) : undefined;
			const firstKeptSequence = firstKept?.sequence ?? latestCompaction.sequence + 1;
			result = [latestCompaction, ...result.filter((event) => event.sequence >= firstKeptSequence)];
		}
		return maskBeforeSequence >= 0 ? maskToolResultEvents(result, maskBeforeSequence, maskMinChars) : result;
	}

	private _summarizeEvent(event: EventBase): string {
		switch (event.type) {
			case "USER_MESSAGE": {
				const payload = event.payload as { content: string | unknown[] };
				const content = typeof payload.content === "string" ? payload.content : "[Content]";
				return `${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`;
			}

			case "AGENT_MESSAGE_END": {
				const payload = event.payload as {
					stop_reason: string;
					content?: Array<{ type: string; text?: string }>;
				};
				const text = payload.content?.find((b) => b.type === "text")?.text ?? "";
				const cleaned = text.replace(/[\n\t]/g, " ").trim();
				if (cleaned) return `${cleaned.slice(0, 80)}${cleaned.length > 80 ? "..." : ""}`;
				return `(agent ${payload.stop_reason})`;
			}

			case "TOOL_EXECUTION_END": {
				const payload = event.payload as { tool_name: string; is_error: boolean };
				return `${payload.is_error ? "❌" : "✓"} ${payload.tool_name}`;
			}

			case "COMPACTION_END":
				return "📋 Compaction summary applied";

			case "SESSION_CREATED": {
				const payload = event.payload as { name?: string; created_by: string };
				return `Session created: ${payload.name ?? payload.created_by}`;
			}

			case "SESSION_FORKED": {
				const payload = event.payload as { new_session_id: string };
				return `Forked to new session`;
			}

			case "BASH_EXECUTION": {
				const payload = event.payload as { command?: string; exit_code?: number; cancelled?: boolean };
				const cmd = (payload.command ?? "").replace(/[\n\t]/g, " ").slice(0, 80);
				return `[bash]${payload.cancelled ? " (cancelled)" : ""} ${cmd}`;
			}

			case "USER_INTERRUPT":
				return "User interrupted";
			case "USER_APPROVAL":
				return "User approved";
			case "USER_REJECTION":
				return "User rejected";
			case "USER_FOLLOWUP_QUEUED": {
				const payload = event.payload as { content?: string };
				return `Queued follow-up: ${(payload.content ?? "").slice(0, 60)}`;
			}
			case "USER_CONFIG_CHANGE":
				return "User changed configuration";
			case "MODEL_CHANGED": {
				const payload = event.payload as { model_id?: string; provider?: string };
				return `Model changed${payload.model_id ? `: ${payload.model_id}` : ""}`;
			}
			case "THINKING_LEVEL_CHANGED": {
				const payload = event.payload as { level?: string };
				return `Thinking level: ${payload.level ?? "?"}`;
			}
			case "CUSTOM_MESSAGE": {
				const payload = event.payload as { custom_type?: string; content?: string };
				return `[${payload.custom_type ?? "custom"}] ${(payload.content ?? "").slice(0, 60)}`;
			}
			case "BRANCH_SUMMARY": {
				const payload = event.payload as { summary?: string };
				return `Branch summary: ${(payload.summary ?? "").slice(0, 60)}`;
			}
			case "AGENT_TURN_START":
			case "AGENT_TURN_END":
			case "AGENT_TURN_REQUESTED":
			case "AGENT_TURN_COMPLETED":
				return `Agent ${event.type.replace("AGENT_TURN_", "").toLowerCase()}`;
			case "RUNTIME_STARTED":
				return "Runtime started";
			case "RUNTIME_PAUSED":
				return "Runtime paused";
			case "RUNTIME_RESUMED":
				return "Runtime resumed";
			case "TOOL_EXECUTION_START": {
				const payload = event.payload as { tool_name?: string };
				return `Tool started: ${payload.tool_name ?? "?"}`;
			}
			case "INTENT_TOOL_CALL": {
				const payload = event.payload as { tool_name?: string; name?: string };
				return `Tool call: ${payload.tool_name ?? payload.name ?? "?"}`;
			}
			case "AGENT_ERROR":
			case "RUNTIME_ERROR": {
				const payload = event.payload as { error_message?: string; error?: string };
				return `Error: ${(payload.error_message ?? payload.error ?? "unknown").slice(0, 80)}`;
			}
			case "SESSION_JUMPED":
				return "Session jumped (navigated)";
			case "SESSION_RENAMED": {
				const payload = event.payload as { name?: string };
				return `Session renamed${payload.name ? `: ${payload.name}` : ""}`;
			}
			case "CHECKPOINT_CREATED": {
				const payload = event.payload as { label?: string };
				return `Checkpoint${payload.label ? `: ${payload.label}` : ""}`;
			}
			case "COMPACTION_START":
				return "Context compaction started";
			case "COMPACTION_ABORTED":
				return "Context compaction aborted";

			default:
				return event.type.replace(/_/g, " ").toLowerCase();
		}
	}

	private _truncateByTokens(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
		// Keep system-equivalent messages (summaries) plus the most recent
		// messages that fit the token budget — measured with the shared
		// CJK-aware per-message estimator rather than a flat per-message
		// guess, which used to silently keep ~10x too much context.
		const systemMessages: AgentMessage[] = [];
		const otherMessages: AgentMessage[] = [];
		for (const m of messages) {
			if (m.role === "compactionSummary" || m.role === "branchSummary") {
				systemMessages.push(m);
			} else {
				otherMessages.push(m);
			}
		}

		// Walk back from the tail until the budget is exhausted. The last
		// message is always kept so the context never becomes empty.
		const kept: AgentMessage[] = [];
		let budget = maxTokens;
		for (let i = otherMessages.length - 1; i >= 0; i--) {
			const cost = estimateTokens(otherMessages[i]!);
			if (budget - cost < 0 && kept.length > 0) break;
			budget -= cost;
			kept.push(otherMessages[i]!);
		}
		kept.reverse();
		return [...systemMessages, ...kept];
	}

	private _eventTypeToKind(type: EventType): TimelineEntryKind {
		switch (type) {
			case "USER_MESSAGE":
				return "user_message";
			case "AGENT_MESSAGE_END":
				return "agent_message";
			case "AGENT_MESSAGE_START":
			case "AGENT_MESSAGE_CHUNK":
				// Message scaffolding (stream lifecycle), not user-visible content.
				return "other";
			case "TOOL_EXECUTION_START":
			case "TOOL_EXECUTION_UPDATE":
			case "TOOL_EXECUTION_END":
				return "tool_execution";
			case "FILE_MUTATION_APPLIED":
				return "file_mutation";
			case "GOAL_CREATED":
			case "GOAL_CLASSIFIED":
			case "GOAL_PLANNED":
			case "GOAL_PAUSED":
			case "GOAL_RESUMED":
			case "GOAL_COMPLETED":
			case "GOAL_CANCELLED":
				return "goal_event";
			case "TASK_CREATED":
			case "TASK_ASSIGNED":
			case "TASK_STARTED":
			case "TASK_PROGRESS":
			case "TASK_COMPLETED":
			case "TASK_FAILED":
			case "TASK_REWORK_REQUESTED":
			case "TASK_ACCEPTED":
			case "TASK_CANCELLED":
				return "task_event";
			case "SESSION_CREATED":
			case "SESSION_BOUNDARY_INFERRED":
			case "SESSION_FORKED":
				return "session_boundary";
			case "COMPACTION_REQUESTED":
			case "COMPACTION_START":
			case "COMPACTION_END":
			case "COMPACTION_ABORTED":
				return "compaction";
			case "AGENT_ERROR":
			case "RUNTIME_ERROR":
				return "error";
			case "CHECKPOINT_CREATED":
			case "CHECKPOINT_RESTORED":
			case "CHECKPOINT_FAILED":
				return "checkpoint";
			case "BASH_EXECUTION":
				return "bash_command";
			case "USER_APPROVAL":
			case "USER_REJECTION":
			case "USER_INTERRUPT":
			case "USER_FOLLOWUP_QUEUED":
			case "USER_FOLLOWUP_DROPPED":
				return "user_action";
			case "USER_CONFIG_CHANGE":
				return "runtime";
			case "RUNTIME_STARTED":
			case "RUNTIME_PAUSED":
			case "RUNTIME_RESUMED":
			case "MODEL_CHANGED":
			case "THINKING_LEVEL_CHANGED":
			case "SESSION_JUMPED":
			case "SESSION_RENAMED":
			case "THREAD_STATUS_CHANGED":
			case "CUSTOM_MESSAGE":
			case "BRANCH_SUMMARY":
			case "COMMAND_EXECUTED":
			case "SESSION_ENTRY_APPENDED":
				return "runtime";
			default:
				return "other";
		}
	}

	private _generateSessionId(): string {
		// Use UUIDv7-like format
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `sess_${timestamp}_${random}`;
	}
}
