import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUILTIN_EXTENSION_SOURCE,
	ExtensionRegistry,
	packageSourceToRecord,
	recordToPackageSource,
	withPackageFilters,
} from "../src/core/extension-registry.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { EXTENSION_REGISTRY_FILE, SettingsManager } from "../src/core/settings-manager.js";

describe("ExtensionRegistry", () => {
	it("round-trips records through patch/set/remove", () => {
		const registry = ExtensionRegistry.inMemory();
		expect(registry.list()).toEqual({});

		registry.set("npm:foo", { source: "npm:foo", enabled: true, installed: true });
		expect(registry.get("npm:foo")).toEqual({ source: "npm:foo", enabled: true, installed: true });

		const patched = registry.patch(
			"npm:foo",
			{ enabled: false, version: undefined },
			{ source: "npm:foo", enabled: true },
		);
		expect(patched).toEqual({ source: "npm:foo", enabled: false, installed: true });
		// undefined values are dropped, not stored
		expect(registry.get("npm:foo")?.version).toBeUndefined();

		expect(registry.remove("npm:foo")).toBe(true);
		expect(registry.remove("npm:foo")).toBe(false);
		expect(registry.list()).toEqual({});
	});

	it("keeps insertion order as package load order", () => {
		const registry = ExtensionRegistry.inMemory();
		registry.set("npm:b", { source: "npm:b", enabled: true });
		registry.set("npm:a", { source: "npm:a", enabled: true });
		expect(registry.listPackages().map(([id]) => id)).toEqual(["npm:b", "npm:a"]);
	});

	it("listPackages excludes built-in records", () => {
		const registry = ExtensionRegistry.inMemory();
		registry.set("agent-browser", { source: BUILTIN_EXTENSION_SOURCE, enabled: false });
		registry.set("npm:foo", { source: "npm:foo", enabled: true });
		expect(registry.listPackages().map(([id]) => id)).toEqual(["npm:foo"]);
	});
});

