/**
 * Event-backed session context for extensions.
 *
 * This keeps the read-only shape extensions already use while sourcing data
 * from EventStore and SessionProjection instead of the legacy JSONL manager.
 */

import type { AgentMessage } from "../agent/types.js";
import type { EventBase } from "../event-store/types.js";
import type { EventStore, SubscribeOptions } from "../event-store/store.js";
import { eventToMessage } from "../projection/event-to-message.js";
import type { BuildContextOptions, BuiltContext, SessionDescriptor } from "../projection/types.js";
import { buildHistoryTreeNodes, type HistoryTreeNodeInfo } from "../projection/history-tree.js";
import type { SessionProjection } from "../projection/session-projection.js";
import type { SessionManager as ProjectionSessionManager } from "../projection/session-manager.js";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomMessageEntry,
	ModelChangeEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionHeader,
	SessionInfoEntry,
	SessionMessageEntry,
	SessionTreeNode,
	ThinkingLevelChangeEntry,
} from "../types/session-types.js";

/** Preview of a history session's context (for history_tree view). */
export interface HistorySessionView {
	descriptor: SessionDescriptor;
	/** Formatted one-line previews of the most recent messages. */
	messages: string[];
	/** Total message count in the session context. */
	message_count: number;
}

/** History tree operations exposed to the history_tree tool. */
export interface HistoryTreeAccess {
	/** Flattened history tree (depth-first, one node per session). */
	list(): HistoryTreeNodeInfo[];
	/** Preview a session's context without switching to it. */
	view(sessionId: string, options?: { maxMessages?: number }): HistorySessionView | undefined;
	/** Jump to a session; closed sessions are reopened via fork. */
	jump(sessionId: string, reason?: string): { session_id: string; reopened: boolean };
	/** Fork a new branch from a session. */
	fork(sessionId: string): { session_id: string };
}

export interface ExtensionSessionManager extends ReadonlySessionManager {
	/** Present when the session view is backed by EventStore. */
	readonly eventStore?: EventStore;
	/** Present when the session view is backed by a SessionProjection. */
	readonly projection?: SessionProjection;
	buildContext?: (options?: BuildContextOptions) => BuiltContext;
	subscribe?: (listener: (event: EventBase) => void, options?: SubscribeOptions) => () => void;
	/** Split the current session, starting a new one from the current position. */
	splitSession?: (reason?: string, name?: string) => { session_id: string; already_split?: boolean } | undefined;
	/** History tree operations (list/view/jump/fork over past sessions). */
	readonly historyTree?: HistoryTreeAccess;
}

export interface EventStoreExtensionSessionManagerOptions {
	store: EventStore;
	projection: SessionProjection;
	cwd: string;
	sessionDir?: string;
	sessionFile?: string;
	/** The projection SessionManager for mutation operations (e.g. splitSession). */
	sessionManager?: ProjectionSessionManager;
}

export class EventStoreExtensionSessionManager implements ExtensionSessionManager {
	readonly eventStore: EventStore;
	readonly projection: SessionProjection;
	private cwd: string;
	private sessionDir: string;
	private sessionFile: string;
	private sessionManager: ProjectionSessionManager | undefined;

	constructor(options: EventStoreExtensionSessionManagerOptions) {
		this.eventStore = options.store;
		this.projection = options.projection;
		this.cwd = options.cwd;
		this.sessionManager = options.sessionManager;
		const descriptor = options.projection.getDescriptor();
		this.sessionDir = options.sessionDir ?? options.cwd;
		this.sessionFile = options.sessionFile ?? `event-session:${descriptor.session_id}`;
	}

