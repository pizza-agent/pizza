/**
 * Built-in CLI commands for file operations.
 * These are exposed to the LLM via the cli tool.
 *
 * Supports heredoc syntax for multi-line content:
 *   write <path> <<EOF
 *   line1
 *   line2
 *   EOF
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, join } from "path";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.js";
import { annotateTextWithLineAnchors } from "./line-anchors.js";
import { truncateHead } from "./truncate.js";
import { splitShellWords, splitShellWordsWithMeta } from "../exec/shell-words.js";

export interface BuiltinCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

// ============================================================================
// Heredoc Parser
// ============================================================================

export interface ParsedBuiltinCommand {
	command: string;
	args: string[];
	heredoc?: string;
	/**
	 * How many " / ' characters the shell-word splitter consumed as QUOTING
	 * (rather than kept literally) while tokenizing `args`. Used to detect the
	 * "quote stripping" footgun: when a positional value is reconstructed from
	 * multiple words AND quotes were consumed, the caller almost certainly meant
	 * the quote characters literally but they were silently dropped.
	 */
	quoteDelimitersConsumed?: number;
}

export type ParsedBuiltinToolInput =
	| {
			command: "read";
			input: { path: string; offset?: number; limit?: number; anchors?: "line" | "none" };
	  }
	| {
			command: "write";
			input: { path: string; content: string };
	  }
	| {
			command: "edit";
			input: { path: string; edits: Edit[] };
	  }
	| {
			command: "session_split";
			input: { reason?: string; name?: string };
	  }
	| {
			command: "history_tree";
			input: {
				action: "list" | "view" | "jump" | "fork";
				session_id?: string;
				query?: string;
				max_messages?: number;
				reason?: string;
			};
	  }
	| {
			command: "skill";
			input: {
				action: "list" | "load" | "read";
				name?: string;
				query?: string;
				file?: string;
			};
	  }
	  |
		{
			command: "cron";
			input: {
				action: "list" | "show" | "create" | "update" | "pause" | "resume" | "delete" | "run";
				taskId?: string;
				schedule?: string;
				cronExpr?: string;
				prompt?: string;
				name?: string;
				once?: boolean;
				newSession?: boolean;
				verbose?: boolean;
				all?: boolean;
				maxRuns?: number;
			};
	  }
	  |
		{
			command: "tell";
			input: {
				action: "send" | "list";
				to?: string;
				message?: string;
				timeout?: number;
				asyncSend?: boolean;
			};
	  };

/**
 * Map a built-in command token (what the user/LLM types, e.g. "_read") to its
 * stable internal id (e.g. "read"). Returns null when the token is not a
 * recognized built-in. The token is always the leading-underscore form so it
 * never collides with a real shell command/builtin.
 */
function builtinTokenToId(token: string): string | null {
	const lower = token.toLowerCase();
	if ((BUILTIN_COMMANDS as readonly string[]).includes(lower)) {
		return lower.slice(1);
	}
	return null;
}

/**
 * Parse builtin command with optional heredoc.
 * Supports:
 *   write <path> <<EOF       (also <<'EOF' / <<"EOF")
 *   line1
 *   line2
 *   EOF
 */
