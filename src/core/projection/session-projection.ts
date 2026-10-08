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
	constructor(
		private store: EventStore,
		private descriptor: SessionDescriptor,
		private resolveSession?: (sessionId: string) => SessionDescriptor | undefined,
		private resolveSourceContext?: ResolveSourceContext,
	) {}

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
		// Zero-copy cross-workspace fork: prepend the SOURCE workspace's context
		// (read-only, via the injected resolver) instead of cloned events.
		const sourceContext =
			this.descriptor.source_ref && this.resolveSourceContext
				? this.resolveSourceContext(this.descriptor.source_ref)
				: undefined;
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

		return {
			messages,
			events: [...(sourceContext?.events ?? []), ...(parentContext?.events ?? []), ...events],
			descriptor: this.descriptor,
		};
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
	}

	/**
	 * Fork: create new session descriptor from a specific event.
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
		return new SessionProjection(this.store, parent, this.resolveSession, this.resolveSourceContext).buildContext({
			...options,
			max_tokens: undefined,
		});
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
				return `User: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`;
			}

			case "AGENT_MESSAGE_END": {
				const payload = event.payload as { stop_reason: string };
				return `Agent (stop: ${payload.stop_reason})`;
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

			default:
				return event.type;
		}
	}

	private _truncateByTokens(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
		// Simple truncation: keep recent messages up to token limit
		// In production, use proper token counting
		const estimatedTokensPerMessage = 100; // rough estimate
		const maxMessages = Math.floor(maxTokens / estimatedTokensPerMessage);

		if (messages.length <= maxMessages) {
			return messages;
		}

		// Keep system-equivalent messages + most recent messages
		const systemMessages = messages.filter(
			(m) => m.role === "compactionSummary" || m.role === "branchSummary",
		);
		const otherMessages = messages.filter(
			(m) => m.role !== "compactionSummary" && m.role !== "branchSummary",
		);

		const recentMessages = otherMessages.slice(-maxMessages);
		return [...systemMessages, ...recentMessages];
	}

	private _eventTypeToKind(type: EventType): TimelineEntryKind {
		switch (type) {
			case "USER_MESSAGE":
				return "user_message";
			case "AGENT_MESSAGE_START":
			case "AGENT_MESSAGE_CHUNK":
			case "AGENT_MESSAGE_END":
				return "agent_message";
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
			default:
				return "agent_message";
		}
	}

	private _generateSessionId(): string {
		// Use UUIDv7-like format
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 10);
		return `sess_${timestamp}_${random}`;
	}
}
