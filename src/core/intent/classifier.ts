/**
 * Intent Classifier
 *
 * Classifies LLM-proposed tool calls by risk level and approval requirements.
 */

import type { IntentClassification, IntentCategory, IntentRisk } from "./types.js";
import { splitShellWords } from "../exec/shell-words.js";

// ============================================================================
// Classifier Configuration
// ============================================================================

export interface ClassifierConfig {
	/** Require user approval before file writes. */
	require_approval_writes?: boolean;
	/** Require user approval before file edits. */
	require_approval_edits?: boolean;
	/** Require user approval before moderate shell commands. */
	require_approval_shell_moderate?: boolean;
	/** Require user approval before unknown tools. */
	require_approval_unknown?: boolean;
	/**
	 * Master toggle for safe mode.
	 * - `true`: require approval for risky tool calls (writes, edits, deletes,
	 *   dangerous shell, unknown). This is the strict default policy.
	 * - `false`: never require approval — tools auto-run. Even categories that
	 *   normally always need approval (delete, dangerous) are bypassed.
	 * - `undefined` (not set): defer to the individual require_approval_* flags
	 *   below (backward-compatible behavior).
	 */
	safe_mode?: boolean;

	/** @deprecated Use require_approval_writes. Historical alias. */
	approve_writes?: boolean;
	/** @deprecated Use require_approval_edits. Historical alias. */
	approve_edits?: boolean;
	/** @deprecated Use require_approval_shell_moderate. Historical alias. */
	approve_shell_moderate?: boolean;
	/** @deprecated Use require_approval_unknown. Historical alias. */
	approve_unknown?: boolean;
}

interface ResolvedClassifierConfig {
	safe_mode: boolean | undefined;
	require_approval_writes: boolean;
	require_approval_edits: boolean;
	require_approval_shell_moderate: boolean;
	require_approval_unknown: boolean;
}

// Default policy is "gated": unknown tools and dangerous shell are gated;
// writes/edits/ordinary commands auto-run.
const DEFAULT_CLASSIFIER_CONFIG: ResolvedClassifierConfig = {
	safe_mode: undefined,
	require_approval_writes: false,
	require_approval_edits: false,
	require_approval_shell_moderate: false,
	require_approval_unknown: true,
};

// ============================================================================
// Intent Classifier
// ============================================================================

/**
 * Classifies tool calls by risk level and approval requirements.
 *
 * Default policy:
 * - file_read, shell_safe: auto-approve
 * - file_write, network, unknown: require approval (configurable)
 * - shell_moderate: auto-approve by default (configurable)
 * - file_delete, shell_dangerous: always require approval
 */
export class IntentClassifier {
	private config: ResolvedClassifierConfig;

	constructor(config: ClassifierConfig = {}) {
		this.config = resolveClassifierConfig(config);
	}

	/**
	 * Classify a tool call by name and arguments.
	 *
	 * Applies the `safe_mode` master toggle as a final override:
	 * - safe_mode === false  → never require approval (tools auto-run)
	 * - safe_mode === true   → require approval for any risky category
	 * - safe_mode undefined  → use the individual require_approval_* flags
	 */
	classify(toolName: string, args: Record<string, unknown>): IntentClassification {
		const result = this._classifyRaw(toolName, args);
		if (this.config.safe_mode === false) {
			result.requires_approval = false;
		} else if (this.config.safe_mode === true && result.risk !== "safe") {
			result.requires_approval = true;
		}
		return result;
	}

	/**
	 * Apply safe mode without changing individual require_approval_* flags.
	 * Passing `undefined` restores deferred (flag-based) behavior.
	 */
	setSafeMode(safeMode: boolean | undefined): void {
		this.config = { ...this.config, safe_mode: safeMode };
	}