export function parseBuiltinCommandWithHeredoc(input: string): ParsedBuiltinCommand | null {
	const trimmed = input.trim();
	
	// Match: command args <<['"]DELIM\ncontent\nDELIM
	// Group 1 = prefix, group 2 = optional opening quote, group 3 = delimiter
	// word, group 4 = content. Supports <<EOF, <<'EOF', and <<"EOF". The
	// closing delimiter is always the bare word (shell semantics).
	const heredocMatch = trimmed.match(/^(.*?)\s+<<\s*(['"]?)(\w+)\2\s*\n([\s\S]*)\n\3\s*$/);
	if (!heredocMatch) {
		return null;
	}
	
	const [, prefix, , , content] = heredocMatch;
	const { words: parts, meta } = splitShellWordsWithMeta(prefix.trim());

	return {
		command: parts[0],
		args: parts.slice(1),
		heredoc: content,
		quoteDelimitersConsumed: meta.quoteDelimitersConsumed,
	};
}

export function parseBuiltinCommand(input: string): ParsedBuiltinCommand {
	const parsedHeredoc = parseBuiltinCommandWithHeredoc(input);
	if (parsedHeredoc) {
		return parsedHeredoc;
	}
	const { words: parts, meta } = splitShellWordsWithMeta(input.trim());
	return {
		command: parts[0] ?? "",
		args: parts.slice(1),
		quoteDelimitersConsumed: meta.quoteDelimitersConsumed,
	};
}

interface ParseBuiltinToolInputOptions {
	/**
	 * Quote-delimiter count from the shell-word splitter (see ParsedBuiltinCommand).
	 * When set, edit/write reject a positional value that was reconstructed from
	 * MULTIPLE words while quotes were consumed — that pattern silently strips the
	 * quote characters the caller meant literally (the classic LLM footgun:
	 * `secret("X", "Y")` → `secret(X, Y)`).
	 */
	quoteDelimitersConsumed?: number;
}

export function parseBuiltinToolInput(
	command: string,
	args: string[],
	heredoc?: string,
	options?: ParseBuiltinToolInputOptions,
): ParsedBuiltinToolInput | null {
	const id = builtinTokenToId(command);
	if (!id) return null;
	switch (id) {
		case "read":
			return { command: "read", input: parseReadInput(args) };
		case "write":
			return { command: "write", input: parseWriteInput(args, heredoc, options) };
		case "edit":
			return { command: "edit", input: parseEditInput(args, options) };
		case "session_split":
			return { command: "session_split", input: parseSessionSplitInput(args) };
		case "history_tree":
			return { command: "history_tree", input: parseHistoryTreeInput(args) };
		case "skill":
			return { command: "skill", input: parseSkillInput(args) };
		case "cron":
			return { command: "cron", input: parseCronInput(args, heredoc) };
		case "tell":
			return { command: "tell", input: parseTellInput(args, heredoc) };
		default:
			return null;
	}
}

/**
 * Detect the "positional value got its quotes silently stripped" corruption.
 *
 * The shell-word splitter treats `"` / `'` as QUOTING. So a positional argument
 * written WITHOUT an enclosing pair of quotes — e.g. the `new` text
 * `secret("SESSION_TOKEN", "dev")` — has its inner quotes consumed as quoting
 * and dropped, and the surviving fragments get rejoined into a WRONG value.
 *
 * We can't know intent perfectly, but the reliable signature of this exact
 * failure is: the positional value was reconstructed from MORE THAN ONE word,
 * AND the splitter consumed at least one quote delimiter somewhere in the args.
 * A correctly-quoted value (`"hello world"`) yields a single word, so this
 * never fires on well-formed input.
 *
 * Throws a guided error so the caller retries with `--new`, `--edits` JSON,
 * or a heredoc — all of which preserve quotes/whitespace verbatim.
 */
function assertPositionalValueNotQuoteStripped(
	reconstructedFromWordCount: number,
	quoteDelimitersConsumed: number | undefined,
	kind: "new" | "content",
): void {
	if (reconstructedFromWordCount > 1 && (quoteDelimitersConsumed ?? 0) > 0) {
		// Give a concrete, copy-pasteable rewrite so the caller doesn't have to
		// re-derive the verbatim form (and risk the same escaping mistake again).
		const fix = kind === "new"
			? "_edit <path> --edits '[{\"op\":\"replace\",\"range\":\"<range>\",\"new\":\"<value with quotes kept as \\\">\"}]'  (or --new '<value>')"
			: "_write <path> --content '<value>'  (or a <<EOF heredoc)";
		throw new Error(
			`edit/write: the positional ${kind} value looks quote-stripped — its inner " or ' were ` +
				`treated as shell quoting and dropped (reconstructed from ${reconstructedFromWordCount} words). ` +
				`Values with quotes/spaces/newlines are ambiguous in positional form. ` +
				`Re-issue through a verbatim channel, e.g.:\n  ${fix}`,
		);
	}
}

function parseReadInput(args: string[]): { path: string; offset?: number; limit?: number; anchors?: "line" | "none" } {
	let path = "";
	let offset: number | undefined;
	let limit: number | undefined;
	let anchors: "line" | "none" | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--offset" || arg === "-o") {
			offset = parseOptionalInt(args[++i]);
		} else if (arg === "--limit" || arg === "-l") {
			limit = parseOptionalInt(args[++i]);
		} else if (arg === "--anchors") {
			const value = args[++i];
			if (value !== "line" && value !== "none") {
				throw new Error('read --anchors must be "line" or "none"');
			}
			anchors = value;
		} else if (arg === "--raw") {
			anchors = "none";
		} else if (!path) {
			path = arg;
		} else if (offset === undefined) {
			offset = parseOptionalInt(arg);
		} else if (limit === undefined) {
			limit = parseOptionalInt(arg);
		}
	}

	return { path, offset, limit, anchors };
}

function parseWriteInput(
	args: string[],
	heredoc?: string,
	options?: ParseBuiltinToolInputOptions,
): { path: string; content: string } {
	let path = "";
	let content: string | undefined = heredoc;
	const positionalContent: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--content" || arg === "-c") {
			content = args[++i] ?? "";
		} else if (!path) {
			path = arg;
		} else if (content === undefined) {
			positionalContent.push(arg);
		}
	}

	if (content === undefined) {
		// Positional content reconstructed from multiple words — guard against
		// the quote-stripping footgun before joining.
		assertPositionalValueNotQuoteStripped(
			positionalContent.length,
			options?.quoteDelimitersConsumed,
			"content",
		);
		content = positionalContent.join(" ");
	}

	return { path, content };
}

function parseSessionSplitInput(args: string[]): { reason?: string; name?: string } {
	let reason: string | undefined;
	let name: string | undefined;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--reason" || arg === "-r") {
			reason = args[++i];
		} else if (arg === "--name" || arg === "-n") {
			name = args[++i];
		} else {
			positional.push(arg);
		}
	}

	if (positional.length > 0 && reason === undefined) {
		reason = positional[0];
		if (positional.length > 1 && name === undefined) {
			name = positional.slice(1).join(" ");
		}
	}

	return { reason, name };
}

const HISTORY_TREE_ACTIONS = ["list", "view", "jump", "fork"] as const;
type HistoryTreeAction = (typeof HISTORY_TREE_ACTIONS)[number];

