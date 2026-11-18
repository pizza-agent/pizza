/**
 * Built-in extension: provenance-lens
 *
 * `_why` answers "why did this file/event change?" from the immutable event
 * log. It is deterministic, read-only, and intentionally never calls a model:
 * the evidence chain is already in EventStore's `caused_by` links.
 */

import type {
	AgentToolResult,
	CliCommandDefinition,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import { buildWhy, type WhyQuery } from "../../core/provenance/why.js";

export const PROVENANCE_LENS_EXTENSION_ID = "provenance-lens";

interface WhyArgs extends WhyQuery {
	json?: boolean;
	help?: boolean;
}

const USAGE =
	"_why <path> | _why --event <event_id> | _why --tool-call <tool_call_id> [--limit N] [--json]";

function parseArgs(args: string[]): WhyArgs {
	const parsed: WhyArgs = {};
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			parsed.json = true;
		} else if (arg === "--help" || arg === "-h") {
			parsed.help = true;
		} else if (arg === "--event" || arg === "--tool-call" || arg === "--limit") {
			const value = args[++i];
			if (value === undefined) throw new Error(`${arg} requires a value.\n\n${USAGE}`);
			if (arg === "--event") parsed.eventId = value;
			else if (arg === "--tool-call") parsed.toolCallId = value;
			else {
				const limit = Number(value);
				if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer.");
				parsed.limit = limit;
			}
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}\n\n${USAGE}`);
		} else {
			positionals.push(arg);
		}
	}
	if (positionals.length > 1) throw new Error(`Expected one path, got ${positionals.length}.\n\n${USAGE}`);
	if (positionals.length === 1) {
		if (parsed.eventId || parsed.toolCallId) throw new Error(`Use either a path or --event/--tool-call.\n\n${USAGE}`);
		parsed.path = positionals[0];
	}
	if (!parsed.help && !parsed.path && !parsed.eventId && !parsed.toolCallId) {
		throw new Error(`Missing path/--event/--tool-call.\n\n${USAGE}`);
	}
	return parsed;
}

function errorResult(message: string): never {
	throw new Error(message);
}

/** `_why` CLI command. */
export const whyCommand: CliCommandDefinition<WhyArgs> = {
	name: "_why",
	description: "Explain why a file/event changed, using the event causal chain (read-only).",
	usage: USAGE,
	promptGuidelines: [
		"Use _why <path> to retrieve the compact evidence chain behind a file change before re-reading the whole session.",
	],
	parseArguments: parseArgs,
	classify: () => ({
		category: "file_read",
		description: "Inspect file-change provenance",
	}),
	async execute(
		_toolCallId: string,
		params: WhyArgs,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> {
		if (params.help) {
			return {
				content: [
					{
						type: "text",
						text: `_why — explain a change from the event log\n\nUsage:\n  ${USAGE}\n\nExamples:\n  _why src/auth.ts\n  _why --event 01J...\n  _why --tool-call tc_123\n  _why src/auth.ts --json`,
					},
				],
			};
		}
		const store = ctx.sessionManager.eventStore;
		if (!store) {
			return errorResult("_why is unavailable: this session is not backed by an EventStore.");
		}
		const descriptor = ctx.sessionManager.projection?.getDescriptor();
		if (!descriptor?.thread_id) {
			return errorResult("_why requires an event-store session with a thread id.");
		}
		try {
			const result = buildWhy(store, {
				...params,
				threadId: descriptor.thread_id,
				sessionRange: {
					startEventId: descriptor.event_range.start_event_id,
					endEventId: descriptor.event_range.end_event_id,
				},
			});
			if (params.json) {
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			}
			return {
				content: [{ type: "text", text: result.markdown }],
				details: result,
			};
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
	},
};

export const createProvenanceLensExtension: ExtensionFactory = (pizza) => {
	pizza.registerCliCommand(whyCommand);
};