	/** Update individual require_approval_* gates live (effective when safe
	 * mode is "auto"/undefined). Fields left undefined keep their value. */
	setApprovalGates(gates: { writes?: boolean; edits?: boolean; shellModerate?: boolean; unknown?: boolean }): void {
		this.config = {
			...this.config,
			...(gates.writes !== undefined ? { require_approval_writes: gates.writes } : {}),
			...(gates.edits !== undefined ? { require_approval_edits: gates.edits } : {}),
			...(gates.shellModerate !== undefined ? { require_approval_shell_moderate: gates.shellModerate } : {}),
			...(gates.unknown !== undefined ? { require_approval_unknown: gates.unknown } : {}),
		};
	}

	/** Whether safe mode is currently active (explicitly on). */
	get isSafeMode(): boolean {
		return this.config.safe_mode === true;
	}

	/**
	 * Raw classification by name and arguments (before safe_mode override).
	 */
	private _classifyRaw(toolName: string, args: Record<string, unknown>): IntentClassification {
		// Built-in tool classification
		switch (toolName) {
			case "read":
			case "find":
			case "grep":
			case "ls":
			case "path_utils":
				return {
					risk: "safe",
					requires_approval: false,
					category: "file_read",
					description: `Read ${args.path ?? ""}`,
				};

			case "write":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_writes,
					category: "file_write",
					affected_files: [String(args.path)],
					description: `Write to ${args.path}`,
				};

			case "edit":
			case "edit_diff":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_edits,
					category: "file_write",
					affected_files: [String(args.path)],
					description: `Edit ${args.path}`,
				};

			case "cli":
			case "bash":
				return this._classifyBashCommand(String(args.command ?? ""));

			case "truncate":
				return {
					risk: "dangerous",
					requires_approval: true,
					category: "file_delete",
					description: `Truncate ${args.path ?? ""}`,
				};

			case "builtin":
				return this._classifyBuiltinCommand(String(args.command ?? ""));