function parseHistoryTreeInput(args: string[]): {
	action: HistoryTreeAction;
	session_id?: string;
	query?: string;
	max_messages?: number;
	reason?: string;
} {
	let action: HistoryTreeAction | undefined;
	let sessionId: string | undefined;
	let query: string | undefined;
	let maxMessages: number | undefined;
	let reason: string | undefined;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--session" || arg === "-s") {
			sessionId = args[++i];
		} else if (arg === "--query" || arg === "-q") {
			query = args[++i];
		} else if (arg === "--max-messages" || arg === "-m") {
			maxMessages = parseOptionalInt(args[++i]);
		} else if (arg === "--reason" || arg === "-r") {
			reason = args[++i];
		} else {
			positional.push(arg);
		}
	}

	if (positional.length > 0 && action === undefined) {
		const candidate = positional[0].toLowerCase();
		if (!HISTORY_TREE_ACTIONS.includes(candidate as HistoryTreeAction)) {
			throw new Error(`history_tree: unknown action "${positional[0]}". Valid actions: ${HISTORY_TREE_ACTIONS.join(", ")}`);
		}
		action = candidate as HistoryTreeAction;
		if (positional.length > 1 && sessionId === undefined) {
			sessionId = positional[1];
		}
	}

	if (!action) {
		throw new Error(`history_tree: action required. Valid actions: ${HISTORY_TREE_ACTIONS.join(", ")}`);
	}

	return { action, session_id: sessionId, query, max_messages: maxMessages, reason };
}

const TELL_ACTIONS = ["send", "list"] as const;
type TellAction = (typeof TELL_ACTIONS)[number];

/**
 * Parse the `tell` command args:
 *   tell send <to> <message>
 *   tell send --to <cwd|name> --message "..." [--timeout N]
 *   tell list
 *
 * For `send`, the first positional after the action is the destination (`to`)
 * and the rest is joined into the message. `--to` / `--message` flags override
 * the positionals. A heredoc (when present) supplies the message for `send`.
 */
export function parseTellInput(args: string[], heredoc?: string): {
	action: TellAction;
	to?: string;
	message?: string;
	timeout?: number;
	asyncSend?: boolean;
} {
	let action: TellAction | undefined;
	let to: string | undefined;
	let message: string | undefined;
	let timeout: number | undefined;
	let asyncSend: boolean | undefined;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--to" || arg === "-t") {
			to = args[++i];
		} else if (arg === "--message" || arg === "-m") {
			message = args[++i];
		} else if (arg === "--timeout") {
			timeout = parseOptionalInt(args[++i]);
		} else if (arg === "--async") {
			asyncSend = true;
		} else {
			positional.push(arg);
		}
	}

	if (positional.length > 0 && action === undefined) {
		const candidate = positional[0].toLowerCase();
		if (!TELL_ACTIONS.includes(candidate as TellAction)) {
			throw new Error(
				`tell: unknown action "${positional[0]}". Valid actions: ${TELL_ACTIONS.join(", ")}`,
			);
		}
		action = candidate as TellAction;
	}

	if (!action) {
		throw new Error(`tell: action required. Valid actions: ${TELL_ACTIONS.join(", ")}`);
	}

	// For `send`, the remaining positionals are <to> <message...>.
	if (action === "send") {
		// Positional form: `tell send <to> <message...>`. When `--to` was given
		// as a flag, every positional after the action belongs to the message —
		// slicing off the first one would silently swallow its first word.
		const rest = positional.slice(1);
		let toFromPositional = false;
		if (to === undefined && rest.length > 0) {
			to = rest[0];
			toFromPositional = true;
		}
		if (message === undefined) {
			if (toFromPositional) {
				// `<to>` came from a positional; the message starts after it.
				if (rest.length > 1) {
					message = rest.slice(1).join(" ");
				}
			} else if (rest.length > 0) {
				// `--to` flag form: ALL positionals are the message.
				message = rest.join(" ");
			}
			if (message === undefined && heredoc !== undefined) {
				message = heredoc;
			}
		}
	}

	return { action, to, message, timeout, asyncSend };
}

function parseSkillInput(args: string[]): {
	action: "list" | "load" | "read";
	name?: string;
	query?: string;
	file?: string;
} {
	let action: "list" | "load" | "read" | undefined;
	let name: string | undefined;
	let query: string | undefined;
	let file: string | undefined;
	const positional: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--name" || arg === "-n") {
			name = args[++i];
		} else if (arg === "--query" || arg === "-q") {
			query = args[++i];
		} else if (arg === "--file" || arg === "-f") {
			file = args[++i];
		} else {
			positional.push(arg);
		}
	}

	if (positional.length > 0 && action === undefined) {
		const candidate = positional[0].toLowerCase();
		if (candidate === "list" || candidate === "load" || candidate === "read") {
			action = candidate;
		} else {
			throw new Error(
				`skill: unknown action "${positional[0]}". Valid actions: list, load, read`,
			);
		}
	}

	if (!action) {
		throw new Error(`skill: action required. Valid actions: list, load, read`);
	}

	// For load: positional[1] is the skill name.
	// For read: positional[1] is the skill name, positional[2] is the file.
	if (action === "load") {
		if (name === undefined && positional.length > 1) {
			name = positional[1];
		}
	} else if (action === "read") {
		if (name === undefined && positional.length > 1) {
			name = positional[1];
		}
		if (file === undefined && positional.length > 2) {
			file = positional[2];
		}
	}

	return { action, name, query, file };
}

const CRON_ACTIONS = ["list", "show", "create", "update", "pause", "resume", "delete", "run"] as const;
type CronAction = (typeof CRON_ACTIONS)[number];

