/**
 * Built-in extension: context-router
 *
 * Read-only context selectors plus explicit, user-owned memory:
 *
 *   _context pins [--budget 1200] [--limit 8] [--json]
 *   _context recent [--budget 2000] [--json]
 *   _context path <path> [--budget 2000] [--json]
 *   _context route <query> [--json]
 *
 *   _context remember <event_id> [--kind constraint] [--scope project|session|global]
 *                                   [--text "..."] [--confidence 0.9] [--expires ISO]
 *   _context forget <memory_id>
 *   _context memories [--json]
 *   _context export [--json]
 *
 * Memory is written only by explicit user commands. It is local JSON under
 * the agent dir and every item keeps its source event id.
 */

import type {
	AgentToolResult,
	CliCommandDefinition,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import type { EventBase } from "../../core/event-store/types.js";
import {
	routeContextQuery,
	selectGoalPins,
	selectPathContext,
	selectRecentContext,
	summarizeEvent,
	type ContextSelection,
} from "../../core/context/goal-pins.js";
import {
	PersonalMemoryStore,
	type MemoryKind,
	type MemoryScope,
} from "../../core/context/personal-memory.js";

export const CONTEXT_ROUTER_EXTENSION_ID = "context-router";

type Subcommand = "pins" | "recent" | "path" | "route" | "remember" | "forget" | "memories" | "export" | "help";

interface ContextArgs {
	subcommand: Subcommand;
	path?: string;
	query?: string;
	eventId?: string;
	memoryId?: string;
	text?: string;
	kind?: MemoryKind;
	scope?: MemoryScope;
	confidence?: number;
	expires?: string;
	budget?: number;
	limit?: number;
	json?: boolean;
	help?: boolean;
}

const USAGE = [
	"_context pins [--budget N] [--limit N] [--json]",
	"_context recent [--budget N] [--json]",
	"_context path <path> [--budget N] [--json]",
	"_context route <query> [--json]",
	"_context remember <event_id> [--kind constraint|preference|decision|fact] [--scope session|project|global] [--text ...] [--confidence 0-1] [--expires ISO]",
	"_context forget <memory_id>",
	"_context memories [--json]",
	"_context export [--json]",
].join("\n");

const KINDS: MemoryKind[] = ["constraint", "preference", "decision", "fact"];
const SCOPES: MemoryScope[] = ["session", "project", "global"];

function parseArgs(args: string[]): ContextArgs {
	const raw = (args[0] ?? "help").toLowerCase();
	const alias: Record<string, Subcommand> = { pin: "remember", unpin: "forget" };
	const subcommand = (alias[raw] ?? raw) as Subcommand;
	if (!["pins", "recent", "path", "route", "remember", "forget", "memories", "export", "help"].includes(subcommand)) {
		throw new Error(`Unknown _context subcommand: ${raw}\n\n${USAGE}`);
	}
	const parsed: ContextArgs = { subcommand };
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") parsed.json = true;
		else if (arg === "--help" || arg === "-h") parsed.help = true;
		else if (arg === "--budget" || arg === "--limit" || arg === "--confidence") {
			const value = Number(args[++i]);
			if (!Number.isFinite(value) || value < 0 || (arg !== "--confidence" && value === 0)) {
				throw new Error(`${arg} must be a ${arg === "--confidence" ? "number between 0 and 1" : "positive number"}.`);
			}
			if (arg === "--budget") parsed.budget = Math.floor(value);
			else if (arg === "--limit") parsed.limit = Math.floor(value);
			else {
				if (value > 1) throw new Error("--confidence must be between 0 and 1.");
				parsed.confidence = value;
			}
		} else if (arg === "--text" || arg === "--kind" || arg === "--scope" || arg === "--expires") {
			const value = args[++i];
			if (value === undefined) throw new Error(`${arg} requires a value.`);
			if (arg === "--text") parsed.text = value;
			else if (arg === "--expires") parsed.expires = value;
			else if (arg === "--kind") {
				if (!KINDS.includes(value as MemoryKind)) throw new Error(`Unknown kind: ${value}`);
				parsed.kind = value as MemoryKind;
			} else {
				if (!SCOPES.includes(value as MemoryScope)) throw new Error(`Unknown scope: ${value}`);
				parsed.scope = value as MemoryScope;
			}
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}\n\n${USAGE}`);
		} else if (subcommand === "path" && !parsed.path) parsed.path = arg;
		else if (subcommand === "route") parsed.query = parsed.query ? `${parsed.query} ${arg}` : arg;
		else if (subcommand === "remember" && !parsed.eventId) parsed.eventId = arg;
		else if (subcommand === "forget" && !parsed.memoryId) parsed.memoryId = arg;
		else throw new Error(`Unexpected argument: ${arg}\n\n${USAGE}`);
	}
	if (subcommand === "path" && !parsed.path) throw new Error(`path requires a file path.\n\n${USAGE}`);
	if (subcommand === "route" && !parsed.query) throw new Error(`route requires a query.\n\n${USAGE}`);
	if (subcommand === "remember" && !parsed.eventId) throw new Error(`remember requires an event id.\n\n${USAGE}`);
	if (subcommand === "forget" && !parsed.memoryId) throw new Error(`forget requires a memory id.\n\n${USAGE}`);
	if (parsed.expires && Number.isNaN(new Date(parsed.expires).getTime())) throw new Error("--expires must be an ISO date-time.");
	return parsed;
}

function sessionEvents(events: EventBase[], ctx: ExtensionContext): EventBase[] {
	const descriptor = ctx.sessionManager.projection?.getDescriptor();
	if (!descriptor) return events;
	const start = descriptor.event_range.start_event_id === "ORIGIN"
		? 0
		: ctx.sessionManager.eventStore?.get(descriptor.event_range.start_event_id)?.sequence ?? 0;
	const end = descriptor.event_range.end_event_id === "HEAD"
		? Number.POSITIVE_INFINITY
		: ctx.sessionManager.eventStore?.get(descriptor.event_range.end_event_id)?.sequence ?? Number.POSITIVE_INFINITY;
	const thread = descriptor.thread_id;
	return events.filter((event) => event.sequence >= start && event.sequence <= end && (!thread || event.thread_id === thread));
}

function asResult(selection: ContextSelection, json: boolean | undefined): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: json ? JSON.stringify(selection, null, 2) : selection.markdown }],
		details: selection,
	};
}

export const contextCommand: CliCommandDefinition<ContextArgs> = {
	name: "_context",
	description: "Read-only context selectors plus explicit user-owned memory pins.",
	usage: USAGE,
	promptGuidelines: [
		"Use _context pins for early user constraints, and _context recent for next-action work.",
		"Use _context remember only when the user explicitly asks to remember something.",
	],
	parseArguments: parseArgs,
	classify: (params) => params.subcommand === "remember" || params.subcommand === "forget"
		? { category: "file_write", description: "Manage explicit context memory" }
		: { category: "file_read", description: "Inspect context memory" },
	async execute(
		_toolCallId: string,
		params: ContextArgs,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> {
		if (params.subcommand === "help" || params.help) {
			return { content: [{ type: "text", text: `Context selectors and memory\n\n${USAGE}` }] };
		}
		const store = ctx.sessionManager.eventStore;
		if (!store) {
			throw new Error("_context is unavailable: this session is not backed by an EventStore.");
		}
		const descriptor = ctx.sessionManager.projection?.getDescriptor();
		if (!descriptor?.thread_id) {
			throw new Error("_context requires an event-store session with a thread id.");
		}
		const events = sessionEvents(store.query({}), ctx);
		const memoryStore = new PersonalMemoryStore();
		const sessionId = descriptor.session_id;
		const workspaceId = descriptor.workspace_id;
		const memories = await memoryStore.list({ sessionId, workspaceId });
		const budget = params.budget;
		const limit = params.limit;
		switch (params.subcommand) {
			case "pins":
				return asResult(selectGoalPins(events, { tokenBudget: budget, limit, memories }), params.json);
			case "recent":
				return asResult(selectRecentContext(events, { tokenBudget: budget }), params.json);
			case "path":
				return asResult(selectPathContext(events, params.path!, { tokenBudget: budget }), params.json);
			case "route": {
				const decision = routeContextQuery(params.query!);
				const selection = decision.strategy === "pins"
					? selectGoalPins(events, { tokenBudget: budget, limit, memories })
					: selectRecentContext(events, { tokenBudget: budget });
				return asResult(selection, params.json);
			}
			case "remember": {
				const event = events.find((candidate) => candidate.event_id === params.eventId);
				if (!event) throw new Error(`Event not found in the active session: ${params.eventId}`);
				const text = params.text?.trim() || summarizeEvent(event);
				const memory = await memoryStore.remember({
					kind: params.kind,
					text,
					scope: params.scope,
					sourceEventId: event.event_id,
					sessionId,
					workspaceId,
					confidence: params.confidence,
					expiresAt: params.expires ? new Date(params.expires).getTime() : undefined,
				});
				return {
					content: [{ type: "text", text: `Remembered ${memory.id} (${memory.scope}/${memory.kind})${memory.text ? `: ${truncate(memory.text, 180)}` : ""}` }],
					details: memory,
				};
			}
			case "forget": {
				const removed = await memoryStore.forget(params.memoryId!);
				if (!removed) throw new Error(`Memory not found: ${params.memoryId}`);
				return { content: [{ type: "text", text: `Forgot ${params.memoryId}` }] };
			}
			case "memories": {
				if (params.json) {
					return { content: [{ type: "text", text: JSON.stringify(memories, null, 2) }], details: memories };
				}
				if (memories.length === 0) return { content: [{ type: "text", text: "No saved memories." }] };
				return {
					content: [{
						type: "text",
						text: memories.map((item) => `${item.id}\t${item.scope}/${item.kind}\t${item.text}`).join("\n"),
					}],
					details: memories,
				};
			}
			case "export": {
				const all = await memoryStore.export();
				return {
					content: [{ type: "text", text: JSON.stringify(all, null, 2) }],
					details: all,
				};
			}
			default:
				return { content: [{ type: "text", text: USAGE }] };
		}
	},
};

function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, max - 1)}…`;
}

export const createContextRouterExtension: ExtensionFactory = (pizza) => {
	pizza.registerCliCommand(contextCommand);
};