			default:
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_unknown,
					category: "unknown",
					description: `Execute ${toolName}`,
				};
		}
	}

	/**
	 * Classify a bash command by its content.
	 */
	private _classifyBashCommand(command: string): IntentClassification {
		const trimmed = command.trim();
		const builtin = parseBuiltinInvocation(trimmed);
		if (builtin) {
			if (builtin.command === "read") {
				return {
					risk: "safe",
					requires_approval: false,
					category: "file_read",
					affected_files: builtin.path ? [builtin.path] : undefined,
					description: `Read ${builtin.path ?? ""}`,
				};
			}
			if (builtin.command === "write") {
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_writes,
					category: "file_write",
					affected_files: builtin.path ? [builtin.path] : undefined,
					description: `Write to ${builtin.path ?? ""}`,
				};
			}
			if (builtin.command === "edit") {
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_edits,
					category: "file_write",
					affected_files: builtin.path ? [builtin.path] : undefined,
					description: `Edit ${builtin.path ?? ""}`,
				};
			}
		}

		// Dangerous patterns
		const dangerousPatterns: Array<{ pattern: RegExp; description: string }> = [
			{ pattern: /\brm\s+-[a-z]*r/i, description: "Recursive delete" },
			{ pattern: /\brm\s+-[a-z]*[rf]\s+\/(?:\s|$|\*)/i, description: "Delete from root" },
			{ pattern: /\bsudo\s+/i, description: "Elevated privileges" },
			{ pattern: /\bcurl\b.*\|\s*bash/i, description: "Download and execute" },
			{ pattern: /\bwget\b.*\|\s*bash/i, description: "Download and execute" },
			{ pattern: /\bchmod\s+777/i, description: "World-writable permissions" },
			{ pattern: /\b>\s*\/dev\/(?!null\b)/i, description: "Redirect to device" },
			{ pattern: /\n\s*rm\s+/i, description: "Embedded delete command" },
			{ pattern: /\bdd\b/i, description: "Direct disk access" },
			{ pattern: /\bmkfs\b/i, description: "Filesystem format" },
		];

		for (const { pattern, description } of dangerousPatterns) {
			if (pattern.test(trimmed)) {
				return {
					risk: "dangerous",
					requires_approval: true,
					category: "shell_dangerous",
					description: `DANGEROUS: ${description}`,
				};
			}
		}

		const redirectedPath = getNonNullRedirectPath(trimmed);
		if (redirectedPath) {
			return {
				risk: "moderate",
				requires_approval: this.config.require_approval_writes,
				category: "file_write",
				affected_files: [redirectedPath],
				description: `Shell redirection to ${redirectedPath}`,
			};
		}

		// Safe patterns
		const safePatterns: RegExp[] = [
			/^(echo|cat|pwd|ls|find|grep|head|tail|wc|date|whoami|id|uname)\b/,
			/^git\s+(status|log|diff|branch|show|remote)\b/,
			/^npm\s+(list|config|root)\b/,
			/^yarn\s+(info|list)\b/,
			/^pnpm\s+(list|root)\b/,
			/^docker\s+(ps|images|logs)\b/,
		];

		if (isSingleSafeShellCommand(trimmed)) {
			for (const pattern of safePatterns) {
				if (!pattern.test(trimmed)) continue;
				return {
					risk: "safe",
					requires_approval: false,
					category: "shell_safe",
					description: trimmed.length > 50 ? trimmed.slice(0, 50) + "..." : trimmed,
				};
			}
		}

		// Moderate (default for shell)
		return {
			risk: "moderate",
			requires_approval: this.config.require_approval_shell_moderate,
			category: "shell_moderate",
			description: trimmed.length > 50 ? trimmed.slice(0, 50) + "..." : trimmed,
		};
	}

	/**
	 * Classify a builtin command.
	 */
	private _classifyBuiltinCommand(command: string): IntentClassification {
		const trimmed = command.trim().toLowerCase();

		// Safe builtin commands
		const safeCommands = ["help", "version", "list", "ls", "status"];

		if (safeCommands.includes(trimmed)) {
			return {
				risk: "safe",
				requires_approval: false,
				category: "shell_safe",
				description: `Builtin: ${command}`,
			};
		}

		// Everything else is moderate
		return {
			risk: "moderate",
			requires_approval: false,
			category: "shell_moderate",
			description: `Builtin: ${command}`,
		};
	}

	/**
	 * Classify by intent category directly.
	 */
	classifyByCategory(
		category: IntentCategory,
		args: Record<string, unknown>,
	): IntentClassification {
		const result = this._classifyByCategoryRaw(category, args);
		if (this.config.safe_mode === false) {
			result.requires_approval = false;
		} else if (this.config.safe_mode === true && result.risk !== "safe") {
			result.requires_approval = true;
		}
		return result;
	}

	private _classifyByCategoryRaw(
		category: IntentCategory,
		args: Record<string, unknown>,
	): IntentClassification {
		const toolName = String(args.tool_name ?? "unknown");

		switch (category) {
			case "file_read":
				return {
					risk: "safe",
					requires_approval: false,
					category,
					description: `Read ${args.path ?? ""}`,
				};
			case "file_write":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_writes,
					category,
					affected_files: [String(args.path)],
					description: `Write to ${args.path}`,
				};
			case "file_delete":
				return {
					risk: "dangerous",
					requires_approval: true,
					category,
					description: `Delete ${args.path ?? ""}`,
				};
			case "shell_safe":
				return {
					risk: "safe",
					requires_approval: false,
					category,
					description: toolName,
				};
			case "shell_moderate":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_shell_moderate,
					category,
					description: toolName,
				};
			case "shell_dangerous":
				return {
					risk: "dangerous",
					requires_approval: true,
					category,
					description: `DANGEROUS: ${toolName}`,
				};
			case "network":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_unknown,
					category,
					description: `Network: ${args.url ?? toolName}`,
				};
			case "unknown":
				return {
					risk: "moderate",
					requires_approval: this.config.require_approval_unknown,
					category,
					description: toolName,
				};
		}
	}
}

