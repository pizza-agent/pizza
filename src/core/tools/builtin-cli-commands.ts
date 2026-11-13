/**
 * The built-in entries of the cli command table (_read, _write, _edit, ...).
 *
 * Each entry wraps the command's implementation (read.ts, write.ts, ...)
 * with its command-line parser, help text, availability check, approval
 * classification and renderers, so the cli tool treats built-ins exactly
 * like extension or SDK commands.
 */

import type { CliCommandDefinition, ToolDefinition } from "../extensions/types.js";
import type { ToolCallIntent } from "../intent/types.js";
import { BUILTIN_COMMANDS, type BuiltinCommand, getBuiltinCommandHelp, parseBuiltinToolInput } from "./builtin-commands.js";
import { createCronToolDefinition, type CronToolOptions } from "./cron.js";
import { createEditToolDefinition, type EditToolOptions } from "./edit.js";
import { createHistoryTreeToolDefinition } from "./history-tree.js";
import { createReadToolDefinition, type ReadToolOptions } from "./read.js";
import { createSessionSplitToolDefinition } from "./session-split.js";
import { createSkillToolDefinition, type SkillToolOptions } from "./skill.js";
import { createTellToolDefinition, type TellToolOptions } from "./tell.js";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.js";
import { validateToolArguments } from "./argument-validation.js";

export { BUILTIN_COMMANDS, type BuiltinCommand };

export interface BuiltinCliCommandOptions {
	read?: ReadToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	/** Enables `_skill` while getSkills() returns at least one skill. */
	skill?: SkillToolOptions;
	/** Enables `_cron` (the scheduler engine itself may be injected later). */
	cron?: CronToolOptions;
	/** Enables `_tell` (needs the agent dir to reach the gateway). */
	tell?: TellToolOptions;
}

export function isBuiltinCommandName(name: string): name is BuiltinCommand {
	return (BUILTIN_COMMANDS as readonly string[]).includes(name);
}

interface BuiltinMeta {
	description: string;
	usage: string;
	classify: (params: any) => ToolCallIntent;
}

const pathOf = (params: { path?: string }) => (params.path ? [params.path] : undefined);

const META: Record<BuiltinCommand, BuiltinMeta> = {
	_read: {
		description: "Read file content with 4-hex line anchors",
		usage: "_read <path> [offset] [limit]",
		classify: (p) => ({ category: "file_read", affectedFiles: pathOf(p), description: `Read ${p.path ?? ""}` }),
	},
	_write: {
		description: "Create or overwrite a file (positional content, --content, or a <<EOF heredoc)",
		usage: "_write <path> <content>  |  _write <path> <<EOF ... EOF",
		classify: (p) => ({ category: "file_write", gate: "writes", affectedFiles: pathOf(p), description: `Write to ${p.path ?? ""}` }),
	},
	_edit: {
		description: "Edit a file by line anchors from _read, or search-and-replace",
		usage: "_edit <path> <op> <range> [new]",
		classify: (p) => ({ category: "file_write", gate: "edits", affectedFiles: pathOf(p), description: `Edit ${p.path ?? ""}` }),
	},
	_session_split: {
		description: "Split the session promptly when the user starts a new task or topic",
		usage: "_session_split [reason] [name]",
		classify: () => ({ category: "shell_safe", description: "Split session" }),
	},
	_history_tree: {
		description: "Browse past sessions: list, view, jump, fork",
		usage: "_history_tree <action> [session_id]",
		classify: (p) => ({ category: "shell_safe", description: `History tree ${p.action ?? ""}` }),
	},
	_skill: {
		description: "Discover and load Agent Skills: list, load, read",
		usage: "_skill <action> [--name <name>] [--file <f>]",
		classify: (p) => ({ category: "file_read", description: `Skill ${p.action ?? ""} ${p.name ?? ""}`.trim() }),
	},
	_cron: {
		description: "Manage scheduled prompts: list, show, create, update, pause, resume, delete, run",
		usage: "_cron <action> [options]",
		classify: (p) => ({
			category: p.action === "list" || p.action === "show" ? "shell_safe" : "shell_moderate",
			description: `Cron ${p.action ?? ""}`,
		}),
	},
	_tell: {
		description: "Send a message to another workspace's agent and get its reply",
		usage: "_tell <action> [to] [message]",
		classify: (p) => ({
			category: p.action === "list" ? "shell_safe" : "shell_moderate",
			description: p.action === "list" ? "List workspaces" : `Tell ${p.to ?? ""}`,
		}),
	},
};

const UNAVAILABLE: Partial<Record<BuiltinCommand, string>> = {
	_skill: "_skill is not available in this session (no skills loaded). It cannot be used here.",
	_cron: "_cron is not available in this session (scheduler not configured). It cannot be used here.",
	_tell: "_tell is not available in this session (no agent dir configured). It cannot be used here.",
};

function toCliCommand(
	name: BuiltinCommand,
	definition: ToolDefinition<any, any, any> | undefined,
	isAvailable: () => boolean,
): CliCommandDefinition {
	const meta = META[name];
	return {
		name,
		description: meta.description,
		usage: meta.usage,
		help: getBuiltinCommandHelp(name),
		promptGuidelines: definition?.promptGuidelines,
		executionMode: definition?.executionMode,
		isAvailable: () => definition !== undefined && isAvailable(),
		unavailableReason: UNAVAILABLE[name] ?? `${name} is not available in this session.`,
		parseArguments: (args, heredoc, parseMeta) => {
			const parsed = parseBuiltinToolInput(name, args, heredoc, parseMeta);
			if (!parsed) throw new Error(`Unknown built-in command: ${name}`);
			const params = definition?.prepareArguments ? definition.prepareArguments(parsed.input) : parsed.input;
			if (definition) validateToolArguments(definition.parameters, params);
			return params;
		},
		classify: meta.classify,
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			if (!definition) throw new Error(UNAVAILABLE[name] ?? `${name} is not available in this session.`);
			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall: definition?.renderCall,
		renderResult: definition?.renderResult,
	};
}

/** Create every built-in command entry; availability is decided per call by isAvailable(). */
export function createBuiltinCliCommands(cwd: string, options: BuiltinCliCommandOptions = {}): CliCommandDefinition[] {
	const always = () => true;
	return [
		toCliCommand("_read", createReadToolDefinition(cwd, options.read), always),
		toCliCommand("_write", createWriteToolDefinition(cwd, options.write), always),
		toCliCommand("_edit", createEditToolDefinition(cwd, options.edit), always),
		toCliCommand("_session_split", createSessionSplitToolDefinition(), always),
		toCliCommand("_history_tree", createHistoryTreeToolDefinition(), always),
		toCliCommand(
			"_skill",
			options.skill ? createSkillToolDefinition(options.skill) : undefined,
			() => (options.skill?.getSkills().length ?? 0) > 0,
		),
		toCliCommand("_cron", options.cron ? createCronToolDefinition(options.cron) : undefined, always),
		toCliCommand("_tell", options.tell ? createTellToolDefinition(options.tell) : undefined, always),
	];
}