/**
 * Parse the `cron` command args:
 *   cron list [--verbose]
 *   cron show <taskId>
 *   cron create --schedule "30m" --prompt "..." [--name "..."] [--cron-expr "..."] [--once] [--new-session]
 *   cron update --task <id> [--schedule "30m" | --cron-expr "..."] [--prompt "..."] [--name "..."]
 *   cron pause <taskId>
 *   cron resume <taskId>
 *   cron delete <taskId>
 *   cron run <taskId>
 *
 * `--prompt` may be supplied positionally (the trailing words after the action
 * for create), but a prompt with spaces/newlines is ambiguous in positional
 * form. Callers should prefer --prompt or a <<EOF heredoc (which lands in the
 * `heredoc` argument and is folded into prompt when present).
 */
function parseCronInput(args: string[], heredoc?: string): {
	action: CronAction;
	taskId?: string;
	schedule?: string;
	cronExpr?: string;
	prompt?: string;
	name?: string;
	once?: boolean;
	newSession?: boolean;
	verbose?: boolean;
	all?: boolean;
	maxRuns?: number;
} {
	let action: CronAction | undefined;
	let taskId: string | undefined;
	let schedule: string | undefined;
	let cronExpr: string | undefined;
	let prompt: string | undefined;
	let name: string | undefined;
	let once: boolean | undefined;
	let newSession: boolean | undefined;
	let verbose: boolean | undefined;
	let all: boolean | undefined;
	let maxRuns: number | undefined;
	const positionalPrompt: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--schedule" || arg === "-s") {
			schedule = args[++i];
		} else if (arg === "--cron-expr" || arg === "--cron") {
			cronExpr = args[++i];
		} else if (arg === "--prompt" || arg === "-p") {
			prompt = args[++i];
		} else if (arg === "--name" || arg === "-n") {
			name = args[++i];
		} else if (arg === "--task" || arg === "--task-id" || arg === "-t") {
			taskId = args[++i];
		} else if (arg === "--once") {
			once = true;
		} else if (arg === "--new-session") {
			newSession = true;
		} else if (arg === "--verbose" || arg === "-v") {
			verbose = true;
		} else if (arg === "--all") {
			all = true;
		} else if (arg === "--max-runs") {
			const raw = args[++i];
			const parsed = raw === undefined ? Number.NaN : Number(raw);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw new Error(`cron: --max-runs expects a non-negative number, got "${raw}"`);
			}
			maxRuns = parsed;
		} else {
			positionalPrompt.push(arg);
		}
	}

	if (positionalPrompt.length > 0 && action === undefined) {
		const candidate = positionalPrompt[0]!.toLowerCase();
		if ((CRON_ACTIONS as readonly string[]).includes(candidate)) {
			action = candidate as CronAction;
		} else {
			throw new Error(`cron: unknown action "${positionalPrompt[0]}". Valid actions: ${CRON_ACTIONS.join(", ")}`);
		}
	}

	// After the action word, the next positional is the taskId for the
	// single-arg actions (pause/resume/delete/run). For create, trailing
	// positionals become the prompt (joined) when --prompt was not given.
	if (action !== undefined && action !== "create" && action !== "list") {
		if (taskId === undefined && positionalPrompt.length > 1) {
			taskId = positionalPrompt[1];
		}
		// update may change the prompt via --prompt or a heredoc; trailing positionals
		// are not interpreted as a prompt body (unlike create).
		if (action === "update" && prompt === undefined && heredoc !== undefined) {
			prompt = heredoc;
		}
	} else if (action === "create") {
		if (prompt === undefined) {
			if (positionalPrompt.length > 1) {
				prompt = positionalPrompt.slice(1).join(" ");
			} else if (heredoc !== undefined) {
				prompt = heredoc;
			}
		} else if (heredoc !== undefined && prompt.trim() === "") {
			prompt = heredoc;
		}
	}

	if (!action) {
		throw new Error(`cron: action required. Valid actions: ${CRON_ACTIONS.join(", ")}`);
	}

	return { action, taskId, schedule, cronExpr, prompt, name, once, newSession, verbose, all, maxRuns };
}

function parseEditInput(
	args: string[],
	options?: ParseBuiltinToolInputOptions,
): { path: string; edits: Edit[] } {
	let path = "";
	let editsJson: string | undefined;
	const edits: Edit[] = [];
	const positional: string[] = [];
	let op: Edit["op"] | undefined;
	let range: string | undefined;
	let oldValue: string | undefined;
	let newValue: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--path" || arg === "-p") {
			path = args[++i] ?? "";
		} else if (arg === "--edits" || arg === "-e") {
			editsJson = args[++i] ?? "[]";
		} else if (arg === "--op") {
			op = parseEditOp(args[++i] ?? "");
		} else if (arg === "--old" || arg === "-o") {
			oldValue = args[++i] ?? "";
		} else if (arg === "--range-id" || arg === "--rangeId") {
			throw new Error("edit no longer supports --range-id. Use --range.");
		} else if (arg === "--range" || arg === "-r") {
			range = args[++i] ?? "";
		} else if (arg === "--new" || arg === "-n") {
			newValue = args[++i] ?? "";
		} else if (!path) {
			path = arg;
		} else {
			positional.push(arg);
		}
	}

	if (editsJson !== undefined) {
		const parsed = JSON.parse(editsJson) as unknown;
		if (!Array.isArray(parsed)) {
			throw new Error("edit --edits must be a JSON array");
		}
		for (const entry of parsed) {
			edits.push(parseEditEntry(entry));
		}
	}

	if (edits.length === 0) {
		if (op === "search") {
			edits.push(buildSearchEdit(oldValue, newValue));
		} else if (op !== undefined || range !== undefined) {
			edits.push(buildEditFromParts(op, range, newValue));
		} else if (positional.length >= 2) {
			const parsedOp = parseEditOp(positional[0] ?? "");
			// The positional new value is the words after op+range/old, rejoined.
			// Guard against quote-stripping before we join them.
			assertPositionalValueNotQuoteStripped(
				positional.slice(2).length,
				options?.quoteDelimitersConsumed,
				"new",
			);
			if (parsedOp === "search") {
				edits.push(buildSearchEdit(positional[1], positional.slice(2).join(" ")));
			} else {
				edits.push(buildEditFromParts(parsedOp, positional[1], positional.slice(2).join(" ")));
			}
		}
	}

	return { path, edits };
}