function resolveClassifierConfig(config: ClassifierConfig): ResolvedClassifierConfig {
	return {
		safe_mode: config.safe_mode ?? DEFAULT_CLASSIFIER_CONFIG.safe_mode,
		require_approval_writes:
			config.require_approval_writes ?? config.approve_writes ?? DEFAULT_CLASSIFIER_CONFIG.require_approval_writes,
		require_approval_edits:
			config.require_approval_edits ?? config.approve_edits ?? DEFAULT_CLASSIFIER_CONFIG.require_approval_edits,
		require_approval_shell_moderate:
			config.require_approval_shell_moderate ??
			config.approve_shell_moderate ??
			DEFAULT_CLASSIFIER_CONFIG.require_approval_shell_moderate,
		require_approval_unknown:
			config.require_approval_unknown ?? config.approve_unknown ?? DEFAULT_CLASSIFIER_CONFIG.require_approval_unknown,
	};
}

function parseBuiltinInvocation(command: string): { command: "read" | "write" | "edit"; path?: string } | undefined {
	const firstLine = command.split("\n", 1)[0]?.trim() ?? "";
	const parts = splitShellWords(firstLine);
	const builtin = parts[0]?.toLowerCase();
	if (builtin !== "read" && builtin !== "write" && builtin !== "edit") return undefined;

	let path: string | undefined;
	for (let i = 1; i < parts.length; i++) {
		const arg = parts[i]!;
		if ((arg === "--path" || arg === "-p") && parts[i + 1]) {
			path = parts[i + 1];
			break;
		}
		if (!arg.startsWith("-") && !path) {
			path = arg;
			break;
		}
	}

	return { command: builtin, path };
}


/**
 * Commands whose quoted or heredoc payloads are executed as code rather than
 * used as data (shell interpreters, eval/source, script runtimes). Redirects
 * hidden inside those payloads are real, so for them we keep the raw scan.
 */
const EXEC_PAYLOAD_RE =
	/\b(?:ba|z|da|k)?sh\s+(?:-[a-zA-Z]*c|<<)|\b(?:python3?|node|perl|ruby|osascript|bun|deno)\s+(?:-[a-zA-Z]+\b|<<)|\b(?:eval|source|exec)\s+/;

/**
 * Quote-unaware redirect scan (the original behavior). Kept as a conservative
 * fallback for commands that execute their string/heredoc payloads, where a
 * redirect written inside quotes is still performed by the inner shell.
 */
function rawRedirectScan(command: string): string | undefined {
	const matches = command.matchAll(/(?:^|[\s;|&])(?:\d*)>>?\s*(["']?)([^'"\s;&|]+)\1/g);
	for (const match of matches) {
		const path = match[2];
		if (!path || path === "/dev/null") continue;
		return path;
	}
	return undefined;
}

/**
 * Find the target of the first output redirection the shell would actually
 * perform (a `>` in its plain, append and fd-prefixed forms), or undefined
 * when there is none (or only /dev/null).
 *
 * The scan is quote-, escape- and heredoc-aware so payload data cannot fake
 * a redirection: a `>` inside quoted arguments (e.g. edit content like
 * `if (a>b)`), after a backslash, or inside a heredoc body is data, not
 * shell syntax. Quoted targets are unquoted. Command substitution
 * (`$(...)`, backticks) is scanned as shell code. Commands that execute
 * their payloads fall back to rawRedirectScan.
 */
function getNonNullRedirectPath(command: string): string | undefined {
	if (EXEC_PAYLOAD_RE.test(command)) {
		return rawRedirectScan(command);
	}
	const n = command.length;
	let quote: "'" | '"' | undefined;
	let i = 0;

	while (i < n) {
		const ch = command[i]!;

		if (quote !== undefined) {
			if (quote === '"' && ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === quote) quote = undefined;
			i++;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			i++;
			continue;
		}
		if (ch === "\\") {
			i += 2; // escaped metacharacter (or a trailing backslash)
			continue;
		}

		if (ch === "<" && command[i + 1] === "<") {
			const after = skipHeredocBody(command, i);
			if (after !== undefined) {
				i = after;
				continue;
			}
			// not a heredoc (e.g. `<<<` or a shift inside $((...))) - scan on
		}

		if (ch === ">") {
			const opEnd = command[i + 1] === ">" ? i + 1 : i;
			let fdStart = i;
			while (fdStart !== 0 && /\d/.test(command[fdStart - 1]!)) fdStart--;
			const atOperator =
				fdStart < i ? atBoundary(command, fdStart - 1) : atBoundary(command, i - 1);
			if (atOperator) {
				let p = opEnd + 1;
				while (p < n && /\s/.test(command[p]!)) p++;
				const parsed = readRedirectTarget(command, p);
				if (parsed !== undefined) {
						if (parsed.path !== "/dev/null") return parsed.path;
					i = parsed.end;
						continue;
					}
			}
			i = opEnd + 1;
			continue;
		}

		i++;
	}
	return undefined;
}

