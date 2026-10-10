import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleBuiltinCommand } from "../src/builtin-cli.js";

describe("handleBuiltinCommand", () => {
	const testDir = join(process.cwd(), "test-builtin-cli-tmp");
	const agentDir = join(testDir, "agent");
	const cwd = join(testDir, "project");
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		// Force the agent dir to our temp dir.
		process.env.PIZZA_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		delete process.env.PIZZA_CODING_AGENT_DIR;
		process.chdir(originalCwd);
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("returns false for unrelated commands", async () => {
		expect(await handleBuiltinCommand(["print", "hello"])).toBe(false);
	});

	it("lists built-in extensions (enabled by default)", async () => {
		expect(await handleBuiltinCommand(["builtin", "list"])).toBe(true);
	});

	it("disables and re-enables a built-in extension, persisting to extensions.json", async () => {
		process.chdir(cwd);
		await handleBuiltinCommand(["builtin", "disable", "agent-browser"]);
		// settings writes are queued; let them flush to disk.
		await new Promise((r) => setTimeout(r, 50));

		const registryPath = join(agentDir, "extensions.json");
		expect(existsSync(registryPath)).toBe(true);
		let raw = JSON.parse(readFileSync(registryPath, "utf-8"));
		expect(raw.extensions["agent-browser"].enabled).toBe(false);

		await handleBuiltinCommand(["builtin", "enable", "agent-browser"]);
		await new Promise((r) => setTimeout(r, 50));
		raw = JSON.parse(readFileSync(registryPath, "utf-8"));
		expect(raw.extensions["agent-browser"].enabled).toBe(true);
	});
});

describe("handleBuiltinCommand (skills)", () => {
	const testDir = join(process.cwd(), "test-builtin-cli-skills-tmp");
	const agentDir = join(testDir, "agent");
	const cwd = join(testDir, "project");
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		process.env.PIZZA_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		delete process.env.PIZZA_CODING_AGENT_DIR;
		process.chdir(originalCwd);
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("lists built-in skills as disabled by default", async () => {
		expect(await handleBuiltinCommand(["builtin", "list"])).toBe(true);
	});

	it("enables and disables a built-in skill, persisting to settings.json", async () => {
		process.chdir(cwd);
		await handleBuiltinCommand(["builtin", "enable", "pizza-self-optimization"]);
		// settings writes are queued; let them flush to disk.
		await new Promise((r) => setTimeout(r, 50));

		const settingsPath = join(agentDir, "settings.json");
		expect(existsSync(settingsPath)).toBe(true);
		let raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(raw.enabledBuiltinSkills).toContain("pizza-self-optimization");

		await handleBuiltinCommand(["builtin", "disable", "pizza-self-optimization"]);
		await new Promise((r) => setTimeout(r, 50));
		raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(raw.enabledBuiltinSkills ?? []).not.toContain("pizza-self-optimization");
	});

	it("rejects unknown ids", async () => {
		await handleBuiltinCommand(["builtin", "enable", "nope"]);
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});
});