describe("FileExtensionRegistryStorage", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = join(tmpdir(), `extreg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		file = join(dir, "extensions.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists records to disk and reads them back through another instance", () => {
		const a = ExtensionRegistry.file(file);
		a.set("npm:foo", { source: "npm:foo", enabled: true, installed: true, version: "1.0.0" });

		const b = ExtensionRegistry.file(file);
		expect(b.get("npm:foo")).toEqual({ source: "npm:foo", enabled: true, installed: true, version: "1.0.0" });
	});

	it("serializes mutations from concurrent writers through the lock", () => {
		const a = ExtensionRegistry.file(file);
		const b = ExtensionRegistry.file(file);
		for (let i = 0; i < 10; i++) {
			(i % 2 === 0 ? a : b).set(`npm:pkg-${i}`, { source: `npm:pkg-${i}`, enabled: true });
		}
		const ids = Object.keys(ExtensionRegistry.file(file).list());
		expect(ids).toHaveLength(10);
	});

	it("leaves no temp files behind after writes", () => {
		const registry = ExtensionRegistry.file(file);
		registry.set("npm:foo", { source: "npm:foo", enabled: true });
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
	});

	it("reads a corrupt file as empty but refuses to clobber it on mutate", () => {
		writeFileSync(file, "{not json", "utf-8");
		const registry = ExtensionRegistry.file(file);
		expect(registry.list()).toEqual({});
		expect(() => registry.set("npm:foo", { source: "npm:foo", enabled: true })).toThrow();
		expect(readFileSync(file, "utf-8")).toBe("{not json");
	});
});

describe("package source <-> record conversion", () => {
	it("converts plain string sources", () => {
		expect(packageSourceToRecord("npm:foo")).toEqual({ source: "npm:foo", enabled: true, installed: true });
	});

	it("converts filtered object sources and back", () => {
		const record = packageSourceToRecord({ source: "npm:foo", extensions: ["a.ts"], skills: ["s"] });
		expect(record).toEqual({
			source: "npm:foo",
			enabled: true,
			installed: true,
			extensions: ["a.ts"],
			skills: ["s"],
		});
		expect(recordToPackageSource(record)).toEqual({ source: "npm:foo", extensions: ["a.ts"], skills: ["s"] });
	});

	it("withPackageFilters replaces filters but keeps enabled/installed state", () => {
		const record = { source: "npm:foo", enabled: false, installed: true, extensions: ["a.ts"], skills: ["s"] };
		const next = withPackageFilters(record, { source: "npm:foo", prompts: ["p.md"] });
		expect(next).toEqual({ source: "npm:foo", enabled: false, installed: true, prompts: ["p.md"] });
	});
});

describe("legacy settings.json migration", () => {
	let dir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `extreg-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(dir, "agent");
		projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("moves packages and disabledBuiltinExtensions into extensions.json and strips them", async () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: ["npm:foo", { source: "npm:bar", extensions: ["a.ts"] }],
				disabledBuiltinExtensions: ["agent-browser"],
			}),
			"utf-8",
		);

		const settings = SettingsManager.create(projectDir, agentDir);

		const records = settings.extensions.list();
		expect(records["npm:foo"]).toEqual({ source: "npm:foo", enabled: true, installed: true });
		expect(records["npm:bar"]).toMatchObject({ source: "npm:bar", enabled: true, extensions: ["a.ts"] });
		expect(records["agent-browser"]).toEqual({ source: BUILTIN_EXTENSION_SOURCE, enabled: false });

		await settings.flush();
		const onDisk = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(onDisk.packages).toBeUndefined();
		expect(onDisk.disabledBuiltinExtensions).toBeUndefined();
	});

	it("existing registry records win over legacy keys", () => {
		writeFileSync(
			join(agentDir, EXTENSION_REGISTRY_FILE),
			JSON.stringify({ version: 1, extensions: { "npm:foo": { source: "npm:foo", enabled: false, installed: true } } }),
			"utf-8",
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:foo"] }), "utf-8");

		const settings = SettingsManager.create(projectDir, agentDir);
		expect(settings.extensions.get("npm:foo")?.enabled).toBe(false);
	});

	it("does not clobber legacy keys when extensions.json is corrupt", () => {
		writeFileSync(join(agentDir, EXTENSION_REGISTRY_FILE), "{corrupt", "utf-8");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:foo"] }), "utf-8");

		SettingsManager.create(projectDir, agentDir);
		const onDisk = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(onDisk.packages).toEqual(["npm:foo"]);
	});
});

describe("package enable/disable via PackageManager", () => {
	let dir: string;
	let agentDir: string;
	let projectDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		dir = join(tmpdir(), `extreg-pm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(dir, "agent");
		projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("toggles a package by identity regardless of pinned version", () => {
		packageManager.addSourceToSettings("npm:foo@1.0.0");
		expect(packageManager.setPackageEnabled("npm:foo", false)).toBe(true);
		expect(settingsManager.extensions.get("npm:foo@1.0.0")?.enabled).toBe(false);
		expect(packageManager.listConfiguredPackages()[0].enabled).toBe(false);
	});

	it("returns false for an unknown package", () => {
		expect(packageManager.setPackageEnabled("npm:nope", false)).toBe(false);
	});

	it("disabled packages are excluded from resolve", async () => {
		const pkgDir = join(dir, "local-pkg");
		mkdirSync(join(pkgDir, "extensions"), { recursive: true });
		writeFileSync(join(pkgDir, "extensions", "index.ts"), "export default function() {}");

		packageManager.addSourceToSettings(pkgDir);
		const enabled = await packageManager.resolve();
		expect(enabled.extensions.some((r) => r.path.includes("local-pkg"))).toBe(true);

		packageManager.setPackageEnabled(pkgDir, false);
		const disabled = await packageManager.resolve();
		expect(disabled.extensions.some((r) => r.path.includes("local-pkg"))).toBe(false);
	});
});
