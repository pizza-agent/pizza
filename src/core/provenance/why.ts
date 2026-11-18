/**
 * Provenance Lens core: turn an event's causal chain into a compact "why"
 * answer. This is deterministic and read-only — no model call, no log replay,
 * no raw payload dump.
 */

import type { EventBase } from "../event-store/types.js";
import type { EventStore } from "../event-store/store.js";

export interface WhySessionRange {
	/** Inclusive session start. "ORIGIN" means the beginning of the workspace log. */
	startEventId?: string;
	/** Inclusive session end. "HEAD" means the latest event. */
	endEventId?: string;
}

export interface WhyQuery {
	path?: string;
	eventId?: string;
	toolCallId?: string;
	threadId?: string;
	sessionRange?: WhySessionRange;
	/** Maximum evidence bullets. Default 8. */
	limit?: number;
}

export interface WhyEvidence {
	eventId: string;
	type: string;
	sequence: number;
	summary: string;
}

export interface WhyResult {
	title: string;
	markdown: string;
	evidence: WhyEvidence[];
	targetEventId: string;
}

const RELEVANT_TYPES = new Set([
	"USER_MESSAGE",
	"AGENT_MESSAGE_END",
	"INTENT_TOOL_CALL",
	"TOOL_EXECUTION_END",
	"FILE_MUTATION_APPLIED",
	"USER_APPROVAL",
	"USER_REJECTION",
	"BASH_EXECUTION",
]);

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1)}…`;
}

function normalizePath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const path = value.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
	return path.length > 0 ? path : null;
}

function countDiff(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	let inHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) {
			inHunk = false;
			continue;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

function summarize(event: EventBase): string | null {
	const payload = asRecord(event.payload);
	switch (event.type) {
		case "USER_MESSAGE": {
			const content = typeof payload.content === "string" ? payload.content : "";
			return content ? `User: ${truncate(content, 260)}` : "User message";
		}
		case "AGENT_MESSAGE_END": {
			const content = Array.isArray(payload.content) ? payload.content : [];
			const text = content
				.map((block) => (asRecord(block).type === "text" ? textOf(asRecord(block).text) : ""))
				.filter(Boolean)
				.join(" ");
			return text ? `Assistant: ${truncate(text, 220)}` : null;
		}
		case "INTENT_TOOL_CALL": {
			const tool = textOf(payload.tool_name) || "tool";
			const args = payload.arguments ? truncate(JSON.stringify(payload.arguments), 220) : "";
			return `Tool call: ${tool}${args ? ` ${args}` : ""}`;
		}
		case "TOOL_EXECUTION_END": {
			const result = Array.isArray(payload.result) ? payload.result : [];
			const text = result
				.map((block) => (asRecord(block).type === "text" ? textOf(asRecord(block).text) : ""))
				.filter(Boolean)
				.join(" ");
			const error = payload.is_error === true ? " (error)" : "";
			return `Tool result${error}: ${truncate(text || "no output", 280)}`;
		}
		case "FILE_MUTATION_APPLIED": {
			const path = normalizePath(payload.path) ?? "file";
			const operation = textOf(payload.operation) || "modify";
			const diff = textOf(payload.diff);
			const stats = diff ? countDiff(diff) : undefined;
			const statText = stats ? ` (+${stats.additions} −${stats.deletions})` : "";
			return `Changed ${path} [${operation}]${statText}`;
		}
		case "USER_APPROVAL":
			return "User approved the tool call";
		case "USER_REJECTION":
			return "User rejected the tool call";
		case "BASH_EXECUTION":
			return `Shell: ${truncate(textOf(payload.command) || "command", 220)}`;
		default:
			return null;
	}
}

function eventInSession(event: EventBase, startSeq: number, endSeq: number): boolean {
	return event.sequence >= startSeq && event.sequence <= endSeq;
}

function sessionBounds(store: EventStore, range?: WhySessionRange): { start: number; end: number } {
	const start = range?.startEventId && range.startEventId !== "ORIGIN"
		? store.get(range.startEventId)?.sequence ?? 0
		: 0;
	const end = range?.endEventId && range.endEventId !== "HEAD"
		? store.get(range.endEventId)?.sequence ?? store.head_sequence
		: store.head_sequence;
	return { start, end };
}

function isRelevant(event: EventBase): boolean {
	return RELEVANT_TYPES.has(event.type) && summarize(event) !== null;
}

function findTarget(store: EventStore, query: WhyQuery, bounds: { start: number; end: number }): EventBase | undefined {
	if (query.eventId) {
		const event = store.get(query.eventId);
		if (!event || !eventInSession(event, bounds.start, bounds.end)) return undefined;
		if (query.threadId && event.thread_id !== query.threadId) return undefined;
		return event;
	}

	const candidates = store.query({
		...(query.threadId ? { thread_id: query.threadId } : {}),
		types: ["FILE_MUTATION_APPLIED", "TOOL_EXECUTION_END", "INTENT_TOOL_CALL"],
	});
	const inRange = candidates.filter((event) => eventInSession(event, bounds.start, bounds.end));

	if (query.toolCallId) {
		return [...inRange]
			.reverse()
			.find((event) => {
				const payload = asRecord(event.payload);
				return payload.tool_call_id === query.toolCallId;
			});
	}

	const path = normalizePath(query.path);
	if (!path) return undefined;
	const mutation = [...inRange]
		.reverse()
		.find((event) => {
			if (event.type !== "FILE_MUTATION_APPLIED") return false;
			return normalizePath(asRecord(event.payload).path) === path;
		});
	if (mutation) return mutation;

	// Fall back to a tool result that reported this path (older runtimes did not
	// emit a separate FILE_MUTATION_APPLIED event).
	return [...inRange]
		.reverse()
		.find((event) => {
			if (event.type !== "TOOL_EXECUTION_END") return false;
			const mutations = asRecord(event.payload).file_mutations;
			if (!Array.isArray(mutations)) return false;
			return mutations.some((mutation) => normalizePath(asRecord(mutation).path) === path);
		});
}

function capEvidence(evidence: WhyEvidence[], limit: number): WhyEvidence[] {
	if (evidence.length <= limit) return evidence;
	// Keep the user's request (if present) and the most recent steps.
	return [evidence[0], ...evidence.slice(-(limit - 1))];
}

/**
 * Build a compact provenance answer for a path/event/tool call.
 * Throws a user-facing Error when no matching event exists.
 */
export function buildWhy(store: EventStore, query: WhyQuery): WhyResult {
	const limit = Math.max(1, Math.min(query.limit ?? 8, 20));
	const bounds = sessionBounds(store, query.sessionRange);
	const target = findTarget(store, query, bounds);
	if (!target) {
		const selector = query.path ?? query.eventId ?? query.toolCallId ?? "the requested event";
		throw new Error(`No provenance found for ${selector}.`);
	}

	const chain = store.getCausalChain(target.event_id).filter((event) => eventInSession(event, bounds.start, bounds.end));
	const relevant = new Map<string, EventBase>();
	for (const event of chain) {
		if (isRelevant(event)) relevant.set(event.event_id, event);
	}

	// `caused_by` may stop at an assistant message; add the nearest preceding user
	// request within the same session so the answer has a human anchor.
	const userBefore = store.query({
		types: ["USER_MESSAGE"],
		before: target.event_id,
		reverse: true,
		limit: 1,
		...(query.threadId ? { thread_id: query.threadId } : {}),
	})[0];
	if (userBefore && eventInSession(userBefore, bounds.start, bounds.end)) {
		relevant.set(userBefore.event_id, userBefore);
	}

	const all = [...relevant.values()].sort((a, b) => a.sequence - b.sequence);
	const evidence: WhyEvidence[] = all.map((event) => ({
		eventId: event.event_id,
		type: event.type,
		sequence: event.sequence,
		summary: summarize(event) ?? event.type,
	}));
	const capped = capEvidence(evidence, limit);

	const subject = normalizePath(query.path) ? `\`${normalizePath(query.path)}\` changed` : `event ${target.event_id}`;
	const title = `Why ${subject}`;
	const markdown = [`## ${title}`, "", ...capped.map((item) => `- ${item.summary}`), "", `Evidence: ${capped.map((item) => item.eventId).join(", ")}`].join("\n");
	return { title, markdown, evidence: capped, targetEventId: target.event_id };
}
