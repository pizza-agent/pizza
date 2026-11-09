/**
 * History Tree
 *
 * Organizes SessionDescriptors into a tree by parent_session_id.
 * Nodes are sessions; messages are rebuilt on demand from the EventStore
 * via each session's event_range.
 */

import { isMainGreetingMessage } from "../agent/main-agent.js";
import type { EventStore } from "../event-store/store.js";
import type { SessionDescriptor } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** Flattened history tree node for tool/UI consumption. */
export interface HistoryTreeNodeInfo {
	session_id: string;
	thread_id: string;
	name?: string;
	created_at: number;
	created_by: SessionDescriptor["created_by"];
	parent_session_id?: string;
	depth: number;
	child_count: number;
	is_active: boolean;
	/** Whether the session is closed (end_event_id !== "HEAD"). */
	closed: boolean;
	/** Whether an internal continuation is currently active for this node. */
	has_active_continuation?: boolean;
	/**
	 * Human-meaningful label for the session, always present when a store is
	 * provided: the user/agent-given `name`, else a title derived from the first
	 * user message. UIs should render this instead of the opaque session id.
	 */
	title?: string;
	/** Whether `title` was derived from content rather than an explicit name. */
	title_is_derived?: boolean;
	/** First user message in the session (truncated), for orientation/search. */
	snippet?: string;
	/** Number of user messages in the session (conversation size at a glance). */
	message_count?: number;
	/** Timestamp of the last event in the session (recency ordering in UIs). */
	last_activity_at?: number;
	/**
	 * Event id this branch was forked at (from the SESSION_FORKED event whose
	 * new_session_id matches this session). Present for forked sessions when a
	 * store is provided; lets UIs re-fork from the exact divergence point.
	 */
	fork_at_event_id?: string;
}

// ============================================================================
// Tree Building
// ============================================================================

/**
 * Build the history tree as a flattened, depth-annotated node list
 * (depth-first order, siblings sorted by created_at ascending).
 */
export function buildHistoryTreeNodes(
	sessions: SessionDescriptor[],
	activeSessionId: string | undefined,
	store?: EventStore,
	/**
	 * Restrict the tree to one thread. REQUIRED in multi-tenant (SDK threadId)
	 * deployments — without it the tree exposes every tenant's session titles
	 * and snippets. Omit only for single-user local use.
	 */
	threadId?: string,
): HistoryTreeNodeInfo[] {
	if (threadId) sessions = sessions.filter((s) => s.thread_id === threadId);
	const byId = new Map(sessions.map((s) => [s.session_id, s]));
	const activeSession = activeSessionId ? byId.get(activeSessionId) : undefined;
	const activeVisibleSessionId = activeSession?.context_parent_session_id ?? activeSessionId;
	const visibleSessions = sessions.filter((s) => !s.context_parent_session_id);
	const visibleIds = new Set(visibleSessions.map((s) => s.session_id));
	const children = new Map<string, SessionDescriptor[]>();
	const roots: SessionDescriptor[] = [];

	for (const session of visibleSessions) {
		const parentId = session.parent_session_id;
		if (parentId && visibleIds.has(parentId)) {
			const list = children.get(parentId) ?? [];
			list.push(session);
			children.set(parentId, list);
		} else {
			roots.push(session);
		}
	}

	const byCreatedAt = (a: SessionDescriptor, b: SessionDescriptor) => a.created_at - b.created_at;
	roots.sort(byCreatedAt);
	for (const list of children.values()) list.sort(byCreatedAt);

	// Map new_session_id -> fork_at_event_id from SESSION_FORKED events.
	const forkPoints = new Map<string, string>();
	if (store) {
		for (const event of store.query({ types: ["SESSION_FORKED"] })) {
			const payload = event.payload as { new_session_id?: string; fork_at_event_id?: string };
			if (payload.new_session_id && payload.fork_at_event_id) {
				forkPoints.set(payload.new_session_id, payload.fork_at_event_id);
			}
		}
	}

	const nodes: HistoryTreeNodeInfo[] = [];
	const visit = (session: SessionDescriptor, depth: number): void => {
		const childList = children.get(session.session_id) ?? [];
		const stats = store ? summarizeSession(store, session) : undefined;
		nodes.push({
			session_id: session.session_id,
			thread_id: session.thread_id,
			name: session.name,
			created_at: session.created_at,
			created_by: session.created_by,
			parent_session_id: session.parent_session_id,
			depth,
			child_count: childList.length,
			is_active: session.session_id === activeVisibleSessionId,
			closed: session.event_range.end_event_id !== "HEAD",
			has_active_continuation: activeSession?.context_parent_session_id === session.session_id,
			title: deriveTitle(session, stats?.snippet),
			title_is_derived: !session.name?.trim(),
			snippet: stats?.snippet,
			message_count: stats?.message_count,
			last_activity_at: stats?.last_activity_at,
			fork_at_event_id: forkPoints.get(session.session_id),
		});
		for (const child of childList) visit(child, depth + 1);
	};
	for (const root of roots) visit(root, 0);

	return nodes;
}

