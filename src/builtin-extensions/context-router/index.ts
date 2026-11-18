/**
 * Built-in extension: context-router
 *
 * Read-only `_context` selectors for long sessions:
 *
 *   _context pins [--budget 1200] [--limit 8] [--json]
 *   _context recent [--budget 2000] [--json]
 *   _context path <path> [--budget 2000] [--json]
 *   _context route <query> [--json]
 *
 * It deliberately does not modify the default context builder.
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
	type ContextSelection,
} from "../../core/context/goal-pins.js";

export const CONTEXT_ROUTER_EXTENSION_ID = "context-router";

interface ContextArgs {
	subcommand: "pins" | "recent" | "path" | "route" | "help";
	path?: string;
	query?: string;
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
].join("\n");

function parseArgs(args: string[]): ContextArgs {
	const subcommand = (args[0] ?? "help").toLowerCase();
	if (!["pins", "recent", "path", "route", "help"].includes(subcommand)) {
		throw new Error(`Unknown _context subcommand: ${subcommand}\n\n${USAGE}`);
	}
	const parsed: ContextArgs = { subcommand: subcommand as ContextArgs["subcommand"] };
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") parsed.json = true;
		else if (arg === "--help" || arg === "-h") parsed.help = true;
		else if (arg === "--budget" || arg === "--limit") {
			const value = Number(args[++i]);
			if (!Number.isFinite(value) || value <= 0) throw new Error(`${arg} must be a positive number.`);
			if (arg === "--budget") parsed.budget = Math.floor(value);
			else parsed.limit = Math.floor(value);
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}\n\n${USAGE}`);
		} else if (subcommand === "path" && !parsed.path) parsed.path = arg;
		else if (subcommand === "route") parsed.query = parsed.query ? `${parsed.query} ${arg}` : arg;
		else throw new Error(`Unexpected argument: ${arg}\n\n${USAGE}`);
	}
	if (subcommand === "path" && !parsed.path) throw new Error(`path requires a file path.\n\n${USAGE}`);
	if (subcommand === "route" && !parsed.query) throw new Error(`route requires a query.\n\n${USAGE}`);
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
	description: "Read-only context selectors: GoalPins, recent window, path evidence, and a small router.",
	usage: USAGE,
	promptGuidelines: [
		"Use _context pins when you need early user constraints or decisions, and _context recent for next-action work.",
	],
	parseArguments: parseArgs,
	classify: () => ({ category: "file_read", description: "Inspect context selection" }),
	async execute(
		_toolCallId: string,
		params: ContextArgs,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> {
		if (params.subcommand === "help" || params.help) {
			return { content: [{ type: "text", text: `Context selectors\n\n${USAGE}` }] };
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
		const budget = params.budget;
		const limit = params.limit;
		switch (params.subcommand) {
			case "pins":
				return asResult(selectGoalPins(events, { tokenBudget: budget, limit }), params.json);
			case "recent":
				return asResult(selectRecentContext(events, { tokenBudget: budget }), params.json);
			case "path":
				return asResult(selectPathContext(events, params.path!, { tokenBudget: budget }), params.json);
			case "route": {
				const decision = routeContextQuery(params.query!);
				const selection = decision.strategy === "pins"
					? selectGoalPins(events, { tokenBudget: budget, limit })
					: selectRecentContext(events, { tokenBudget: budget });
				return asResult(selection, params.json);
			}
			default:
				return { content: [{ type: "text", text: USAGE }] };
		}
	},
};

export const createContextRouterExtension: ExtensionFactory = (pizza) => {
	pizza.registerCliCommand(contextCommand);
};
