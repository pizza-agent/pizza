/**
 * GoalPins: deterministic, read-only context selectors for long sessions.
 *
 * This is a retrieval layer, not a context-builder replacement:
 * - pins: explicit user constraints / early decisions
 * - recent: latest observations for next-action work
 * - path: file-scoped long-range evidence
 *
 * Routing is intentionally small and inspectable. It should be replaced by a
 * benchmarked classifier before it is wired into the default context builder.
 */

import type { EventBase } from "../event-store/types.js";
import type { PersonalMemoryItem } from "./personal-memory.js";
import { estimateStringTokens } from "../compaction/token-estimation.js";

export type ContextStrategy = "pins" | "recent" | "path";

export interface ContextEvidence {
	eventId: string;
	type: string;
	sequence: number;
	summary: string;
}

export interface ContextSelection {
	strategy: ContextStrategy;
	/** Human-readable markdown; also useful for CLI output. */
	markdown: string;
	evidence: ContextEvidence[];
}

export interface GoalPinsOptions {
	/** Maximum number of pinned user messages. Default 8. */
	limit?: number;
	/** Approximate token budget. Default 1200. */
	tokenBudget?: number;
	/** Explicitly saved, user-owned memories to merge ahead of event pins. */
	memories?: PersonalMemoryItem[];
}

export interface RecentOptions {
	/** Approximate token budget. Default 2000. */
	tokenBudget?: number;
}

export interface PathOptions {
	/** Approximate token budget. Default 2000. */
	tokenBudget?: number;
}

const CONSTRAINT_HINTS = [
	"want",
	"need",
	"should",
	"must",
	"only",
	"prefer",
	"don't",
	"do not",
	"keep",
	"call",
	"create",
	"read",
	"remember",
	"test",
	"name",
	"plan",
	"branch",
	"set",
	"getter",
	"listener",
	"unsubscribe",
	"main-new",
	"refactor",
	"constraint",
	"require",
	"preserve",
];

const TRIVIAL_USER = new Set(["ok", "okay", "continue", "yes", "no", "sure", "go", "do it"]);

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

export function normalizePath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const path = value.replace(/\\/g, "/").replace(/^\.\/+/, "").trim();
	return path.length > 0 ? path : null;
}

function payloadPath(event: EventBase): string | null {
	const payload = asRecord(event.payload);
	return normalizePath(payload.path) ?? normalizePath(payload.file);
}

/** A compact, deterministic summary of one event for retrieval/budgeting. */
export function summarizeEvent(event: EventBase): string {
	const payload = asRecord(event.payload);
	switch (event.type) {
		case "USER_MESSAGE":
			return truncate(textOf(payload.content), 900);
		case "AGENT_MESSAGE_END": {
			const content = Array.isArray(payload.content) ? payload.content : [];
			const parts = content.map((block) => {
				const record = asRecord(block);
				if (record.type === "text") return textOf(record.text);
				if (record.type === "tool_call" || record.type === "toolCall") {
					return `[tool ${textOf(record.name) || "call"}]`;
				}
				return "";
			});
			return truncate(parts.filter(Boolean).join(" "), 900);
		}
		case "INTENT_TOOL_CALL": {
			const tool = textOf(payload.tool_name) || "tool";
			const args = payload.arguments ? truncate(JSON.stringify(payload.arguments), 300) : "";
			return `${tool}${args ? ` ${args}` : ""}`;
		}
		case "TOOL_EXECUTION_END": {
			const result = Array.isArray(payload.result) ? payload.result : [];
			const text = result
				.map((block) => (asRecord(block).type === "text" ? textOf(asRecord(block).text) : ""))
				.filter(Boolean)
				.join(" ");
			const error = payload.is_error === true ? " (error)" : "";
			return truncate(`${text || "no output"}${error}`, 900);
		}
		case "FILE_MUTATION_APPLIED": {
			const path = payloadPath(event) ?? "file";
			const operation = textOf(payload.operation) || "modify";
			return `${operation} ${path}`;
		}
		default:
			return event.type;
	}
}

export function isConstraintMessage(text: string): boolean {
	const value = text.trim();
	if (value.length < 20) return false;
	if (value.startsWith("/")) return false;
	if (TRIVIAL_USER.has(value.toLowerCase())) return false;
	return CONSTRAINT_HINTS.some((hint) => value.toLowerCase().includes(hint));
}

/** User messages worth pinning; slash commands and acknowledgements are not. */
export function isPinnableUserMessage(text: string): boolean {
	const value = text.trim();
	if (value.length < 12) return false;
	if (value.startsWith("/")) return false;
	if (TRIVIAL_USER.has(value.toLowerCase())) return false;
	return true;
}

function toEvidence(event: EventBase): ContextEvidence {
	return {
		eventId: event.event_id,
		type: event.type,
		sequence: event.sequence,
		summary: summarizeEvent(event),
	};
}

function withinBudget(evidence: ContextEvidence[], tokenBudget: number): ContextEvidence[] {
	const out: ContextEvidence[] = [];
	let used = 0;
	for (const item of evidence) {
		const cost = estimateStringTokens(item.summary);
		if (out.length > 0 && used + cost > tokenBudget) continue;
		out.push(item);
		used += cost;
	}
	return out;
}

