/**
 * `pizza sessions` — list saved sessions from the CLI.
 *
 * Sessions already power `--continue`, `--rewind`, and the TUI history tree,
 * but were not inspectable without starting the TUI. This command exposes the
 * existing session index as a small, scriptable inventory:
 *
 *   pizza sessions                 current workspace, newest first
 *   pizza sessions --all           every workspace known to the agent dir
 *   pizza sessions --json          stable JSON for scripts
 *
 * It intentionally reads the same event-store projection as the TUI so it
 * never introduces a second source of truth.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "./config.js";
import {
	listAllSessions,
	listWorkspaceSessions,
	type SessionListInfo,
} from "./core/session/session-listing.js";

export const DEFAULT_SESSION_LIMIT = 20;
const SESSION_ID_DISPLAY_LENGTH = 12;
const PROJECT_COLUMN_WIDTH = 30;
const TITLE_COLUMN_WIDTH = 64;

export interface SessionsOptions {
	/** List sessions from every workspace, not just `cwd`. */
	all: boolean;
	/** Emit a JSON array instead of a table. */
	json: boolean;
	/** Maximum rows to print. 0 means no limit. */
	limit: number;
	/** Workspace directory whose sessions should be listed. */
	cwd: string;
}

export class SessionsUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionsUsageError";
	}
}

export interface SessionJson {
	id: string;
	name: string | null;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	preview: string;
	ref: string;
}

function requireValue(args: readonly string[], index: number, flag: string): string {
	const value = args[index];
	if (value === undefined || value.startsWith("-")) {
		throw new SessionsUsageError(`${flag} requires a value`);
	}
	return value;
}

/** Parse arguments for the `sessions` subcommand. */
export function parseSessionsArgs(args: readonly string[], cwd: string = process.cwd()): SessionsOptions {
	let all = false;
	let json = false;
	let limit = DEFAULT_SESSION_LIMIT;
	let selectedCwd = cwd;
	let cwdExplicit = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--all" || arg === "-a") {
			all = true;
		} else if (arg === "--json") {
			json = true;
		} else if (arg === "--limit") {
			const raw = args[++i];
			if (raw === undefined) {
				throw new SessionsUsageError("--limit requires a value");
			}
			const parsed = Number(raw);
			if (!Number.isInteger(parsed) || parsed < 0) {
				throw new SessionsUsageError(`--limit must be a non-negative integer, got "${raw}"`);
			}
			limit = parsed;
		} else if (arg === "--cwd") {
			selectedCwd = requireValue(args, ++i, "--cwd");
			cwdExplicit = true;
		} else {
			throw new SessionsUsageError(`unknown option "${arg}"`);
		}
	}

	if (all && cwdExplicit) {
		throw new SessionsUsageError("--all cannot be combined with --cwd");
	}

	selectedCwd = resolve(cwd, selectedCwd);
	let isDirectory = false;
	try {
		isDirectory = statSync(selectedCwd).isDirectory();
	} catch {
		throw new SessionsUsageError(`workspace directory not found: ${selectedCwd}`);
	}
	if (!isDirectory) {
		throw new SessionsUsageError(`workspace path is not a directory: ${selectedCwd}`);
	}

	return { all, json, limit, cwd: selectedCwd };
}

/** Read the sessions selected by `options` from the event-store index. */
export async function collectSessions(
	options: SessionsOptions,
	agentDir: string = getAgentDir(),
): Promise<SessionListInfo[]> {
	return options.all
		? listAllSessions(agentDir)
		: listWorkspaceSessions(options.cwd, agentDir);
}

