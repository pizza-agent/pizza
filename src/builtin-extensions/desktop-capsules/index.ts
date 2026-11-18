/**
 * Built-in extension: desktop-capsules
 *
 * Record a sequence of `_computer_use act` calls into a reusable, selector-based
 * desktop workflow, then replay it against a fresh observation:
 *
 *   _capsule record monthly-export
 *   ... _computer_use observe / search / act ...
 *   _capsule stop
 *   _computer_use observe --root @r3
 *   _capsule play monthly-export --state <stateId>
 */

import type {
	AgentToolResult,
	CliCommandDefinition,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.js";
import type { ToolCallIntent } from "../../core/intent/types.js";
import {
	cancelRecording,
	deleteCapsule,
	listCapsules,
	loadCapsule,
	playCapsule,
	startRecording,
	stopRecording,
} from "../computer-use/capsules.js";

export const DESKTOP_CAPSULES_EXTENSION_ID = "desktop-capsules";

interface CapsuleArgs {
	subcommand: string;
	name?: string;
	stateId?: string;
	json?: boolean;
	help?: boolean;
}

const USAGE = [
	"_capsule record <name>          start recording act steps",
	"_capsule stop                  save the active recording",
	"_capsule cancel                discard the active recording",
	"_capsule list                  list saved capsules",
	"_capsule show <name> [--json]  inspect a capsule",
	"_capsule play <name> --state <stateId>",
	"_capsule delete <name>",
].join("\n");

function parseArgs(args: string[]): CapsuleArgs {
	const subcommand = (args[0] ?? "help").toLowerCase();
	const parsed: CapsuleArgs = { subcommand };
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") parsed.json = true;
		else if (arg === "--help" || arg === "-h") parsed.help = true;
		else if (arg === "--state") {
			const value = args[++i];
			if (!value) throw new Error("--state requires a stateId.");
			parsed.stateId = value;
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}\n\n${USAGE}`);
		} else if (!parsed.name) {
			parsed.name = arg;
		} else {
			throw new Error(`Unexpected argument: ${arg}\n\n${USAGE}`);
		}
	}
	if (!["help", "record", "stop", "cancel", "list", "show", "play", "delete"].includes(subcommand)) {
		throw new Error(`Unknown _capsule subcommand: ${subcommand}\n\n${USAGE}`);
	}
	if (["record", "show", "play", "delete"].includes(subcommand) && !parsed.name) {
		throw new Error(`${subcommand} requires a capsule name.\n\n${USAGE}`);
	}
	if (subcommand === "play" && !parsed.stateId) {
		throw new Error("play requires --state <stateId> from a fresh _computer_use observe.");
	}
	return parsed;
}

function result(text: string, details?: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function classifyCapsule(params: CapsuleArgs): ToolCallIntent {
	if (params.subcommand === "play") {
		return { category: "shell_moderate", description: "Replay desktop workflow capsule" };
	}
	if (params.subcommand === "delete" || params.subcommand === "record" || params.subcommand === "stop" || params.subcommand === "cancel") {
		return { category: "file_write", description: "Manage desktop workflow capsule" };
	}
	return { category: "file_read", description: "Inspect desktop workflow capsules" };
}

export const capsuleCommand: CliCommandDefinition<CapsuleArgs> = {
	name: "_capsule",
	description: "Record and replay selector-based desktop workflows (computer-use capsules).",
	usage: USAGE,
	promptGuidelines: [
		"Use _capsule record <name> before a repetitive desktop flow, then _capsule stop to save it.",
		"Replay a capsule with _capsule play <name> --state <stateId> after observing the target window.",
	],
	parseArguments: parseArgs,
	classify: classifyCapsule,
	async execute(
		_toolCallId: string,
		params: CapsuleArgs,
		_signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> {
		if (params.subcommand === "help" || params.help) {
			return result(`Desktop workflow capsules\n\n${USAGE}`);
		}
		switch (params.subcommand) {
			case "record": {
				startRecording(ctx, params.name!);
				return result(`Recording capsule "${params.name}". Run _computer_use act steps, then _capsule stop.`);
			}
			case "stop": {
				const capsule = await stopRecording(ctx);
				return result(`Saved capsule "${capsule.name}" with ${capsule.steps.length} step(s).`);
			}
			case "cancel": {
				cancelRecording(ctx);
				return result("Cancelled the active capsule recording.");
			}
			case "list": {
				const capsules = await listCapsules();
				if (capsules.length === 0) return result("No desktop capsules saved.");
				return result(
					capsules
						.map((capsule) => `${capsule.name}\t${capsule.steps} step(s)\tupdated ${new Date(capsule.updatedAt).toISOString()}`)
						.join("\n"),
					capsules,
				);
			}
			case "show": {
				const capsule = await loadCapsule(params.name!);
				return result(
					params.json ? JSON.stringify(capsule, null, 2) : `${capsule.name}: ${capsule.steps.length} step(s)\n${JSON.stringify(capsule.steps, null, 2)}`,
					capsule,
				);
			}
			case "delete": {
				await deleteCapsule(params.name!);
				return result(`Deleted capsule "${params.name}".`);
			}
			case "play": {
				const played = await playCapsule(ctx, params.name!, params.stateId!);
				return result(
					`Played capsule "${params.name}" (${played.steps} step(s)). Final state: ${played.finalStateId}`,
					played,
				);
			}
			default:
				return result(USAGE);
		}
	},
};

export const createDesktopCapsulesExtension: ExtensionFactory = (pizza) => {
	pizza.registerCliCommand(capsuleCommand);
};