function render(strategy: ContextStrategy, evidence: ContextEvidence[]): string {
	const title = strategy === "pins" ? "GoalPins" : strategy === "path" ? "Path evidence" : "Recent context";
	return [
		`## ${title}`,
		"",
		...evidence.map((item) => `- [${item.type}] ${item.summary}`),
		"",
		`Evidence: ${evidence.map((item) => item.eventId).join(", ")}`,
	].join("\n");
}

/** Pin explicit user constraints and early decisions. */
export function selectGoalPins(events: EventBase[], options: GoalPinsOptions = {}): ContextSelection {
	const limit = Math.max(1, Math.min(options.limit ?? 8, 20));
	const budget = Math.max(100, options.tokenBudget ?? 1200);
	const users = events.filter((event) => event.type === "USER_MESSAGE" && isPinnableUserMessage(summarizeEvent(event)));
	const memoryEvidence = (options.memories ?? []).map((memory) => ({
		eventId: `memory:${memory.id}`,
		type: "MEMORY",
		sequence: 0,
		summary: `[${memory.kind}] ${memory.text}`,
	}));
	if (users.length === 0) {
		const evidence = withinBudget(memoryEvidence, budget);
		return { strategy: "pins", markdown: render("pins", evidence), evidence };
	}
	const lastSeq = users[users.length - 1].sequence;
	const scored = users.map((event, index) => {
		const text = summarizeEvent(event);
		let score = CONSTRAINT_HINTS.reduce((sum, hint) => sum + (text.toLowerCase().includes(hint) ? 1 : 0), 0);
		if (index === 0) score += 3;
		if (index >= users.length - 3) score += 1;
		return { event, score, distance: lastSeq - event.sequence };
	});
	const selected = scored
		.sort((a, b) => b.score - a.score || a.distance - b.distance)
		.slice(0, limit)
		.sort((a, b) => a.event.sequence - b.event.sequence)
		.map((item) => toEvidence(item.event));
	const evidence = withinBudget([...memoryEvidence, ...selected], budget);
	return { strategy: "pins", markdown: render("pins", evidence), evidence };
}

/** Latest observations, for next-action work. */
export function selectRecentContext(events: EventBase[], options: RecentOptions = {}): ContextSelection {
	const budget = Math.max(100, options.tokenBudget ?? 2000);
	const candidates = events
		.filter((event) => ["USER_MESSAGE", "AGENT_MESSAGE_END", "TOOL_EXECUTION_END", "FILE_MUTATION_APPLIED"].includes(event.type))
		.sort((a, b) => a.sequence - b.sequence);
	const evidence: ContextEvidence[] = [];
	let used = 0;
	for (const event of [...candidates].reverse()) {
		const item = toEvidence(event);
		const cost = estimateStringTokens(item.summary);
		if (evidence.length > 0 && used + cost > budget) continue;
		evidence.push(item);
		used += cost;
	}
	evidence.reverse();
	return { strategy: "recent", markdown: render("recent", evidence), evidence };
}

/** File-scoped evidence for long-range/original-content questions. */
export function selectPathContext(events: EventBase[], path: string, options: PathOptions = {}): ContextSelection {
	const target = normalizePath(path);
	const budget = Math.max(100, options.tokenBudget ?? 2000);
	if (!target) {
		return { strategy: "path", markdown: "## Path evidence\n\nNo path supplied.", evidence: [] };
	}
	const matchingCalls = new Set<string>();
	for (const event of events) {
		if (event.type !== "INTENT_TOOL_CALL") continue;
		const payload = asRecord(event.payload);
		const args = asRecord(payload.arguments);
		const callPath = payloadPath(event) ?? normalizePath(args.path) ?? normalizePath(args.file);
		if (callPath === target) {
			const id = payload.tool_call_id;
			if (typeof id === "string") matchingCalls.add(id);
		}
	}
	const candidates = events.filter((event) => {
		const payload = asRecord(event.payload);
		if (payloadPath(event) === target) return true;
		if (Array.isArray(payload.file_mutations)) {
			return payload.file_mutations.some((mutation) => normalizePath(asRecord(mutation).path) === target);
		}
		if (typeof payload.tool_call_id === "string" && matchingCalls.has(payload.tool_call_id)) return true;
		return false;
	});
	const evidence: ContextEvidence[] = [];
	let used = 0;
	for (const event of candidates.sort((a, b) => a.sequence - b.sequence)) {
		const item = toEvidence(event);
		const cost = estimateStringTokens(item.summary);
		if (evidence.length > 0 && used + cost > budget) continue;
		evidence.push(item);
		used += cost;
	}
	return { strategy: "path", markdown: render("path", evidence), evidence };
}

export interface RouteDecision {
	strategy: "pins" | "recent";
	reason: string;
}

/** Tiny deterministic intent router; intentionally easy to benchmark/replace. */
export function routeContextQuery(query: string): RouteDecision {
	const value = query.toLowerCase();
	const pinsHints = ["why", "constraint", "plan", "remind", "what did", "original", "最初", "约束", "计划", "为什么", "记得", "要求"];
	if (pinsHints.some((hint) => value.includes(hint))) {
		return { strategy: "pins", reason: "constraint/plan/origin intent" };
	}
	return { strategy: "recent", reason: "default next-action intent" };
}
