/**
 * System prompt construction and project context loading
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import * as os from "node:os";
import { getShellConfig } from "../../utils/shell.js";
import { DEFAULT_CLI_SHELL_TIMEOUT_MS } from "../tools/shell.js";
import { type Skill } from "../skills/skills.js";

/**
 * Build a compact skills hint for the system prompt.
 *
 * Instead of injecting the full skills list (name + description + location for
 * every skill), we emit a one-line summary with the count and instruct the LLM
 * to use `_skill list` / `_skill load` to discover and read skills on demand.
 * This saves prompt tokens — the LLM only loads a skill's full content when it
 * actually needs it.
 */
function formatSkillsHint(skills: Skill[]): string {
	const visible = skills.filter((s) => !s.disableModelInvocation);
	if (visible.length === 0) return "";
	const names = visible.map((s) => s.name).join(", ");
	return (
		`\n\n# Skills\n\n` +
		`${visible.length} skill${visible.length > 1 ? "s" : ""} available: ${names}.\n` +
		`Use \`_skill list\` to see details (name, description, source, location), ` +
		`\`_skill load --name <name>\` to read a skill's full instructions, ` +
		`and \`_skill read --name <name> --file <path>\` to read supplementary files ` +
		`referenced by a skill (resolved relative to the skill's directory).\n\n` +
		`If an installed skill fits the current task, prefer using it over ` +
		`hand-rolled code or raw API calls.`
	);
}

/**
 * Resolve the Node.js version the agent can actually invoke: `node` on the
 * user's PATH. Falls back to Pizza's own runtime version when no `node`
 * binary exists (e.g. inside the Bun-compiled desktop app), labeling it so
 * the model does not confuse the embedded runtime with a usable toolchain.
 */
