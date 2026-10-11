/**
 * Built-in skills registry.
 *
 * Built-in skills are SKILL.md files that ship with Pizza inside this package
 * (`src/builtin-skills/<id>/SKILL.md`, mirrored under `dist/` at build time).
 * Unlike built-in extensions (enabled unless disabled), built-in skills are
 * normally DISABLED by default and must be enabled explicitly in
 * `settings.json` under `enabledBuiltinSkills` (see `pizza builtin enable
 * <id>`). Entries marked `enabledByDefault` invert that: they load unless the
 * user disables them, recorded under `disabledBuiltinSkills`.
 *
 * To add a new built-in skill:
 * 1. Create a folder under `src/builtin-skills/<id>/` with a valid `SKILL.md`
 *    (frontmatter `name` must match `<id>`; a `description` is required).
 * 2. Register the id in `BUILTIN_SKILLS` below (set `enabledByDefault` for
 *    skills that should be on out of the box).
 * 3. Keep ids stable: they are persisted in user settings.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getBuiltinSkillsDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { SkillFrontmatter } from "../core/skills/skills.js";

interface BuiltinSkillDef {
	/** Stable id (= directory name = skill name), persisted in user settings. */
	id: string;
	/** When true, the skill loads unless the user explicitly disables it. */
	enabledByDefault?: boolean;
}

/** All built-in skills, in listing order. */
const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = [
	{ id: "pizza-self-optimization" },
	{ id: "pizza-customization", enabledByDefault: true },
];

export interface BuiltinSkillInfo {
	/** Stable id (= directory name = skill name). */
	id: string;
	/** Skill name (from SKILL.md frontmatter, falls back to the id). */
	name: string;
	/** Short description (from SKILL.md frontmatter). */
	description: string;
	/** Absolute path of the bundled SKILL.md. */
	path: string;
}

/** All built-in skill ids. */
export function getBuiltinSkillIds(): string[] {
	return BUILTIN_SKILLS.map((def) => def.id);
}

/** Whether `id` refers to a built-in skill. */
export function isBuiltinSkillId(id: string): boolean {
	return BUILTIN_SKILLS.some((def) => def.id === id);
}

/** Whether `id` is a built-in skill that ships enabled by default. */
export function isBuiltinSkillDefaultEnabled(id: string): boolean {
	return BUILTIN_SKILLS.find((def) => def.id === id)?.enabledByDefault === true;
}

/**
 * Effective enabled state of a built-in skill: opt-in ids need an
 * `enabledIds` (allowlist) entry; `enabledByDefault` ids load unless a
 * `disabledIds` (denylist) entry opts out. The denylist always wins, so a
 * stale allowlist entry cannot resurrect a skill the user turned off.
 */
export function isBuiltinSkillEnabled(
	id: string,
	enabledIds: ReadonlySet<string>,
	disabledIds: ReadonlySet<string>,
): boolean {
	if (disabledIds.has(id)) return false;
	return enabledIds.has(id) || isBuiltinSkillDefaultEnabled(id);
}

/** Absolute path of a built-in skill's SKILL.md (exists only when bundled assets are present). */
export function getBuiltinSkillPath(id: string): string {
	return join(getBuiltinSkillsDir(), id, "SKILL.md");
}

/**
 * SKILL.md paths for the built-in skills effectively enabled via settings, in
 * registry order. Paths are returned even if missing on disk — the skills
 * loader reports a diagnostic for those.
 */
export function getEnabledBuiltinSkillPaths(
	enabledIds: ReadonlySet<string>,
	disabledIds: ReadonlySet<string> = new Set(),
): string[] {
	return BUILTIN_SKILLS.filter((def) => isBuiltinSkillEnabled(def.id, enabledIds, disabledIds)).map((def) =>
		getBuiltinSkillPath(def.id),
	);
}

/** Read name/description from a built-in skill's SKILL.md, falling back to the id. */
export function getBuiltinSkillInfo(id: string): BuiltinSkillInfo {
	const path = getBuiltinSkillPath(id);
	let name = id;
	let description = "";
	if (existsSync(path)) {
		try {
			const { frontmatter } = parseFrontmatter<SkillFrontmatter>(readFileSync(path, "utf-8"));
			name = frontmatter.name || id;
			description = frontmatter.description || "";
		} catch {
			// Fall back to id / empty description on parse errors.
		}
	}
	return { id, name, description, path };
}

/** Info for every built-in skill, regardless of enabled state (for UI / CLI). */
export function getBuiltinSkillInfos(): BuiltinSkillInfo[] {
	return getBuiltinSkillIds().map((id) => getBuiltinSkillInfo(id));
}
