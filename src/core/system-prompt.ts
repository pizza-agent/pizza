/**
 * System prompt construction and project context loading
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import * as os from "node:os";
import { getShellConfig } from "../utils/shell.js";
import { type Skill } from "./skills.js";

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
	const nodeVersion = process.version;

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

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [cli] */
	selectedTools?: string[];
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
function buildMainAgentPrefix(options: {
	soulFile?: { path: string; content: string };
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

	const memory = options.longTermMemory ?? [];
	if (memory.length > 0) {
		prefix += "# Long-Term Memory\n\n";
		prefix +=
			"Your long-term memory index is below. Read the referenced files on demand with the read command.\n\n";
		for (const { path: filePath, content } of memory) {
			prefix += `## ${filePath}\n\n${content.trim()}\n\n`;
		}
	}

	return prefix;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		soulFile,
		longTermMemory,
		mainAgentBanner,
	} = options;
	const resolvedCwd = cwd;
	const mainAgentPrefix = buildMainAgentPrefix({ soulFile, longTermMemory, mainAgentBanner });
	// The persistent main assistant is the only agent with a soul file (or a
	// first-run banner). It is NOT a workspace-bound coding agent — its prompt
	// describes a home directory and a long-term role instead.
	const isMainAgent = Boolean(soulFile ?? mainAgentBanner);
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

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

		// Append skills hint — the full skills list is no longer injected into
		// the prompt. Instead, the LLM discovers and loads skills on demand via
		// the `_skill` underscore command (routed through the `cli` tool).
		const customPromptHasCli = !selectedTools || selectedTools.includes("cli") || selectedTools.includes("bash");
		if (customPromptHasCli && skills.length > 0) {
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

	// Build tools list - only cli is exposed via function calls.
	// read/write/edit are handled internally by the cli tool;
	// grep/find/ls and other commands are passed to bash as-is.
	const tools = selectedTools || (toolSnippets ? Object.keys(toolSnippets) : ["cli"]);
	const toolSnippetsMap: Record<string, string> = {
		cli: "Execute CLI commands",
		bash: "Execute bash commands",
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

	const hasCli = tools.includes("cli") || tools.includes("bash");

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

	// Tool-specific guidelines — kept short here; full detail is in the
	// Underscore Commands / Bash Commands sections below.
	if (hasCli) {
		addGuideline("The cli tool handles two kinds of commands: (1) underscore commands (_read, _write, _edit, _session_split, _history_tree, _tell, _skill) — handled internally, no shell, no pipes/redirects/chaining; (2) bash commands (grep, find, ls, cat, git, npm, ...) — passed to bash with full bash syntax. See the sections below for which to use and how");
	}

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// Underscore Commands section for the default system prompt
	const builtinCommandsSection = [
		"## Underscore Commands (handled internally, never sent to the shell)",
		"",
		"These Pizza-specific commands are prefixed with _ and executed inside the cli tool —",
		"no shell fork, no shell parsing. Each must be the FIRST word of its own single cli()",
		"call; buried after &&/||/;/| it falls through to the shell, which has no such command.",
		"",
		"  _read <path> [offset] [limit]                Read file content with 2-hex line anchors",
		"  _write <path> <content>                       Write content to file",
		"  _write <path> <<EOF\ncontent\nEOF             Write multi-line content (heredoc)",
		"  _edit <path> <op> <range> [new]               Edit anchored whole line(s)",
		"  _session_split [reason] [name]                Split promptly when the user starts a new task or topic",
		"  _history_tree <action> [session_id]           Browse past sessions: list, view, jump, fork",
		"  _tell <action> [to] [message]                 Send a message to another workspace's agent and get its reply",
		"  _skill <action> [--name <name>] [--file <f>]   Discover and load Agent Skills: list, load, read",
		"",
		"IMPORTANT: underscore commands do NOT support shell operators — no pipes (|),",
		"redirects (> <), chaining (; & &&), command substitution, or newlines. Issue each as",
		"its own separate call; do not prefix it with cd && since the working directory is",
		"already set. For pipelines, redirections, or globs, use a bash command instead.",
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
	].join("\n");

	// Bash Commands section — the second kind of command the cli tool handles.
	const shellCommandsSection = [
		"## Bash Commands (passed to bash, full bash syntax allowed)",
		"",
		"Anything that is NOT an underscore command is a bash command: grep, find, ls, cat,",
		"sed, git, npm, cargo, make, curl, etc. These are passed to bash as-is and support the",
		"full bash syntax — pipes (|), redirects (> >> <), chaining (&& || ; &), command",
		"substitution ($() ``), globs (* ?), and newlines. Use bash commands when you need",
		"any of these. If grep/find/ls are missing from PATH, Pizza injects temporary",
		"per-process shims for only those missing commands.",
	].join("\n");

	// Examples split by command kind so the distinction is unambiguous.
	const examplesSection = [
		"## Examples",
		"",
		"Underscore commands (single, pure, no shell operators):",
		'- cli("_read src/main.ts") - Read a file; text lines include <line>#<2-hex-hash> anchors',
		'- cli("_read src/main.ts 10 50") - Read lines 10-59 (offset=10, limit=50)',
		'- cli("_write output.txt Hello World") - Write to a file',
		'- cli("_edit src/main.ts replace 12#ab \"const value = 2\"") - Replace an anchored line',
		'- cli("_edit src/main.ts insert_after 12#ab \"const next = 3\"") - Insert after an anchored line',
		'- cli("_edit src/main.ts delete 12#ab..14#de") - Delete an anchored range',
		'- cli("_edit src/main.ts search \"const a = 1\" \"const a = 2\"") - Search-and-replace without line anchors (fallback when anchors are stale or unavailable)',
		'- cli("_edit src/main.ts --edits \'[{\"op\":\"replace\",\"range\":\"12#ab\",\"new\":\"x = f(\\\"a\\\")\"}]\'") - PREFER --edits JSON for values with quotes/spaces/newlines (kept verbatim)',
		'- cli("_session_split topic_change") - Split when the conversation topic changes',
		'- cli("_session_split --reason topic_change --name \"Fix auth\"") - Split and name the new session',
		'- cli("_history_tree list") - Show the session history tree',
		'- cli("_history_tree jump sess_0042") - Return to a previous session and continue there',
		"",
		"Bash commands (full bash syntax — pipes, redirects, chaining, globs):",
		'- cli("grep -rn \"foo\" . | head") - Search with a pipeline',
		'- cli("find . -name \"*.py\" -maxdepth 2 | wc -l") - Find and count with a pipeline',
		'- cli("ls -lah *.py") - List files with glob expansion',
		'- cli("npm test 2>&1 | tail -20") - Run tests and show last 20 lines',
	].join("\n");

	let prompt = mainAgentPrefix + [
		isMainAgent
			? "You are the user's long-term personal assistant. You answer questions, run commands, work with files, write code when asked, and remember things across sessions. You are not bound to a project workspace — the directory below is your home, where your notes and long-term memory live."
			: "You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.",
		"",
		"Available tools:",
		toolsList,
		"",
		"The cli tool handles two kinds of commands:",
		"1. Underscore commands (_read, _write, _edit, ...) — handled internally, no shell, no pipes/redirects/chaining",
		"2. Bash commands (grep, find, ls, git, npm, ...) — passed to bash with full bash syntax",
		"",
		builtinCommandsSection,
		"",
		shellCommandsSection,
		"",
		examplesSection,
		"",
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
	if (hasCli && skills.length > 0) {
		prompt += formatSkillsHint(skills);
	}

	// Add environment section at the end
	prompt += buildEnvironmentSection(resolvedCwd, options.eventStorePath, isMainAgent);

	return prompt;
}