/** Render the history tree as a compact ASCII listing (one line per node). */
export function renderHistoryTreeText(nodes: HistoryTreeNodeInfo[]): string {
	if (nodes.length === 0) return "(no sessions)";
	const lines = nodes.map((node) => {
		const indent = "  ".repeat(node.depth);
		const marker = node.is_active ? "*" : "-";
		const status = node.is_active ? " [active]" : node.closed ? "" : " [open]";
		const date = new Date(node.created_at).toISOString().replace("T", " ").slice(0, 16);
		// Title first, session id second: the title is the split name, falling back
		// to a title derived from the first user message, so unnamed sessions stay
		// identifiable. The snippet is appended only when it adds information.
		const title = node.title ?? node.name;
		if (title) {
			const snippet = node.snippet && !node.snippet.startsWith(title.replace(/…$/, "")) ? ` — ${node.snippet}` : "";
			const count = node.message_count ? ` ${node.message_count}msg` : "";
			return `${indent}${marker} ${title} · ${node.session_id} (${date})${status}${count}${snippet}`;
		}
		return `${indent}${marker} ${node.session_id} (${date})${status}`;
	});
	return lines.join("\n");
}

// ============================================================================
// Breadcrumb (compact session-position line for system prompt)
// ============================================================================

/**
 * Build a compact one-line breadcrumb showing the active session's position
 * in the history tree. Intended for system prompt injection (~15-40 tokens).
 *
 * Returns empty string when there's no meaningful tree (single root session
 * with no children), so callers can skip appending it.
 *
 * Example output:
 *   Session position: you are in sess_04d9 (depth 2, branch: sess_01a3 → sess_03c1 → sess_04d9). Use `history_tree list` to see all branches.
 */
export function buildSessionBreadcrumb(
	sessions: SessionDescriptor[],
	activeSessionId: string | undefined,
): string {
	if (!activeSessionId || sessions.length === 0) return "";

	const byId = new Map(sessions.map((s) => [s.session_id, s]));
	const active = byId.get(activeSessionId);
	if (!active) return "";

	// Walk up the parent chain to build the branch path.
	const chain: string[] = [];
	let cur: SessionDescriptor | undefined = active;
	while (cur) {
		chain.unshift(cur.session_id);
		const parentId: string | undefined = cur.parent_session_id;
		cur = parentId ? byId.get(parentId) : undefined;
	}

	// Single root with no children → no breadcrumb needed.
	if (chain.length === 1) {
		const root = byId.get(activeSessionId);
		const hasChildren = sessions.some((s) => s.parent_session_id === activeSessionId);
		if (!hasChildren) return "";
	}

	const depth = chain.length - 1;
	const branch = chain.join(" → ");
	const depthLabel = depth === 0 ? "root" : `depth ${depth}`;
	return `Session position: you are in ${activeSessionId} (${depthLabel}, branch: ${branch}). Use \`_history_tree list\` to see all branches.`;
}

// ============================================================================
// Helpers
// ============================================================================

/** Aggregate stats used to label a session in tools/UIs. */
interface SessionStats {
	snippet?: string;
	message_count: number;
	last_activity_at?: number;
}

/**
 * Derive the display label for a session:
 * explicit name → short title cut from the first user message → undefined
 * (callers fall back to a shortened session id).
 */
function deriveTitle(session: SessionDescriptor, snippet?: string): string | undefined {
	const name = session.name?.trim();
	if (name) return name;
	return snippet ? titleFromText(snippet) : undefined;
}

/** Cut a compact title (<= 48 chars) out of a message body. */
function titleFromText(text: string): string | undefined {
	const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	// Prefer the first sentence/clause; fall back to a hard cut on word boundary.
	const firstClause = flat.split(/(?<=[.!?。！？])\s|[\n\r]|(?<=[，,;；])\s?/)[0]?.trim() || flat;
	const candidate = (firstClause.length >= 8 ? firstClause : flat).replace(/[\s,，.。;；:：!！?？]+$/, "");
	if (candidate.length <= TITLE_MAX) return candidate;
	const cut = candidate.slice(0, TITLE_MAX);
	const lastSpace = cut.lastIndexOf(" ");
	return `${(lastSpace > TITLE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const TITLE_MAX = 48;
const SNIPPET_MAX = 100;

/**
 * Collect the labelling stats for one session in a single pass:
 * first user message (snippet), user-message count, last activity timestamp.
 */
function summarizeSession(store: EventStore, session: SessionDescriptor): SessionStats {
	const { start_event_id, end_event_id } = session.event_range;
	// No thread_id filter: legacy/runtime events may carry no thread_id and a
	// strict filter would drop them. Mismatches are skipped per event instead.
	const range = {
		after: start_event_id === "ORIGIN" ? undefined : start_event_id,
		before: end_event_id === "HEAD" ? undefined : end_event_id,
	};

	const userEvents = store.query({ ...range, types: ["USER_MESSAGE"], limit: MAX_SCANNED_MESSAGES });
	let snippet: string | undefined;
	let message_count = 0;
	for (const event of userEvents) {
		if (event.thread_id && event.thread_id !== session.thread_id) continue;
		message_count++;
		if (snippet) continue;
		const text = extractText(event.payload);
		if (text && !isMainGreetingMessage(text)) snippet = text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}...` : text;
	}

	const tail = store.query({ ...range, limit: 10, reverse: true });
	const latest = tail.find((event) => !event.thread_id || event.thread_id === session.thread_id);
	return { snippet, message_count, last_activity_at: latest?.timestamp };
}

const MAX_SCANNED_MESSAGES = 200;

/** Flatten a USER_MESSAGE payload (string or content blocks) into plain text. */
function extractText(payload: unknown): string {
	const content = (payload as { content?: string | unknown[] } | undefined)?.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((block) =>
							block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text) : "",
						)
						.join(" ")
				: "";
	return text.replace(/\s+/g, " ").trim();
}