function parseEditOp(value: string): Edit["op"] {
	if (value === "replace" || value === "insert_before" || value === "insert_after" || value === "delete" || value === "search") {
		return value;
	}
	throw new Error("edit op must be one of: replace, insert_before, insert_after, delete, search");
}

function parseEditEntry(entry: unknown): Edit {
	if (!entry || typeof entry !== "object") {
		throw new Error('edit --edits entries must be objects with op, range, and new (unless op is "delete" or "search")');
	}
	const record = entry as Record<string, unknown>;
	const op = parseEditOp(String(record.op ?? ""));
	if (op === "search") {
		return buildSearchEdit(
			typeof record.old === "string" ? record.old : undefined,
			typeof record.new === "string" ? record.new : undefined,
		);
	}
	return buildEditFromParts(
		op as AnchorEditOp,
		typeof record.range === "string" ? record.range : undefined,
		typeof record.new === "string" ? record.new : undefined,
	);
}

function buildSearchEdit(oldValue: string | undefined, newValue: string | undefined): Edit {
	if (typeof oldValue !== "string") {
		throw new Error('edit search requires --old (the text to search for in the file)');
	}
	if (typeof newValue !== "string") {
		throw new Error('edit search requires --new (the replacement text)');
	}
	return { op: "search", old: oldValue, new: newValue };
}

type AnchorEditOp = "replace" | "insert_before" | "insert_after" | "delete";

function buildEditFromParts(op: AnchorEditOp | undefined, range: string | undefined, newValue: string | undefined): Edit {
	if (!op) {
		throw new Error("edit requires --op");
	}
	if (typeof range !== "string") {
		throw new Error("edit requires --range");
	}
	if (op === "delete") {
		return { op, range };
	}
	if (typeof newValue !== "string") {
		throw new Error('edit requires --new unless --op is "delete"');
	}
	return { op, range, new: newValue };
}

function parseOptionalInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function isHelpRequest(args: string[]): boolean {
	if (args.length !== 1) return false;
	const value = args[0]?.toLowerCase();
	return value === "-h" || value === "--help" || value === "help";
}