/** Human-readable age, e.g. "just now", "5m ago", "3d ago". */
export function formatRelativeTime(date: Date, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
	if (seconds < 60) return "just now";

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;

	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;

	return `${Math.floor(months / 12)}y ago`;
}

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stripTerminalControls(value: string): string {
	return value
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function sessionTitle(session: SessionListInfo): string {
	const raw = session.name?.trim() || session.firstMessage.trim() || "(untitled)";
	const clean = stripTerminalControls(raw).replace(/\s+/g, " ").trim();
	return truncate(clean || "(untitled)", TITLE_COLUMN_WIDTH);
}

/** Build the plain-text table used by `pizza sessions` (no ANSI codes). */
export function formatSessionsTable(
	sessions: readonly SessionListInfo[],
	options: { all?: boolean; now?: number } = {},
): string {
	const now = options.now ?? Date.now();
	const showProject = options.all === true;

	const header = [
		...(showProject ? ["PROJECT".padEnd(PROJECT_COLUMN_WIDTH)] : []),
		"ID".padEnd(SESSION_ID_DISPLAY_LENGTH),
		"UPDATED".padEnd(9),
		"MSGS".padStart(4),
		"TITLE",
	].join("  ");

	const rows = sessions.map((session) => {
		const project = showProject
			? truncate(session.cwd.replace(/\\/g, "/"), PROJECT_COLUMN_WIDTH).padEnd(PROJECT_COLUMN_WIDTH)
			: undefined;
		const id = session.id.slice(0, SESSION_ID_DISPLAY_LENGTH).padEnd(SESSION_ID_DISPLAY_LENGTH);
		const updated = formatRelativeTime(session.modified, now).padEnd(9);
		const messages = String(session.messageCount).padStart(4);
		return [...(project ? [project] : []), id, updated, messages, sessionTitle(session)].join("  ");
	});

	return [header, ...rows].join("\n");
}

/** Convert sessions to the stable JSON shape emitted by `--json`. */
export function sessionsToJson(sessions: readonly SessionListInfo[]): SessionJson[] {
	return sessions.map((session) => ({
		id: session.id,
		name: session.name ?? null,
		cwd: session.cwd,
		createdAt: session.created.toISOString(),
		updatedAt: session.modified.toISOString(),
		messageCount: session.messageCount,
		preview: session.firstMessage === "(no messages)" ? "" : session.firstMessage,
		ref: session.path,
	}));
}

function printSessionsHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} sessions`)} — list saved sessions

${chalk.bold("Usage:")}
  ${APP_NAME} sessions [options]

${chalk.bold("Options:")}
  -a, --all          List sessions from every known workspace
      --cwd <path>   Workspace to inspect (default: current directory)
      --limit <n>    Maximum sessions to print (default: ${DEFAULT_SESSION_LIMIT}, 0 = all)
      --json         Print a machine-readable JSON array
  -h, --help         Show this help

${chalk.bold("Examples:")}
  ${APP_NAME} sessions
  ${APP_NAME} sessions --all --limit 0
  ${APP_NAME} sessions --json

Session IDs are accepted by \`${APP_NAME} --rewind <id>\`.`);
}

/** Entry point for `pizza sessions`; returns false for other commands. */
export async function handleSessionsCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "sessions") return false;

	const commandArgs = args.slice(1);
	if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
		printSessionsHelp();
		return true;
	}

	let options: SessionsOptions;
	try {
		options = parseSessionsArgs(commandArgs);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		console.error(chalk.dim(`Run \`${APP_NAME} sessions --help\` for usage.`));
		process.exitCode = 1;
		return true;
	}

	let sessions: SessionListInfo[];
	try {
		sessions = await collectSessions(options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Failed to list sessions: ${message}`));
		process.exitCode = 1;
		return true;
	}

	const shown = options.limit === 0 ? sessions : sessions.slice(0, options.limit);

	if (options.json) {
		console.log(JSON.stringify(sessionsToJson(shown), null, 2));
		return true;
	}

	if (shown.length === 0) {
		if (options.all) {
			console.log("No sessions found.");
		} else {
			console.log(`No sessions found for ${options.cwd}.`);
			console.log(chalk.dim(`Run \`${APP_NAME} sessions --all\` to list sessions from every workspace.`));
		}
		return true;
	}

	console.log(formatSessionsTable(shown, { all: options.all }));
	if (shown.length < sessions.length) {
		console.log(
			chalk.dim(`\nShowing ${shown.length} of ${sessions.length} sessions. Use --limit 0 to show all.`),
		);
	}
	return true;
}
