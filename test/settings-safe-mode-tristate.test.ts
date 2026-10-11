/**
 * safeMode is a tri-state: true | false | "auto".
 *
 * Previously `getSafeMode()` returned a plain boolean, so the value handed to
 * the IntentClassifier could never be `undefined` — which made the classifier's
 * entire "defer to the per-category require_approval_* gates" branch
 * unreachable from application settings. The per-category knobs looked
 * configurable but silently did nothing.
 *
 * `getSafeModeSetting()` now preserves the tri-state ("auto" → undefined) while
 * `getSafeMode()` stays boolean for the binary UI toggle.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/config/settings-manager.js";
import { IntentClassifier } from "../src/core/intent/classifier.js";

describe("SettingsManager — safeMode tri-state", () => {
	const testDir = join(process.cwd(), "test-safe-mode-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const settingsPath = join(agentDir, "settings.json");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pizza"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	function writeSettings(settings: Record<string, unknown>): void {
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	}

	it("defaults to \"auto\" (per-category gates) when safeMode is unset", () => {
		writeSettings({});
		const manager = SettingsManager.create(projectDir, agentDir);
		// Binary UI toggle: not explicitly on.
		expect(manager.getSafeMode()).toBe(false);
		// Classifier receives undefined (= defer to per-category approvals).
		// SECURITY: the old default was false — auto-run EVERYTHING including
		// dangerous shell. An unset safeMode now gates writes/edits/unknown.
		expect(manager.getSafeModeSetting()).toBeUndefined();
	});

	it("headless callers can keep the legacy auto-run default explicitly", () => {
		writeSettings({});
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getSafeModeSettingWithDefault(false)).toBe(false);
		expect(manager.getSafeModeSettingWithDefault("auto")).toBeUndefined();
	});

	it("an explicit settings.json value beats any caller default", () => {
		writeSettings({ safeMode: true });
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getSafeModeSettingWithDefault(false)).toBe(true);

		writeSettings({ safeMode: false });
		const manager2 = SettingsManager.create(projectDir, agentDir);
		expect(manager2.getSafeModeSettingWithDefault("auto")).toBe(false);
	});

	it("maps \"auto\" to undefined so the classifier defers to per-category gates", () => {
		writeSettings({ safeMode: "auto" });
		const manager = SettingsManager.create(projectDir, agentDir);

		// The binary UI toggle reports "not explicitly on"...
		expect(manager.getSafeMode()).toBe(false);
		// ...but the classifier receives undefined, i.e. "defer".
		expect(manager.getSafeModeSetting()).toBeUndefined();
	});

	it("keeps explicit true/false distinct from auto", () => {
		writeSettings({ safeMode: true });
		expect(SettingsManager.create(projectDir, agentDir).getSafeModeSetting()).toBe(true);

		writeSettings({ safeMode: false });
		expect(SettingsManager.create(projectDir, agentDir).getSafeModeSetting()).toBe(false);
	});

	it("exposes per-category approval defaults (gated policy: unknown + dangerous)", () => {
		writeSettings({});
		const approvals = SettingsManager.create(projectDir, agentDir).getApprovalSettings();
		expect(approvals).toEqual({ writes: false, edits: false, shellModerate: false, unknown: true });
	});

	it("honours per-category overrides from settings.json", () => {
		writeSettings({ safeMode: "auto", approvals: { writes: true, shellModerate: true } });
		const approvals = SettingsManager.create(projectDir, agentDir).getApprovalSettings();
		expect(approvals).toEqual({ writes: true, edits: false, shellModerate: true, unknown: true });
	});

	it("end-to-end: \"auto\" + approvals actually gates the matching tool call", () => {
		writeSettings({ safeMode: "auto", approvals: { writes: true, edits: false } });
		const manager = SettingsManager.create(projectDir, agentDir);
		const approvals = manager.getApprovalSettings();

		const classifier = new IntentClassifier({
			safe_mode: manager.getSafeModeSetting(),
			require_approval_writes: approvals.writes,
			require_approval_edits: approvals.edits,
			require_approval_shell_moderate: approvals.shellModerate,
			require_approval_unknown: approvals.unknown,
		});

		// writes gated, edits not — this is the branch that was dead before.
		expect(classifier.classify("write", { path: "a.txt" }).requires_approval).toBe(true);
		expect(classifier.classify("edit", { path: "a.txt" }).requires_approval).toBe(false);
	});

	it("safeMode:false still overrides every per-category gate", () => {
		writeSettings({ safeMode: false, approvals: { writes: true, edits: true, unknown: true } });
		const manager = SettingsManager.create(projectDir, agentDir);
		const approvals = manager.getApprovalSettings();

		const classifier = new IntentClassifier({
			safe_mode: manager.getSafeModeSetting(),
			require_approval_writes: approvals.writes,
			require_approval_edits: approvals.edits,
			require_approval_shell_moderate: approvals.shellModerate,
			require_approval_unknown: approvals.unknown,
		});

		// Explicit opt-out means nothing is gated — unchanged default behaviour.
		expect(classifier.classify("write", { path: "a.txt" }).requires_approval).toBe(false);
		expect(classifier.classify("edit", { path: "a.txt" }).requires_approval).toBe(false);
	});

	it("round-trips \"auto\" through setSafeMode", async () => {
		writeSettings({});
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setSafeMode("auto");
		expect(manager.getSafeModeSetting()).toBeUndefined();
		// Writes are queued on a promise chain — flush before re-reading from disk.
		await manager.flush();
		expect(SettingsManager.create(projectDir, agentDir).getSafeModeSetting()).toBeUndefined();
	});
});