export function getBuiltinCommandHelp(command: string): string | undefined {
	const id = builtinTokenToId(command);
	if (!id) return undefined;
	switch (id) {
		case "read":
			return [
				"_read - Read a file",
				"",
				"Description:",
				"  Reads a text file or supported image file from the current working directory.",
				"  Text output includes 2-hex hashline anchors by default: <line>#<hash> | content.",
				"  Use those anchors as edit range values. Images are returned as image content",
				"  when routed through the cli tool's built-in read implementation.",
				"",
				"Parameters:",
				"  path              File path to read. Relative paths are resolved from the working directory.",
				"  offset            Optional 1-based line number to start reading from.",
				"  limit             Optional maximum number of lines to return.",
				"  --path, -p        File path to read.",
				"  --offset, -o      1-based line number to start reading from.",
				"  --limit, -l       Maximum number of lines to return.",
				"  --anchors         line or none. Defaults to line.",
				"  --raw             Alias for --anchors none.",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  _read src/main.ts",
				"  _read src/main.ts 20",
				"  _read src/main.ts 20 50",
				"  _read --path src/main.ts --offset 20 --limit 50",
				"  _read -p src/main.ts -o 20 -l 50",
				"  _read --path src/main.ts --anchors none",
			].join("\n");
		case "write":
			return [
				"_write - Create or overwrite a file",
				"",
				"Description:",
				"  Writes complete content to a file. Creates parent directories when needed.",
				"  If the target file already exists, it is overwritten.",
				"",
				"Parameters:",
				"  path              Target file path. Relative paths are resolved from the working directory.",
				"  content           Complete file content to write.",
				"  --path, -p        Target file path.",
				"  --content, -c     Complete file content to write.",
				"  <<EOF             Heredoc form for multi-line content (PREFER this or -c for any",
				"                    value with quotes, multiple spaces, or newlines).",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  _write notes.txt hello",
				"  _write --path notes.txt --content \"hello world\"",
				"  _write -p notes.txt -c \"hello world\"",
				"  _write src/generated.ts <<EOF",
				"  export const value = 1;",
				"  EOF",
			].join("\n");
		case "edit":
			return [
				"_edit - Edit a file with read range anchors or search-and-replace",
				"",
				"Description:",
				"  Edits one existing file. Two modes are supported:",
				"  1. Anchor mode: use hashline ranges from read output (replace, insert_before,",
				"     insert_after, delete). Ranges fail safely if lines changed or became ambiguous.",
				"  2. Search mode: use op=search to find and replace exact text without line anchors.",
				"     The search text must match exactly one location in the file. Use this as a",
				"     fallback when you don't have fresh line anchors (e.g. after using sed/cat).",
				"",
				"Parameters:",
				"  path              File path to edit. Relative paths are resolved from the working directory.",
				"  op                replace, insert_before, insert_after, delete, or search.",
				"  range             Line anchor or range from read output, e.g. 12#ab or 12#ab..14#de.",
				"  old               Text to search for (only for op=search). Must match exactly one location.",
				"  new               New text for replace, insert, and search operations. Omit for delete.",
				"  --path, -p        File path to edit.",
				"  --op              Edit operation.",
				"  --range, -r       Line anchor or range from read output.",
				"  --old, -o         Text to search for (only for op=search).",
				"  --new, -n         New text for replace, insert, and search operations.",
				"  --edits, -e       JSON array of edit objects. PREFER this for any value that contains",
				"                    quotes, multiple spaces, or newlines — positional `new` silently drops",
				"                    unquoted inner \" or ' and is rejected when it looks stripped.",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  _read src/app.ts",
				"  _edit src/app.ts replace 12#ab \"const a = 2\"",
				"  _edit --path src/app.ts --op insert_after --range 12#ab --new \"const b = 3\"",
				"  _edit --path src/app.ts --op delete --range 12#ab..14#de",
				"  _edit --path src/app.ts --op search --old \"const a = 1\" --new \"const a = 2\"",
				"  _edit src/app.ts search \"const a = 1\" \"const a = 2\"",
				"  _edit --path src/app.ts --edits '[{\"op\":\"replace\",\"range\":\"12#ab\",\"new\":\"const a = 2\"}]'",
				"  _edit --path src/app.ts --edits '[{\"op\":\"search\",\"old\":\"const a = 1\",\"new\":\"const a = 2\"}]'",
			].join("\n");
		case "session_split":
			return [
				"_session_split - Split the current conversation session",
				"",
				"Description:",
				"  Start a new session from the current point. Previous messages are no longer",
				"  included in the LLM context for subsequent turns. Use this when the user's",
				"  intent has clearly shifted to a new, unrelated topic.",
				"",
				"Parameters:",
				"  reason            Short reason for the split (e.g. 'topic_change', 'new_task', 'context_reset').",
				"  name              Optional name for the new session (e.g. 'Fix authentication bug').",
				"  --reason, -r      Split reason.",
				"  --name, -n        New session name.",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  _session_split topic_change",
				"  _session_split topic_change \"Fix auth\"",
				"  _session_split --reason topic_change --name \"Fix auth\"",
			].join("\n");
		case "history_tree":
			return [
				"_history_tree - Browse and navigate the session history tree",
				"",
				"Description:",
				"  Every past session is a node in the history tree. Use list to see the tree,",
				"  view to preview a session's messages without switching, jump to return to a",
				"  previous session and continue there, and fork to branch off from a session.",
				"",
				"Actions:",
				"  list              Show the session history tree.",
				"  view <session>    Preview a session's recent messages (no switch).",
				"  jump <session>    Switch to a session; closed sessions are reopened via fork.",
				"  fork <session>    Start a new branch from a session.",
				"",
				"Parameters:",
				"  --session, -s      Target session id (alternative to positional).",
				"  --query, -q        For list: filter on session names and first messages.",
				"  --max-messages, -m For view: max recent messages to show (default 20).",
				"  --reason, -r       For jump: short reason (recorded in the event log).",
				"  -h, --help         Show this help.",
				"",
				"Examples:",
				"  _history_tree list",
				"  _history_tree list --query \"auth bug\"",
				"  _history_tree view sess_0042",
				"  _history_tree jump sess_0042 --reason \"return to auth work\"",
				"  _history_tree fork sess_0042",
			].join("\n");
		case "skill":
			return [
				"_skill - Discover and load Agent Skills",
				"",
				"Description:",
				"  Skills provide specialized instructions for specific tasks. Use list to discover",
				"  available skills, load to read a skill's full SKILL.md instructions, and read to",
				"  access supplementary files referenced by a skill (resolved relative to the skill's",
				"  own directory, with path traversal protection).",
				"",
				"Actions:",
				"  list              Show all available skills (name, description, source, location).",
				"  load <name>       Load and return the full content of a skill's SKILL.md.",
				"  read <name> <file> Read a supplementary file from a skill's directory.",
				"",
				"Parameters:",
				"  --name, -n        Skill name (required for load and read).",
				"  --query, -q       Optional filter for list (matches name or description, case-insensitive).",
				"  --file, -f        Relative file path within a skill's directory (required for read).",
				"  -h, --help        Show this help.",
				"",
				"Examples:",
				"  _skill list",
				"  _skill list --query \"git\"",
				"  _skill load --name devin-cli",
				"  _skill load devin-cli",
				"  _skill read --name devin-cli --file docs/config.md",
				"  _skill read devin-cli docs/config.md",
			].join("\n");
		case "tell":
			return [
				"_tell - Send a message to another agent's workspace and get its reply",
				"",
				"Description:",
				"  Agent-to-agent messaging via the gateway. The gateway keeps target agents alive —",
				"  repeated tells to the same workspace are conversational: the agent remembers the context.",
				"  Only available when an agent dir is configured.",
				"",
				"Actions:",
				"  send <to> <message>  Send a message to workspace <to>; blocks until it replies.",
				"                       Add --async to deliver without blocking (the target replies on its own later).",
				"  list                 Show known workspaces you can tell to (name, cwd, workspace_id, last_accessed).",
				"",
				"Parameters:",
				"  to                 Destination workspace: a project path (cwd) or workspace name (last path component).",
				"  message            The message text to deliver to the target agent.",
				"  --to, -t           Destination workspace (alternative to positional).",
				"  --message, -m      Message text (alternative to positional).",
				"  --timeout          Timeout in milliseconds (default 120000).",
				"  --async            Deliver without blocking for the reply (symmetric messaging).",
				"  <<EOF              Heredoc form for the message (multi-line).",
				"  -h, --help         Show this help.",
				"",
				"Examples:",
				"  _tell list",
				"  _tell send --to web --message \"what's in package.json?\"",
				"  _tell send web \"fix the auth bug and summarize\"",
				"  _tell send --to ../other-project --message \"check the tests\" --timeout 60000",
				"  _tell send --async --to web --message \"build it and tell me when done\"  # non-blocking",
				"  _tell send web <<EOF",
				"  What files changed in the last commit?",
				"  EOF",
			].join("\n");
		case "cron":
			return [
				"_cron - Manage scheduled/cron jobs",
				"",
				"Description:",
				"  Schedule recurring prompts that fire on a timer. Only available when a scheduler",
				"  is running (RPC / desktop / web mode). list shows tasks (and, with --verbose, each prompt); " +
				"  show prints one task in full; create schedules one; update edits one in place; " +
				"  pause/resume toggle; delete removes; run fires it immediately.",
				"",
				"Actions:",
				"  list                 Show all scheduled tasks. Add --verbose to inline each prompt;",
				"                       add --all to include EVERY scope (main + all workspaces).",
				"  show <taskId>        Show one task in full (prompt body + complete schedule).",
				"  create               Schedule a recurring prompt (needs --schedule and --prompt).",
				"  update --task <id>   Edit a task in place. Pass --schedule/--cron-expr and/or",
				"                       --prompt/--name; fields you omit keep their current value.",
				"  pause <taskId>       Disable a task.",
				"  resume <taskId>      Re-enable a task.",
				"  delete <taskId>      Remove a task.",
				"  run <taskId>         Fire a task immediately.",
				"",
				"Parameters:",
				"  --schedule, -s     Shorthand interval, e.g. \"30m\", \"every 2h\", or cron \"0 9 * * 1-5\".",
				"  --cron-expr        Explicit 5-field cron expression (alternative to --schedule).",
				"  --prompt, -p       Task instruction dispatched on each fire (required for create).",
				"  --name, -n         Optional task name.",
				"  --task, -t         Task id (for show/update/pause/resume/delete/run).",
				"  --verbose, -v      list only: inline each task prompt body.",
				"  --all              list only: show tasks from all scopes, not just this one.",
				"  --max-runs         create/update: auto-disable after N total runs (safety cap; 0 clears).",
				"  --once             Run exactly once, then auto-disable.",
				"  --new-session      Dispatch each fire into a fresh session (default: pinned).",
				"  <<EOF              Heredoc form for --prompt (multi-line).",
				"  -h, --help         Show this help.",
				"",
				"Examples:",
				"  _cron list",
				"  _cron list --verbose",
				"  _cron list --all",
				"  _cron create --schedule 10m --max-runs 50 --prompt \"drive the refactor\" ",
				"  _cron show st_abc123",
				"  _cron create --schedule 30m --name \"self-review\" --prompt \"summarize recent changes\"",
				"  _cron create --cron-expr \"0 9 * * 1-5\" --prompt \"standup\" --new-session",
				"  _cron update --task st_abc123 --schedule \"10 10 * * *\"",
				"  _cron update --task st_abc123 --prompt \"new instructions here\"",
				"  _cron pause st_abc123",
				"  _cron run st_abc123",
				"",
			].join("\n");
		default:
			return undefined;
	}
}