	splitSession(reason?: string, name?: string): { session_id: string; already_split?: boolean } | undefined {
		if (!this.sessionManager) return undefined;

		// Guard against redundant splits. If the most recent boundary event
		// came after the most recent USER_MESSAGE, the session was just split
		// (e.g. by a previous split within the same turn). Splitting again
		// would only produce empty sessions and can cause the model to loop.
		const recentUserMessages = this.eventStore.query({
			reverse: true,
			types: ["USER_MESSAGE"],
		});
		const recentBoundaries = this.eventStore.query({
			reverse: true,
			types: ["SESSION_BOUNDARY_INFERRED"],
		});
		const lastUserMsgSeq = recentUserMessages[0]?.sequence;
		const lastBoundarySeq = recentBoundaries[0]?.sequence;
		if (lastBoundarySeq !== undefined && lastUserMsgSeq !== undefined && lastBoundarySeq > lastUserMsgSeq) {
			const activeId = this.sessionManager.getActiveSessionId();
			return { session_id: activeId!, already_split: true };
		}

		// Find the most recent USER_MESSAGE — the new session should start from
		// there so the model retains the current user request in context.
		// query({ after }) is exclusive (sequence > ?), so we need the event
		// immediately BEFORE the USER_MESSAGE as startEventId.
		const userMessageId = recentUserMessages[0]?.event_id;
		let startEventId: string | undefined;
		if (userMessageId) {
			const beforeUserMessage = this.eventStore.query({
				before: userMessageId,
				reverse: true,
				limit: 1,
			});
			// If there's an event before USER_MESSAGE, use it as the exclusive
			// start boundary. If USER_MESSAGE is the first event, use "ORIGIN"
			// so the query includes everything from the beginning.
			startEventId = beforeUserMessage[0]?.event_id ?? "ORIGIN";
		}

		const desc = this.sessionManager.createSession("user_explicit", name, {
			startEventId,
			parentSessionId: this.sessionManager.getActiveSessionId(),
		});
		this.eventStore.append({
			actor_id: "runtime",
			type: "SESSION_BOUNDARY_INFERRED",
			payload: {
				reason: reason ?? "intent_shift",
				new_session_id: desc.session_id,
			},
			thread_id: desc.thread_id,
		});
		return { session_id: desc.session_id };
	}

	get historyTree(): HistoryTreeAccess | undefined {
		const manager = this.sessionManager;
		if (!manager) return undefined;
		const store = this.eventStore;
		return {
			list: () => buildHistoryTreeNodes(manager.listSessions(), manager.getActiveSessionId(), store),
			view: (sessionId, options) => {
				const projection = manager.getSessionProjection(sessionId);
				if (!projection) return undefined;
				const context = projection.buildContext();
				const previews = context.messages
					.map((message) => formatMessagePreview(message))
					.filter((line): line is string => line !== undefined);
				const maxMessages = options?.maxMessages ?? 20;
				return {
					descriptor: projection.getDescriptor(),
					messages: previews.slice(-maxMessages),
					message_count: previews.length,
				};
			},
			jump: (sessionId, reason) => {
				const result = manager.jumpToSession(sessionId, reason);
				return { session_id: result.descriptor.session_id, reopened: result.reopened };
			},
			fork: (sessionId) => {
				const desc = manager.forkFromSession(sessionId, { preserveHistory: false });
				return { session_id: desc.session_id };
			},
		};
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.projection.getDescriptor().session_id;
	}

	getSessionFile(): string {
		return this.sessionFile;
	}

	getLeafId(): string {
		return this.getLeafEntry()?.id ?? this.projection.getDescriptor().event_range.start_event_id;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.getEntries().at(-1);
	}

	getEntry(entryId: string): SessionEntry | undefined {
		return this.getEntries().find((entry) => entry.id === entryId);
	}

	getLabel(entryId: string): string | undefined {
		let label: string | undefined;
		for (const entry of this.getEntries()) {
			if (entry.type === "label" && entry.targetId === entryId) {
				label = entry.label;
			}
		}
		return label;
	}

	getBranch(): SessionEntry[] {
		return this.getEntries();
	}

	getHeader(): SessionHeader {
		const descriptor = this.projection.getDescriptor();
		return {
			type: "session",
			id: descriptor.session_id,
			timestamp: new Date(descriptor.created_at).toISOString(),
			cwd: this.cwd,
			parentSession: descriptor.parent_session_id,
		};
	}

	getEntries(): SessionEntry[] {
		return this.getSessionEvents()
			.map((event) => this.eventToEntry(event))
			.filter((entry): entry is SessionEntry => entry !== undefined);
	}

