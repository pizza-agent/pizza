export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	checkShellPolicy,
	createLocalBashOperations,
	type ShellDetails,
	type ShellOptions,
	type ShellPolicy,
} from "./shell.js";
export {
	type CliCommandDetails,
	type CliToolDetails,
	type CliToolInput,
	type CliToolOptions,
	createCliToolDefinition,
} from "./cli.js";
export {
	BUILTIN_COMMANDS,
	type BuiltinCliCommandOptions,
	type BuiltinCommand,
	createBuiltinCliCommands,
	isBuiltinCommandName,
} from "./builtin-cli-commands.js";
export { type CliCommandEntry, type CliCommandSource, CommandRegistry, validateCliCommand } from "./command-registry.js";
export { getCliCommandHelp, type ResolvedCliCommand, resolveCliCommand } from "./command-resolve.js";
export type { EditOperations, EditToolDetails, EditToolInput, EditToolOptions } from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export type { ReadOperations, ReadToolDetails, ReadToolInput, ReadToolOptions } from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export type { WriteOperations, WriteToolInput, WriteToolOptions } from "./write.js";

import type { CliCommandDefinition } from "../extensions/types.js";
import { BUILTIN_COMMANDS, type BuiltinCommand, isBuiltinCommandName } from "./builtin-cli-commands.js";
import { validateCliCommand } from "./command-registry.js";

/** One `tools` entry: a built-in command name, "shell" (the shell fallback), or an SDK command. */
export type ToolsOptionEntry = BuiltinCommand | "shell" | CliCommandDefinition;

/** Default `tools`: every built-in command plus the shell fallback. */
export const DEFAULT_TOOLS: readonly ToolsOptionEntry[] = [...BUILTIN_COMMANDS, "shell"];

export interface ParsedToolsOption {
	builtins: Set<BuiltinCommand>;
	shell: boolean;
	commands: CliCommandDefinition[];
}

/** Validate and split a `tools` option. Throws on unknown names or invalid/duplicate commands. */
export function parseToolsOption(entries: readonly ToolsOptionEntry[]): ParsedToolsOption {
	const parsed: ParsedToolsOption = { builtins: new Set(), shell: false, commands: [] };
	for (const entry of entries) {
		if (typeof entry !== "string") {
			validateCliCommand(entry);
			if (parsed.commands.some((command) => command.name === entry.name)) {
				throw new Error(`Duplicate cli command in tools: ${entry.name}`);
			}
			parsed.commands.push(entry);
		} else if (entry === "shell") {
			parsed.shell = true;
		} else if (isBuiltinCommandName(entry)) {
			parsed.builtins.add(entry);
		} else {
			throw new Error(
				`Unknown tools entry "${entry}". Use built-in command names (${BUILTIN_COMMANDS.join(", ")}), "shell", or defineCliCommand(...) objects.`,
			);
		}
	}
	return parsed;
}