export function getBuiltinCommandHelpForArgs(command: string, args: string[]): string | undefined {
	if (!isHelpRequest(args)) return undefined;
	return getBuiltinCommandHelp(command);
}

/** @deprecated Use parseBuiltinCommandWithHeredoc */
export const parseCommandWithHeredoc = parseBuiltinCommandWithHeredoc;

// ============================================================================
// Read Command
// ============================================================================

interface ReadOptions {
	path: string;
	offset?: number;
	limit?: number;
	anchors?: "line" | "none";
	cwd: string;
}

async function executeRead(options: ReadOptions): Promise<BuiltinCommandResult> {
	try {
		const filePath = resolve(options.cwd, options.path);
		const anchors = options.anchors ?? "line";
		const rawContent = await readFile(filePath, "utf-8");
		const content = anchors === "line" ? normalizeToLF(rawContent) : rawContent;
		let lines = content.split("\n");
		const totalLines = lines.length;

		// Apply offset (1-indexed)
		const startLine = options.offset && options.offset > 0 ? options.offset - 1 : 0;
		if (startLine > 0) {
			lines = lines.slice(startLine);
		}

		// Apply limit
		let userLimited = false;
		if (options.limit !== undefined && options.limit > 0) {
			lines = lines.slice(0, options.limit);
			userLimited = true;
		}

		// Apply truncation
		const truncation = truncateHead(lines.join("\n"));
		const startLineDisplay = startLine + 1;
		let output =
			anchors === "line" ? annotateTextWithLineAnchors(truncation.content, startLineDisplay) : truncation.content;

		if (truncation.truncated) {
			const endLine = startLineDisplay + truncation.outputLines - 1;
			const nextOffset = endLine + 1;
			output += `\n\n[Showing lines ${startLineDisplay}-${endLine} of ${totalLines}. Use: read ${options.path} ${nextOffset}]`;
		} else if (userLimited && startLine + lines.length < totalLines) {
			const remaining = totalLines - (startLine + lines.length);
			const nextOffset = startLine + lines.length + 1;
			output += `\n\n[${remaining} more lines. Use: read ${options.path} ${nextOffset}]`;
		}

		return {
			stdout: output,
			stderr: "",
			exitCode: 0,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: `Error reading file: ${message}`,
			exitCode: 1,
		};
	}
}