	getTree(): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of this.getEntries()) {
			const node: SessionTreeNode = { entry, children: [] };
			nodes.set(entry.id, node);

			if (entry.parentId && nodes.has(entry.parentId)) {
				nodes.get(entry.parentId)!.children.push(node);
			} else {
				roots.push(node);
			}
		}

		return roots;
	}

	getSessionName(): string | undefined {
		let name = this.projection.getDescriptor().name;
		for (const entry of this.getEntries()) {
			if (entry.type === "session_info") {
				name = entry.name;
			}
		}
		return name;
	}

	buildContext(options?: BuildContextOptions): BuiltContext {
		return this.projection.buildContext(options);
	}

	subscribe(listener: (event: EventBase) => void, options?: SubscribeOptions): () => void {
		return this.eventStore.subscribe(listener, options);
	}

	private getSessionEvents(): EventBase[] {
		const descriptor = this.projection.getDescriptor();
		return this.eventStore.query({
			after: descriptor.event_range.start_event_id === "ORIGIN" ? undefined : descriptor.event_range.start_event_id,
			before: descriptor.event_range.end_event_id === "HEAD" ? undefined : descriptor.event_range.end_event_id,
			reverse: false,
		});
	}

	private eventToEntry(event: EventBase): SessionEntry | undefined {
		if (event.type === "SESSION_ENTRY_APPENDED") {
			const payload = event.payload as { entry?: unknown };
			if (this.isSessionEntry(payload.entry)) return payload.entry;
		}

		if (event.type === "MODEL_CHANGED") {
			const payload = event.payload as { provider: string; model_id: string };
			const entry: ModelChangeEntry = {
				...this.baseEntry(event),
				type: "model_change",
				provider: payload.provider,
				modelId: payload.model_id,
			};
			return entry;
		}

		if (event.type === "THINKING_LEVEL_CHANGED") {
			const payload = event.payload as { level: string };
			const entry: ThinkingLevelChangeEntry = {
				...this.baseEntry(event),
				type: "thinking_level_change",
				thinkingLevel: payload.level,
			};
			return entry;
		}

		// Mask-mode compactions drop nothing and carry no summary — not a legacy CompactionEntry.
		if (event.type === "COMPACTION_END" && (event.payload as { mode?: string }).mode === "mask") {
			return undefined;
		}

		if (event.type === "COMPACTION_END") {
			const payload = event.payload as { summary: string; first_kept_event_id: string; tokens_before: number };
			const entry: CompactionEntry = {
				...this.baseEntry(event),
				type: "compaction",
				summary: payload.summary,
				firstKeptEntryId: payload.first_kept_event_id,
				tokensBefore: payload.tokens_before,
			};
			return entry;
		}

		if (event.type === "BRANCH_SUMMARY") {
			const payload = event.payload as { summary: string; from_id?: string };
			const entry: BranchSummaryEntry = {
				...this.baseEntry(event),
				type: "branch_summary",
				fromId: payload.from_id ?? event.caused_by ?? event.event_id,
				summary: payload.summary,
			};
			return entry;
		}

		if (event.type === "CUSTOM_MESSAGE") {
			const payload = event.payload as {
				kind: string;
				data: unknown;
				display?: boolean | string;
			};
			const entry: CustomMessageEntry = {
				...this.baseEntry(event),
				type: "custom_message",
				customType: payload.kind,
				content: typeof payload.data === "string" ? payload.data : JSON.stringify(payload.data),
				details: payload.data,
				display: payload.display !== false,
			};
			return entry;
		}

		const message = eventToMessage(event);
		if (!message) return undefined;
		return this.messageToEntry(event, message);
	}

	private messageToEntry(event: EventBase, message: AgentMessage): SessionEntry | undefined {
		if (message.role === "compactionSummary") {
			const entry: CompactionEntry = {
				...this.baseEntry(event),
				type: "compaction",
				summary: message.summary,
				firstKeptEntryId: event.event_id,
				tokensBefore: message.tokensBefore,
			};
			return entry;
		}

		if (message.role === "branchSummary") {
			const entry: BranchSummaryEntry = {
				...this.baseEntry(event),
				type: "branch_summary",
				fromId: message.fromId ?? event.caused_by ?? event.event_id,
				summary: message.summary,
			};
			return entry;
		}

		if (message.role === "custom") {
			const entry: CustomMessageEntry = {
				...this.baseEntry(event),
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				details: message.details,
				display: message.display !== false,
			};
			return entry;
		}

		const entry: SessionMessageEntry = {
			...this.baseEntry(event),
			type: "message",
			message,
		};
		return entry;
	}

	private baseEntry(event: EventBase) {
		return {
			id: event.event_id,
			parentId: event.caused_by ?? null,
			timestamp: new Date(event.timestamp).toISOString(),
		};
	}

	private isSessionEntry(value: unknown): value is SessionEntry {
		return (
			typeof value === "object" &&
			value !== null &&
			"type" in value &&
			"id" in value &&
			"parentId" in value &&
			"timestamp" in value
		);
	}
}

/** Format an AgentMessage as a compact one-line preview for history_tree view. */
function formatMessagePreview(message: AgentMessage): string | undefined {
	const m = message as {
		role?: string;
		content?: string | Array<{ type?: string; text?: string }>;
		summary?: string;
	};
	if (m.role === "compactionSummary" || m.role === "branchSummary") {
		const summary = (m.summary ?? "").replace(/\s+/g, " ").trim();
		return `[${m.role}] ${truncatePreview(summary, 200)}`;
	}
	if (!m.role || m.content === undefined) return undefined;
	const text =
		typeof m.content === "string"
			? m.content
			: m.content
					.map((block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
					.join(" ");
	const trimmed = text.replace(/\s+/g, " ").trim();
	if (!trimmed) return undefined;
	return `${m.role}: ${truncatePreview(trimmed, 200)}`;
}

function truncatePreview(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