function detectNodeVersion(): string {
	try {
		const out = execSync("node --version", { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out || process.version;
	} catch {
		return `${process.version} (pizza runtime; no node on PATH)`;
	}
}

/**
 * Check if the current directory is a git repository
 */
function isGitRepository(cwd: string): boolean {
	try {
		const gitDir = existsSync(cwd) ? cwd : process.cwd();
		execSync("git rev-parse --is-inside-work-tree", { cwd: gitDir, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the environment section to append at the end of the system prompt
 */
function buildEnvironmentSection(cwd: string, eventStorePath?: string, isMainAgent = false): string {
	const resolvedCwd = cwd.replace(/\\/g, "/");
	const isGit = isGitRepository(cwd);
	const platform = process.platform;
	// Report the shell Pizza actually uses (bash, even on Windows where it
	// comes from Git Bash/Cygwin), not $SHELL/$COMSPEC which may be unset or
	// point at cmd.exe and mislead the model about available syntax.
	let shell: string;
	try {
		shell = getShellConfig().shell;
	} catch {
		shell = process.env.SHELL || "unknown";
	}
	const osVersion = os.release();
	const nodeVersion = detectNodeVersion();

	return `
## Environment
You are being called in the following environment:
 - ${isMainAgent ? "Home directory (your files and long-term memory live here — it is not a project workspace)" : "Primary working directory"}: ${resolvedCwd}
 - Is Git repository: ${isGit ? "Yes" : "No"}
 - Platform: ${platform}
 - Shell: ${shell}
 - Node.js version: ${nodeVersion}
 - OS version: ${osVersion}${eventStorePath ? `
 - Workspace event store (session history/logs; browse via _history_tree): ${eventStorePath}` : ""}
`;
}

/** One command of the cli tool's command table, as documented in the prompt. */
export interface PromptCliCommand {
	name: string;
	description: string;
	usage?: string;
}

/** What the cli tool can run in this session. */
export interface PromptCliInfo {
	/** Available underscore commands (built-in, SDK and extension). */
	commands: PromptCliCommand[];
	/** Whether non-underscore commands fall through to the shell. */
	shell: boolean;
	/** Shell policy allow list, when one is configured. */
	shellAllow?: string[];
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Function tools to include in prompt. */
	selectedTools?: string[];
	/** The cli tool's commands; undefined when the cli tool is not active. */
	cli?: PromptCliInfo;
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** SQLite event-store path for this workspace (session history/logs),
	 * surfaced in the Environment section so the model can find its own logs. */
	eventStorePath?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Soul file placed at the very top of the prompt (main agent only). */
	soulFile?: { path: string; content: string };
	/** User profile placed after the soul (main agent only) — stable facts
	 * about the user, always injected so they need no on-demand read. */
	userProfile?: { path: string; content: string };
	/** Long-term memory entries placed after the soul, before the body (main agent only). */
	longTermMemory?: Array<{ path: string; content: string }>;
	/**
	 * A mandatory-action banner placed at the very top of the prompt (before
	 * Identity) when the main agent's soul is still a placeholder. The model
	 * is instructed to address this before answering the user.
	 */
	mainAgentBanner?: string;
}

/**
 * Build the identity/long-term-memory prefix injected at the top of the prompt
 * for the persistent main agent. Returns an empty string for normal workspaces.
 */
/** Cap on the always-injected user profile — it accumulates over time and
 * must not grow the prompt unboundedly. Longer profiles stay on disk. */
const MAX_USER_PROFILE_CHARS = 2048;

function buildMainAgentPrefix(options: {
	soulFile?: { path: string; content: string };
	userProfile?: { path: string; content: string };
	longTermMemory?: Array<{ path: string; content: string }>;
	mainAgentBanner?: string;
}): string {
	let prefix = "";

	// The banner goes ABOVE Identity so it is the very first thing the model
	// sees — this maximizes the chance the model acts on it before answering.
	if (options.mainAgentBanner) {
		prefix += `${options.mainAgentBanner}\n\n---\n\n`;
	}

	if (options.soulFile) {
		prefix += `# Identity\n\n${options.soulFile.content.trim()}\n\n`;
	}

	if (options.userProfile) {
		let content = options.userProfile.content.trim();
		if (content.length > MAX_USER_PROFILE_CHARS) {
			content = `${content.slice(0, MAX_USER_PROFILE_CHARS).trimEnd()}\n\n…(truncated — the full profile is at ${options.userProfile.path})`;
		}
		prefix += `# About the User\n\n## ${options.userProfile.path}\n\n${content}\n\n`;
	}

	const memory = options.longTermMemory ?? [];
	if (memory.length > 0) {
		prefix += "# Long-Term Memory\n\n";
		prefix +=
			"Your long-term memory index is below. Read the referenced files on demand with the _read command.\n\n";
		for (const { path: filePath, content } of memory) {
			prefix += `## ${filePath}\n\n${content.trim()}\n\n`;
		}
	}

	return prefix;
}

function formatCommandTable(commands: PromptCliCommand[]): string[] {
	const rows = commands.map((command) => ({ left: command.usage ?? command.name, right: command.description }));
	const width = Math.min(48, Math.max(0, ...rows.map((row) => row.left.length)) + 2);
	return rows.map((row) => `  ${row.left.padEnd(width)}${row.right}`);
}

function formatShellAvailability(cli: PromptCliInfo): string {
	if (!cli.shell) return "Shell commands are disabled in this session: only the underscore commands above can run.";
	if (cli.shellAllow?.length) return `Shell commands are restricted to: ${cli.shellAllow.join(", ")}.`;
	return "Anything that is not an underscore command runs in the shell with full shell syntax.";
}

/** Compact command table appended to custom system prompts (the tool contract must not get lost). */
function buildCompactCliSection(cli: PromptCliInfo): string {
	return [
		"",
		"",
		"# CLI Commands",
		"",
		"The cli tool runs underscore commands internally (pure single commands, no shell operators; `<name> --help` shows usage):",
		...formatCommandTable(cli.commands),
		"",
		formatShellAvailability(cli),
	].join("\n");
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		cli,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		soulFile,
		userProfile,
		longTermMemory,
		mainAgentBanner,
	} = options;
	const resolvedCwd = cwd;
	const mainAgentPrefix = buildMainAgentPrefix({ soulFile, userProfile, longTermMemory, mainAgentBanner });
	// The persistent main assistant is the only agent with a soul file (or a
	// first-run banner). It is NOT a workspace-bound coding agent — its prompt
	// describes a home directory and a long-term role instead.
	const isMainAgent = Boolean(soulFile ?? mainAgentBanner ?? userProfile);
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const commandNames = new Set(cli?.commands.map((command) => command.name) ?? []);
	// Skills are loaded on demand through `_skill`; without it the hint is useless.
	const skills = commandNames.has("_skill") ? (providedSkills ?? []) : [];

	if (customPrompt) {
		let prompt = mainAgentPrefix + customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		if (cli) {
			prompt += buildCompactCliSection(cli);
		}

		// Append skills hint — the full skills list is not injected into the
		// prompt. Instead, the LLM discovers and loads skills on demand via
		// the `_skill` underscore command (routed through the `cli` tool).
		if (skills.length > 0) {
			prompt += formatSkillsHint(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += isMainAgent
			? `\nYour home directory: ${promptCwd}`
			: `\nCurrent working directory: ${promptCwd}`;

		// Add environment section at the end
		prompt += buildEnvironmentSection(resolvedCwd, options.eventStorePath, isMainAgent);

		return prompt;
	}

	const tools = selectedTools || (toolSnippets ? Object.keys(toolSnippets) : cli ? ["cli"] : []);
	const toolSnippetsMap: Record<string, string> = {
		cli: "Execute CLI commands",
		...toolSnippets,
	};
	const visibleTools = tools.filter((name) => !!toolSnippetsMap[name]);
	const toolsList =
		visibleTools.length > 0
			? visibleTools.map((name) => `- ${name}: ${toolSnippetsMap[name]}`)
			: "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	// Always include these first — short, behavioral guidelines that apply
	// to every response. Tool-specific detail lives in the sections below.
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");
	addGuideline("Keep reasoning tight: think only as much as the task needs, then act — avoid over-analyzing simple requests");
	addGuideline(
		isMainAgent
			? "Prefer relative paths; commands run from your home directory. Avoid accessing files outside it unless the user explicitly asks"
			: "Prefer relative paths; the working directory is fixed at the workspace root for every command. Avoid accessing files outside the workspace unless the user explicitly asks",
	);

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	const underscoreList = cli?.commands.map((command) => command.name).join(", ") || "none";
	if (cli) {
		addGuideline(
			cli.shell
				? `The cli tool handles two kinds of commands: (1) underscore commands (${underscoreList}) — handled internally, no shell, no pipes/redirects/chaining; (2) shell commands (grep, find, ls, cat, git, npm, ...) — full shell syntax. See the sections below for which to use and how`
				: `The cli tool only runs underscore commands (${underscoreList}) — handled internally, no shell, no pipes/redirects/chaining. Shell commands are disabled in this session`,
		);
	}

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
	const hasEditOrWrite = commandNames.has("_edit") || commandNames.has("_write");

	const cliSections: string[] = [];
	if (cli) {
		cliSections.push(
			[
				cli.shell
					? "The cli tool handles two kinds of commands:\n1. Underscore commands — handled internally, no shell, no pipes/redirects/chaining\n2. Shell commands (grep, find, ls, git, npm, ...) — full shell syntax"
					: "The cli tool runs underscore commands only (handled internally). Shell commands are disabled in this session.",
				"",
				"## Underscore Commands (handled internally, never sent to the shell)",
				"",
				"These commands are prefixed with _ and executed inside the cli tool — no shell fork,",
				"no shell parsing. Each must be the FIRST word of its own single cli() call; run",
				"`<name> --help` for full usage.",
				"",
				...formatCommandTable(cli.commands),
				"",
				"IMPORTANT: underscore commands do NOT support shell operators — no pipes (|),",
				"redirects (> <), chaining (; & &&), command substitution, or newlines. Issue each as",
				"its own separate call; do not prefix it with cd && since the working directory is",
				"already set." + (cli.shell ? " For pipelines, redirections, or globs, use a shell command instead." : ""),
				...(hasEditOrWrite
					? [
							"",
							"PASSING VALUES WITH QUOTES / SPACES / NEWLINES:",
							"- _edit / _write arguments are shell-tokenized. A value written as bare positional",
							"  text has its inner \" or ' silently consumed as shell quoting and DROPPED. NEVER write",
							"  e.g. _write f secret(\"x\",\"y\") or _edit f replace 12#ab call(\"x\") as bare tokens.",
							"- Instead use a verbatim channel: _edit --edits JSON, _write --content, or a <<EOF heredoc.",
							"  These preserve quotes, spaces, and newlines exactly.",
							"",
							"EDIT DISCIPLINE:",
							"- Underscore arguments are LITERAL: $(), ``, $VAR never expand. Don't stage payloads",
							"  or assemble values in shell — inline the JSON, or split into single-edit calls.",
							"- Prefer _edit (fresh anchors or op=search) for targeted edits; scripts (sed/python) only",
							"  for bulk/regex changes _edit cannot express.",
						]
					: []),
			].join("\n"),
		);
		if (cli.shell) {
			cliSections.push(
				[
					"## Shell Commands (full shell syntax allowed)",
					"",
					"Anything that is NOT an underscore command is a shell command: grep, find, ls, cat,",
					"sed, git, npm, cargo, make, curl, etc. These are passed to the shell as-is and support",
					"the full syntax — pipes (|), redirects (> >> <), chaining (&& || ; &), command",
					"substitution ($() ``), globs (* ?), and newlines. Use shell commands when you need",
					"any of these. If grep/find/ls are missing from PATH, Pizza injects temporary",
					"per-process shims for only those missing commands.",
					`Shell commands are killed after a default timeout of ${DEFAULT_CLI_SHELL_TIMEOUT_MS / 60000} minutes; pass the cli`,
					"tool's \"timeout\" parameter (milliseconds) for longer-running commands, or 0",
					"to disable the timeout — always set it explicitly for installs, builds, polls,",
					"and broad filesystem scans.",
					...(cli.shellAllow?.length ? ["", formatShellAvailability(cli)] : []),
				].join("\n"),
			);
		}
		const underscoreExamples: Array<[string, string]> = [
			["_read", '- cli("_read src/main.ts") - Read a file; text lines include <line>#<2-hex-hash> anchors'],
			["_read", '- cli("_read src/main.ts 10 50") - Read lines 10-59 (offset=10, limit=50)'],
			["_write", '- cli("_write output.txt Hello World") - Write to a file'],
			["_edit", '- cli("_edit src/main.ts replace 12#ab \"const value = 2\"") - Replace an anchored line'],
			["_edit", '- cli("_edit src/main.ts insert_after 12#ab \"const next = 3\"") - Insert after an anchored line'],
			["_edit", '- cli("_edit src/main.ts delete 12#ab..14#de") - Delete an anchored range'],
			["_edit", '- cli("_edit src/main.ts search \"const a = 1\" \"const a = 2\"") - Search-and-replace without line anchors (fallback when anchors are stale or unavailable)'],
			["_edit", '- cli("_edit src/main.ts --edits \'[{\"op\":\"replace\",\"range\":\"12#ab\",\"new\":\"x = f(\\\"a\\\")\"}]\'") - PREFER --edits JSON for values with quotes/spaces/newlines (kept verbatim)'],
			["_session_split", '- cli("_session_split topic_change") - Split when the conversation topic changes'],
			["_session_split", '- cli("_session_split --reason topic_change --name \"Fix auth\"") - Split and name the new session'],
			["_history_tree", '- cli("_history_tree list") - Show the session history tree'],
			["_history_tree", '- cli("_history_tree jump sess_0042") - Return to a previous session and continue there'],
		];
		const examples = underscoreExamples.filter(([name]) => commandNames.has(name)).map(([, line]) => line);
		const examplesSection = ["## Examples"];
		if (examples.length > 0) {
			examplesSection.push("", "Underscore commands (single, pure, no shell operators):", ...examples);
		}
		if (cli.shell && !cli.shellAllow?.length) {
			examplesSection.push(
				"",
				"Shell commands (full shell syntax — pipes, redirects, chaining, globs):",
				'- cli("grep -rn \"foo\" . | head") - Search with a pipeline',
				'- cli("find . -name \"*.py\" -maxdepth 2 | wc -l") - Find and count with a pipeline',
				'- cli("ls -lah *.py") - List files with glob expansion',
				'- cli("npm test 2>&1 | tail -20") - Run tests and show last 20 lines',
			);
		}
		if (examplesSection.length > 1) cliSections.push(examplesSection.join("\n"));
	}

	let prompt = mainAgentPrefix + [
		isMainAgent
			? "You are the user's long-term personal assistant. You answer questions, run commands, work with files, write code when asked, and remember things across sessions. You are not bound to a project workspace — the directory below is your home, where your notes and long-term memory live."
			: "You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.",
		"",
		"Available tools:",
		toolsList,
		"",
		...cliSections.flatMap((section) => [section, ""]),
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		"",
		"Guidelines:",
		guidelines,
		"",
		"Current date: " + date,
		isMainAgent ? "Your home directory: " + promptCwd : "Current working directory: " + promptCwd,
	].join("\n");

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills hint — the full skills list is no longer injected into
	// the prompt. Instead, the LLM discovers and loads skills on demand via
	// the `_skill` underscore command (routed through the `cli` tool).
	if (skills.length > 0) {
		prompt += formatSkillsHint(skills);
	}

	// Add environment section at the end
	prompt += buildEnvironmentSection(resolvedCwd, options.eventStorePath, isMainAgent);

	return prompt;
}