// ============================================================================
// Write Command
// ============================================================================

interface WriteOptions {
	path: string;
	content: string;
	cwd: string;
}

async function executeWrite(options: WriteOptions): Promise<BuiltinCommandResult> {
	try {
		const filePath = resolve(options.cwd, options.path);

		// Ensure parent directory exists
		const parentDir = join(filePath, "..");
		await mkdir(parentDir, { recursive: true });

		await writeFile(filePath, options.content, "utf-8");
		return {
			stdout: `File written: ${options.path}`,
			stderr: "",
			exitCode: 0,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: `Error writing file: ${message}`,
			exitCode: 1,
		};
	}
}

// ============================================================================
// Edit Command
// ============================================================================

interface EditOptions {
	path: string;
	edits: Edit[];
	cwd: string;
}

async function executeEdit(options: EditOptions): Promise<BuiltinCommandResult> {
	try {
		const filePath = resolve(options.cwd, options.path);
		const rawContent = await readFile(filePath, "utf-8");
		const { bom, text: content } = stripBom(rawContent);
		const originalEnding = detectLineEnding(content);
		const normalizedContent = normalizeToLF(content);
		const { newContent } = applyEditsToNormalizedContent(normalizedContent, options.edits, options.path);
		await writeFile(filePath, bom + restoreLineEndings(newContent, originalEnding), "utf-8");

		return {
			stdout: `File edited: ${options.path}`,
			stderr: "",
			exitCode: 0,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: `Error editing file: ${message}`,
			exitCode: 1,
		};
	}
}

// ============================================================================
// Main Router
// ============================================================================

export interface BuiltinCommandContext {
	cwd: string;
}

export async function executeBuiltinCommand(
	command: string,
	args: string[],
	context: BuiltinCommandContext,
): Promise<BuiltinCommandResult> {
	const help = getBuiltinCommandHelpForArgs(command, args);
	if (help) {
		return {
			stdout: help,
			stderr: "",
			exitCode: 0,
		};
	}

	let parsed: ParsedBuiltinToolInput | null;
	try {
		parsed = parseBuiltinToolInput(command, args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout: "",
			stderr: message,
			exitCode: 1,
		};
	}

	switch (parsed?.command) {
		case "read": {
			return executeRead({ ...parsed.input, cwd: context.cwd });
		}

		case "write": {
			return executeWrite({ ...parsed.input, cwd: context.cwd });
		}

		case "edit": {
			return executeEdit({
				path: parsed.input.path,
				edits: parsed.input.edits,
				cwd: context.cwd,
			});
		}

		case "session_split": {
			return {
				stdout: "",
				stderr: "session_split requires an active agent session context and is executed through the cli tool.",
				exitCode: 1,
			};
		}

		case "history_tree": {
			return {
				stdout: "",
				stderr: "history_tree requires an active agent session context and is executed through the cli tool.",
				exitCode: 1,
			};
		}
		case "skill": {
			return {
				stdout: "",
				stderr: "skill requires loaded skills and is executed through the cli tool.",
				exitCode: 1,
			};
		}

		case "tell": {
			return {
				stdout: "",
				stderr: "tell requires an agent dir and is executed through the cli tool.",
				exitCode: 1,
			};
		}

		case "cron": {
			return {
				stdout: "",
				stderr: "cron requires a running scheduler and is executed through the cli tool.",
				exitCode: 1,
			};
		}

		default:
			return {
				stdout: "",
				stderr: `Unknown builtin command: ${command}. Available commands: ${BUILTIN_COMMANDS.join(", ")}`,
				exitCode: 1,
			};
	}
}

export const BUILTIN_COMMANDS = ["_read", "_write", "_edit", "_session_split", "_history_tree", "_skill", "_cron", "_tell"] as const;
export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

// ============================================================================
// Deprecated aliases (for backward compatibility)
// ============================================================================

/** @deprecated Use BuiltinCommandResult */
export type NativeCommandResult = BuiltinCommandResult;
/** @deprecated Use ParsedBuiltinCommand */
export type ParsedCommand = ParsedBuiltinCommand;
/** @deprecated Use BuiltinCommandContext */
export type NativeCommandContext = BuiltinCommandContext;
/** @deprecated Use executeBuiltinCommand */
export const executeNativeCommand = executeBuiltinCommand;
/** @deprecated Use BUILTIN_COMMANDS */
export const NATIVE_COMMANDS = BUILTIN_COMMANDS;
/** @deprecated Use BuiltinCommand */
export type NativeCommand = BuiltinCommand;
