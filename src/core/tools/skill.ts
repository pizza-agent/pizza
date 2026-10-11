/**
 * `skill` built-in CLI command — discover and load Agent Skills.
 *
 * Routed internally by the `cli` tool (alongside read/write/edit/session_split/
 * history_tree/tell), wired up whenever the runtime has skills
 * available (see `session-facade-factory.ts`, which passes the loaded skills
 * into the cli tool's options).
 *
 * Three actions:
 *  - **list**: return all available skills with name, description, source and
 *    file path. Supports an optional `--query` filter.
 *  - **load**: return the full content of a skill's SKILL.md file.
 *  - **read**: read a supplementary file referenced by a skill, resolved
 *    relative to the skill's base directory. Prevents path traversal outside
 *    the skill directory.
 *
 * This replaces the old approach of injecting the full skills list into the
 * system prompt and telling the LLM to use `_read` to load SKILL.md. Now the
 * LLM can discover and load skills on demand via `_skill`, saving prompt
 * tokens and providing a cleaner interaction model.
 */

import { type Static, Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { defineTool, type ToolDefinition } from "../extensions/types.js";
import type { Skill } from "../skills/skills.js";

/** Supported `skill` subcommands. */
export const SKILL_ACTIONS = ["list", "load", "read"] as const;
export type SkillAction = (typeof SKILL_ACTIONS)[number];

/**
 * CLI-style schema for the `skill` command. Mirrors the positional/flag form
 * parsed in `parseSkillInput` (builtin-commands.ts):
 *
 *   skill list [--query "git"]
 *   skill load --name "devin-cli"
 *   skill load "devin-cli"
 *   skill read --name "devin-cli" --file "docs/config.md"
 *   skill read "devin-cli" "docs/config.md"
 */
const skillSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("list"), Type.Literal("load"), Type.Literal("read")],
		{
			description:
				"list: show all available skills with name, description, source and file path. " +
				"load: load and return the full content of a skill's SKILL.md. " +
				"read: read a file referenced by a skill, resolved relative to the skill's base directory.",
		},
	),
	name: Type.Optional(
		Type.String({
			description:
				"Skill name (required for load and read). Matches the <name> from the list output.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description:
				"Optional filter string for list — returns only skills whose name or description contains the query (case-insensitive).",
		}),
	),
	file: Type.Optional(
		Type.String({
			description:
				"Relative file path within a skill's directory (required for read). " +
				"Resolved against the skill's baseDir. Use this to read supplementary files referenced by SKILL.md.",
		}),
	),
});

export type SkillToolInput = Static<typeof skillSchema>;

/** Options for {@link createSkillToolDefinition}. */
export interface SkillToolOptions {
	/**
	 * Skills available in this session. Read on every invocation so skills
	 * enabled or disabled mid-session are picked up without a restart.
	 */
	getSkills: () => Skill[];
}

function textResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
	};
}

/** Format the skills list as a readable text block for the model. */
function formatSkillList(skills: Skill[], query?: string): string {
	let visible = skills.filter((s) => !s.disableModelInvocation);

	if (query) {
		const q = query.toLowerCase();
		visible = visible.filter(
			(s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
		);
	}

	if (visible.length === 0) {
		if (query) {
			return `No skills found matching "${query}".`;
		}
		return "No skills available in this session.";
	}

	visible.sort((a, b) => a.name.localeCompare(b.name));

	const lines = [`Available skills (${visible.length}):`, ""];
	for (const skill of visible) {
		lines.push(`  name: ${skill.name}`);
		lines.push(`  description: ${skill.description}`);
		const sourceLabel =
			skill.sourceInfo.scope === "user"
				? "user"
				: skill.sourceInfo.scope === "project"
					? "project"
					: skill.sourceInfo.source;
		lines.push(`  source: ${sourceLabel}`);
		lines.push(`  location: ${skill.filePath}`);
		lines.push("");
	}

	lines.push("Use `_skill load --name <name>` to read a skill's full instructions.");
	lines.push("Use `_skill read --name <name> --file <relative-path>` to read supplementary files.");

	return lines.join("\n");
}

/**
 * Resolve a relative file path within a skill's directory, ensuring it stays
 * inside the skill's baseDir (no `..` traversal).
 */
function resolveSkillFile(skill: Skill, file: string): string | { error: string } {
	const baseDir = skill.baseDir;
	const target = isAbsolute(file) ? file : join(baseDir, file);
	const resolvedTarget = resolve(target);
	const resolvedBase = resolve(baseDir);

	const rel = relative(resolvedBase, resolvedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return { error: `File path "${file}" resolves outside the skill directory (${baseDir}). Path traversal is not allowed.` };
	}
	return resolvedTarget;
}

/**
 * Create the `skill` command's tool definition.
 *
 * Three actions:
 *  - **list**: returns the list of available skills (optionally filtered).
 *  - **load**: returns the full content of a skill's SKILL.md.
 *  - **read**: reads a supplementary file from a skill's directory.
 */
export function createSkillToolDefinition(options: SkillToolOptions): ToolDefinition<typeof skillSchema, undefined> {
	return defineTool({
		name: "skill",
		label: "skill",
		description:
			"Discover and load Agent Skills. " +
			"Actions: list (show available skills, optional --query filter), " +
			"load (read a skill's SKILL.md by --name), " +
			"read (read a supplementary file from a skill's directory by --name and --file).",
		parameters: skillSchema,
		async execute(_toolCallId, params) {
			const { action, name, query, file } = params;
			const skills = options.getSkills();

			if (action === "list") {
				return textResult(formatSkillList(skills, query));
			}

			if (action === "load") {
				if (!name) {
					return textResult("skill load: --name is required. Use `_skill list` to see available skills.");
				}
				const skill = skills.find((s) => s.name === name && !s.disableModelInvocation);
				if (!skill) {
					return textResult(`Skill "${name}" not found. Use \`_skill list\` to see available skills.`);
				}
				try {
					const content = await readFile(skill.filePath, "utf-8");
					return textResult(content);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return textResult(`Error loading skill "${name}": ${message}`);
				}
			}

			if (action === "read") {
				if (!name) {
					return textResult("skill read: --name is required. Use `_skill list` to see available skills.");
				}
				if (!file) {
					return textResult("skill read: --file is required. Specify a relative path within the skill's directory.");
				}
				const skill = skills.find((s) => s.name === name && !s.disableModelInvocation);
				if (!skill) {
					return textResult(`Skill "${name}" not found. Use \`_skill list\` to see available skills.`);
				}
				const resolved = resolveSkillFile(skill, file);
				if (typeof resolved !== "string") {
					return textResult(resolved.error);
				}
				if (!existsSync(resolved)) {
					return textResult(`File not found: ${file} (resolved to ${resolved})`);
				}
				try {
					const content = await readFile(resolved, "utf-8");
					return textResult(content);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return textResult(`Error reading file "${file}" from skill "${name}": ${message}`);
				}
			}

			return textResult(`skill: unknown action "${action}". Valid actions: ${SKILL_ACTIONS.join(", ")}`);
		},
	});
}
