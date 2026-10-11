import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/config/resource-loader.js";
import { SettingsManager } from "../src/core/config/settings-manager.js";

describe("refreshSkillsIfChanged", () => {
	it("picks up skills added and removed after initial reload", async () => {
		const cwd = "/tmp/pizza-refresh-test";
		const agentDir = "/tmp/pizza-refresh-test-agent";
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, isMainAgent: false });
		await loader.reload();
		const names = () => loader.getSkills().skills.map((s) => s.name);
		expect(names()).not.toContain("my-new-skill");

		// Nothing changed → no reload.
		expect(await loader.refreshSkillsIfChanged()).toBe(false);

		// New skill on disk → reload picks it up.
		mkdirSync(`${cwd}/.agents/skills/my-new-skill`, { recursive: true });
		writeFileSync(
			`${cwd}/.agents/skills/my-new-skill/SKILL.md`,
			"---\nname: my-new-skill\ndescription: A skill added after startup\n---\nbody\n",
		);
		expect(await loader.refreshSkillsIfChanged()).toBe(true);
		expect(names()).toContain("my-new-skill");

		// Stable state → no reload.
		expect(await loader.refreshSkillsIfChanged()).toBe(false);

		// Skill removed → reload drops it.
		rmSync(`${cwd}/.agents/skills/my-new-skill`, { recursive: true, force: true });
		expect(await loader.refreshSkillsIfChanged()).toBe(true);
		expect(names()).not.toContain("my-new-skill");

		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});
});
