import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getBuiltinSkillIds,
	getBuiltinSkillInfos,
	getBuiltinSkillPath,
	getEnabledBuiltinSkillPaths,
	isBuiltinSkillDefaultEnabled,
	isBuiltinSkillId,
} from "../src/builtin-skills/index.js";
import { DefaultResourceLoader } from "../src/core/config/resource-loader.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";
import { parseFrontmatter } from "../src/utils/frontmatter.js";

describe("built-in skills registry", () => {
	it("has a non-empty, unique set of ids and enables create-pet by default", () => {
		const ids = getBuiltinSkillIds();
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("create-pet");
		expect(isBuiltinSkillDefaultEnabled("create-pet")).toBe(true);
	});

	it("isBuiltinSkillId matches registry ids only", () => {
		expect(isBuiltinSkillId(getBuiltinSkillIds()[0])).toBe(true);
		expect(isBuiltinSkillId("not-a-builtin-skill")).toBe(false);
	});

	it("ships a valid SKILL.md for every registered id", () => {
		for (const id of getBuiltinSkillIds()) {
			const path = getBuiltinSkillPath(id);
			expect(existsSync(path), `${path} should exist`).toBe(true);

			const { frontmatter } = parseFrontmatter<{ name?: string; description?: string }>(
				readFileSync(path, "utf-8"),
			);
			// Per Agent Skills spec: name matches the directory, description required.
			expect(frontmatter.name, `${id}: name frontmatter must match directory`).toBe(id);
			expect(frontmatter.description?.trim(), `${id}: description is required`).toBeTruthy();
			expect((frontmatter.description ?? "").length).toBeLessThanOrEqual(1024);
		}
	});

	it("getBuiltinSkillInfos reads name/description from the SKILL.md files", () => {
		const infos = getBuiltinSkillInfos();
		expect(infos.map((info) => info.id)).toEqual(getBuiltinSkillIds());
		for (const info of infos) {
			expect(info.name).toBe(info.id);
			expect(info.description.length).toBeGreaterThan(0);
			expect(info.path).toBe(getBuiltinSkillPath(info.id));
		}
	});

	it("getEnabledBuiltinSkillPaths returns only enabled ids, in registry order", () => {
		const ids = getBuiltinSkillIds();
		// Default-enabled ids ship on without any allowlist entry.
		const defaultOn = ids.filter((id) => isBuiltinSkillDefaultEnabled(id));
		expect(defaultOn.length).toBeGreaterThan(0);
		expect(getEnabledBuiltinSkillPaths(new Set())).toEqual(defaultOn.map((id) => getBuiltinSkillPath(id)));
		// Unknown ids are ignored; known ones come back in registry order.
		const enabled = new Set([ids[0], "not-a-builtin-skill"]);
		const expected = ids.filter((id) => enabled.has(id) || defaultOn.includes(id));
		expect(getEnabledBuiltinSkillPaths(enabled)).toEqual(expected.map((id) => getBuiltinSkillPath(id)));
		// The denylist opts a default-enabled skill out.
		expect(getEnabledBuiltinSkillPaths(new Set(), new Set(defaultOn))).toEqual([]);
		// …and wins over a stale allowlist entry.
		expect(getEnabledBuiltinSkillPaths(new Set(defaultOn), new Set(defaultOn))).toEqual([]);
	});
});