/** Read a redirect target starting at p (already past the operator and any
 * whitespace). Quoted targets are returned unquoted. */
function readRedirectTarget(command: string, p: number): { path: string; end: number } | undefined {
	const n = command.length;
	const qc = command[p];
	if (qc === "'" || qc === '"') {
		let content = "";
		let q = p + 1;
		while (q < n && command[q] !== qc) {
			if (qc === '"' && command[q] === "\\" && q + 1 < n && /["`$\\]/.test(command[q + 1]!)) {
				content += command[q + 1]!;
				q += 2;
				continue;
			}
			content += command[q]!;
			q++;
		}
		if (command[q] !== qc) return undefined; // unterminated quote
		return content ? { path: content, end: q + 1 } : undefined;
	}
	let content = "";
	let q = p;
	while (q < n && !/['"\s;&|]/.test(command[q]!)) {
		content += command[q]!;
		q++;
	}
	return content ? { path: content, end: q } : undefined;
}

/**
 * When a heredoc starts at command[i] (on the first of two `<`), return the
 * index just past its body. Returns undefined when this is not a recognizable
 * heredoc (no delimiter word, or not in operator position).
 */
function skipHeredocBody(command: string, i: number): number | undefined {
	const n = command.length;
	// Operator position: preceded by a boundary, or by an fd-digit run that
	// itself follows a boundary (this rejects shifts like $((1<<2)) where the
	// digit follows an opening paren).
	let s = i;
	while (s !== 0 && /\d/.test(command[s - 1]!)) s--;
	const atOperator = s < i ? atBoundary(command, s - 1) : atBoundary(command, i - 1);
	if (!atOperator) return undefined;
	let p = i + 2;
	let stripTabs = false;
	if (command[p] === "-") {
		stripTabs = true;
		p++;
	}
	const qc = command[p];
	let delim: string | undefined;
	if (qc === "'" || qc === '"') {
		const close = command.indexOf(qc, p + 1);
		if (close === -1) return undefined;
		delim = command.slice(p + 1, close) || undefined;
		p = close + 1;
	} else {
		let q = p;
		while (q < n && /[A-Za-z0-9_]/.test(command[q]!)) q++;
		if (q === p) return undefined;
		delim = command.slice(p, q);
	}
	if (!delim) return undefined;
	// The body starts on the line after the operator line.
	const nl = command.indexOf("\n", p);
	if (nl === -1) return n; // body pending, nothing else to scan
	let lineStart = nl + 1;
	for (;;) {
		const nextNl = command.indexOf("\n", lineStart);
		const lineEnd = nextNl === -1 ? n : nextNl;
		let ls = lineStart;
		if (stripTabs) {
			while (ls < lineEnd && command[ls] === "\t") ls++;
		}
		if (command.slice(ls, lineEnd) === delim) {
			return nextNl === -1 ? n : nextNl + 1;
		}
		if (nextNl === -1) return n; // unterminated body runs to the end
		lineStart = nextNl + 1;
	}
}

/** Whether idx is before the string start or points at a character that may
 * precede a redirection/heredoc operator (whitespace, `;`, `|`, `&`). */
function atBoundary(command: string, idx: number): boolean {
	return idx === -1 || /[\s;|&]/.test(command[idx]!);
}

function isSingleSafeShellCommand(command: string): boolean {
	const withoutNullRedirects = command.replace(/\s+\d*>\/dev\/null\b/g, "");
	return !/[|;&<>`$()]/.test(withoutNullRedirects);
}