describe("built-in skills loading (resource loader)", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `builtin-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(join(agentDir), { recursive: true });
		mkdirSync(join(cwd), { recursive: true });
		originalAgentDir = process.env.PIZZA_CODING_AGENT_DIR;
		process.env.PIZZA_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PIZZA_CODING_AGENT_DIR;
		} else {
			process.env.PIZZA_CODING_AGENT_DIR = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSettings(settings: Record<string, unknown>): void {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, "\t"));
	}

	function readSettings(): Record<string, unknown> {
		const path = join(agentDir, "settings.json");
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
	}

	it("load only enabledByDefault skills with no settings", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		for (const id of getBuiltinSkillIds()) {
			expect(skills.some((s) => s.name === id), `${id}`).toBe(isBuiltinSkillDefaultEnabled(id));
		}
	});

	it("stay unloaded when an enabledByDefault skill is denylisted", async () => {
		writeSettings({ disabledBuiltinSkills: ["pizza-customization"] });
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		expect(loader.getSkills().skills.some((s) => s.name === "pizza-customization")).toBe(false);
		const entry = loader.getSkillCatalog().find((e) => e.skill.name === "pizza-customization");
		expect(entry?.enabled).toBe(false);
		expect(entry?.builtinId).toBe("pizza-customization");
	});

	it("load when enabled via settings.enabledBuiltinSkills, attributed to the builtin source", async () => {
		writeSettings({ enabledBuiltinSkills: ["pizza-self-optimization"] });
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills } = loader.getSkills();
		const skill = skills.find((s) => s.name === "pizza-self-optimization");
		expect(skill).toBeDefined();
		expect(skill?.filePath).toBe(getBuiltinSkillPath("pizza-self-optimization"));
		expect(skill?.sourceInfo.source).toBe("builtin");
	});

	it("lose name collisions to user skills (user overrides builtin)", async () => {
		writeSettings({ enabledBuiltinSkills: ["pizza-self-optimization"] });
		const userSkillDir = join(agentDir, "skills");
		mkdirSync(userSkillDir, { recursive: true });
		writeFileSync(
			join(userSkillDir, "pizza-self-optimization.md"),
			"---\nname: pizza-self-optimization\ndescription: user override\n---\nuser content",
		);

		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const { skills, diagnostics } = loader.getSkills();
		const skill = skills.find((s) => s.name === "pizza-self-optimization");
		expect(skill?.filePath).toBe(join(userSkillDir, "pizza-self-optimization.md"));
		expect(diagnostics.some((d) => d.type === "collision")).toBe(true);
	});

	it("are skipped entirely with noBuiltinSkills, even when enabled", async () => {
		writeSettings({ enabledBuiltinSkills: ["pizza-self-optimization"] });
		const loader = new DefaultResourceLoader({ cwd, agentDir, noBuiltinSkills: true });
		await loader.reload();

		expect(loader.getSkills().skills.some((s) => s.name === "pizza-self-optimization")).toBe(false);
	});

	it("are skipped with noSkills, even when enabled", async () => {
		writeSettings({ enabledBuiltinSkills: ["pizza-self-optimization"] });
		const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
		await loader.reload();

		expect(loader.getSkills().skills.some((s) => s.name === "pizza-self-optimization")).toBe(false);
	});

	it("lists every built-in skill in the catalog with its effective enabled state", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();

		const catalog = loader.getSkillCatalog();
		for (const id of getBuiltinSkillIds()) {
			const entry = catalog.find((e) => e.skill.name === id);
			expect(entry, `${id} should be in the catalog`).toBeDefined();
			expect(entry?.enabled, `${id}`).toBe(isBuiltinSkillDefaultEnabled(id));
			expect(entry?.builtinId).toBe(id);
			expect(entry?.skill.description.length).toBeGreaterThan(0);
		}
	});

	it("setSkillEnabled toggles a built-in skill through the allowlist", async () => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();

		expect(loader.setSkillEnabled("pizza-self-optimization", true)).toBe(true);
		expect(loader.getSkills().skills.some((s) => s.name === "pizza-self-optimization")).toBe(true);
		await settingsManager.flush();
		expect(readSettings().enabledBuiltinSkills).toContain("pizza-self-optimization");

		expect(loader.setSkillEnabled("pizza-self-optimization", false)).toBe(true);
		expect(loader.getSkills().skills.some((s) => s.name === "pizza-self-optimization")).toBe(false);
		// Still listed (disabled) so the UI can turn it back on.
		expect(loader.getSkillCatalog().some((e) => e.skill.name === "pizza-self-optimization" && !e.enabled)).toBe(true);
	});

	it("setSkillEnabled toggles an enabledByDefault built-in through the denylist", async () => {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();

		// On by default; disabling writes the denylist, not the allowlist.
		expect(loader.getSkills().skills.some((s) => s.name === "pizza-customization")).toBe(true);
		expect(loader.setSkillEnabled("pizza-customization", false)).toBe(true);
		expect(loader.getSkills().skills.some((s) => s.name === "pizza-customization")).toBe(false);
		await settingsManager.flush();
		expect(readSettings().disabledBuiltinSkills).toContain("pizza-customization");
		expect(readSettings().enabledBuiltinSkills).toBeUndefined();

		expect(loader.setSkillEnabled("pizza-customization", true)).toBe(true);
		expect(loader.getSkills().skills.some((s) => s.name === "pizza-customization")).toBe(true);
		await settingsManager.flush();
		expect(readSettings().disabledBuiltinSkills).toBeUndefined();
	});

	it("setSkillEnabled disables a discovered skill through the denylist, keeping it listed", async () => {
		const userSkillDir = join(agentDir, "skills", "my-skill");
		mkdirSync(userSkillDir, { recursive: true });
		writeFileSync(join(userSkillDir, "SKILL.md"), "---\nname: my-skill\ndescription: mine\n---\nbody");

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getSkills().skills.some((s) => s.name === "my-skill")).toBe(true);

		expect(loader.setSkillEnabled("my-skill", false)).toBe(true);
		expect(loader.getSkills().skills.some((s) => s.name === "my-skill")).toBe(false);
		await settingsManager.flush();
		expect(readSettings().disabledSkills).toContain("my-skill");
		const entry = loader.getSkillCatalog().find((e) => e.skill.name === "my-skill");
		expect(entry?.enabled).toBe(false);
		expect(entry?.builtinId).toBeUndefined();

		expect(loader.setSkillEnabled("my-skill", true)).toBe(true);
		expect(loader.getSkills().skills.some((s) => s.name === "my-skill")).toBe(true);
		await settingsManager.flush();
		expect(readSettings().disabledSkills).toBeUndefined();
	});

	it("setSkillEnabled reports unknown skill names", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.setSkillEnabled("not-a-skill", false)).toBe(false);
	});

	it("deleteSkill removes a user skill from disk and the catalog", async () => {
		const userSkillDir = join(agentDir, "skills", "my-skill");
		mkdirSync(userSkillDir, { recursive: true });
		writeFileSync(join(userSkillDir, "SKILL.md"), "---\nname: my-skill\ndescription: mine\n---\nbody");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getSkills().skills.some((s) => s.name === "my-skill")).toBe(true);

		expect(loader.deleteSkill("my-skill")).toBe(true);
		expect(existsSync(userSkillDir)).toBe(false);
		expect(loader.getSkills().skills.some((s) => s.name === "my-skill")).toBe(false);
		expect(loader.getSkillCatalog().some((e) => e.skill.name === "my-skill")).toBe(false);
	});

	it("deleteSkill also removes a denylisted skill's settings entry", async () => {
		const skillFile = join(agentDir, "skills", "flat-skill.md");
		mkdirSync(dirname(skillFile), { recursive: true });
		writeFileSync(skillFile, "---\nname: flat-skill\ndescription: mine\n---\nbody");
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		loader.setSkillEnabled("flat-skill", false);
		await settingsManager.flush();
		expect(readSettings().disabledSkills).toContain("flat-skill");

		expect(loader.deleteSkill("flat-skill")).toBe(true);
		expect(existsSync(skillFile)).toBe(false);
		await settingsManager.flush();
		expect(readSettings().disabledSkills).toBeUndefined();
	});

	it("deleteSkill refuses built-in and unknown skills", async () => {
		writeSettings({ enabledBuiltinSkills: ["pizza-self-optimization"] });
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.deleteSkill("pizza-self-optimization")).toBe(false);
		expect(existsSync(getBuiltinSkillPath("pizza-self-optimization"))).toBe(true);
		expect(loader.deleteSkill("not-a-skill")).toBe(false);
	});

	it("reloadSkills picks up enable/disable changes without a full reload", async () => {
		writeSettings({ enabledBuiltinSkills: [] });
		// Share one settings manager between the test and the loader (as the TUI does).
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await loader.reload();
		expect(loader.getSkills().skills.some((s) => s.name === "pizza-self-optimization")).toBe(false);

		settingsManager.setBuiltinSkillEnabled("pizza-self-optimization", true);
		loader.reloadSkills();
		expect(loader.getSkills().skills.some((s) => s.name === "pizza-self-optimization")).toBe(true);

		settingsManager.setBuiltinSkillEnabled("pizza-self-optimization", false);
		loader.reloadSkills();
		expect(loader.getSkills().skills.some((s) => s.name === "pizza-self-optimization")).toBe(false);
	});
});
