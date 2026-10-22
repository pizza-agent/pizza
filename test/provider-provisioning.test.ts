/**
 * Regression coverage for the trusted Local -> Remote provider provisioning
 * transaction. A broken implementation must either leave all target files
 * untouched or restore them completely.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyProviderProvisioningEnvelope,
	parseProviderProvisioningEnvelope,
	type ProviderProvisioningEnvelope,
} from "../src/core/remote/provider-provisioning.js";

const tempDirs: string[] = [];

async function createAgentDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pizza-provider-provisioning-"));
	tempDirs.push(dir);
	return dir;
}

function envelope(
	overrides: Partial<ProviderProvisioningEnvelope> = {},
): ProviderProvisioningEnvelope {
	return {
		schemaVersion: 1,
		syncId: "sync-1",
		source: {
			modelsRevision: "models:1",
			settingsRevision: "settings:1",
			credentialsRevision: "auth:1",
		},
		models: {
			providers: {
				"custom-provider-a": {
					name: "Provider A",
					api: "openai-completions",
					baseUrl: "https://example.test/v1",
					models: [{ id: "model-a", name: "Model A" }],
				},
			},
		},
		settings: {
			defaultProvider: "custom-provider-a",
			defaultModel: "model-a",
			defaultThinkingLevel: "high",
		},
		credentials: {
			schemaVersion: 1,
			entries: {
				"custom-provider-a": { type: "api_key", key: "test-secret-a" },
			},
		},
		...overrides,
	};
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("provider provisioning target", () => {
	it("atomically replaces provider layers while preserving unrelated settings", async () => {
		const agentDir = await createAgentDir();
		await writeFile(join(agentDir, "auth.json"), '{"old":{"type":"api_key","key":"old"}}\n');
		await writeFile(join(agentDir, "models.json"), '{"providers":{"old":{"api":"openai-completions"}}}\n');
		await writeFile(
			join(agentDir, "settings.json"),
			'{"theme":"pizza-dark","defaultProvider":"old","defaultModel":"old-model"}\n',
		);
		await chmod(join(agentDir, "auth.json"), 0o644);

		const result = await applyProviderProvisioningEnvelope(envelope(), { agentDir });

		expect(result).toMatchObject({
			status: "applied",
			personalProviderCount: 1,
			credentialCount: 1,
			rolledBack: false,
		});
		expect(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))).toEqual(
			envelope().credentials.entries,
		);
		expect(JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"))).toEqual(
			envelope().models,
		);
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual({
			theme: "pizza-dark",
			defaultProvider: "custom-provider-a",
			defaultModel: "model-a",
			defaultThinkingLevel: "high",
		});
		if (process.platform !== "win32") {
			// Windows does not expose POSIX permission bits through fs.stat().
			for (const file of ["auth.json", "models.json", "settings.json"]) {
				expect((await stat(join(agentDir, file))).mode & 0o777).toBe(0o600);
			}
		}

		const replay = await applyProviderProvisioningEnvelope(envelope(), { agentDir });
		expect(replay.status).toBe("already_applied");
	});

	it("mirrors empty local state and removes only the narrow default fields", async () => {
		const agentDir = await createAgentDir();
		await writeFile(join(agentDir, "auth.json"), '{"old":{"type":"api_key","key":"old"}}\n');
		await writeFile(join(agentDir, "models.json"), '{"providers":{"old":{"api":"openai-completions"}}}\n');
		await writeFile(
			join(agentDir, "settings.json"),
			'{"theme":"remote-theme","defaultProvider":"old","defaultModel":"old","defaultThinkingLevel":"low"}\n',
		);

		const result = await applyProviderProvisioningEnvelope(
			envelope({
				models: { providers: {} },
				credentials: { schemaVersion: 1, entries: {} },
				settings: {
					defaultProvider: null,
					defaultModel: null,
					defaultThinkingLevel: null,
				},
			}),
			{ agentDir },
		);

		expect(result.status).toBe("applied");
		expect(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))).toEqual({});
		expect(JSON.parse(await readFile(join(agentDir, "models.json"), "utf8"))).toEqual({
			providers: {},
		});
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual({
			theme: "remote-theme",
		});
	});

	it("restores every touched file when a later write fails", async () => {
		const agentDir = await createAgentDir();
		const originalAuth = '{"old":{"type":"api_key","key":"old"}}\n';
		const originalModels = '{"providers":{"old":{"api":"openai-completions"}}}\n';
		const originalSettings = '{"theme":"before","defaultProvider":"old","defaultModel":"old"}\n';
		await writeFile(join(agentDir, "auth.json"), originalAuth);
		await writeFile(join(agentDir, "models.json"), originalModels);
		await writeFile(join(agentDir, "settings.json"), originalSettings);

		let writes = 0;
		const result = await applyProviderProvisioningEnvelope(envelope(), {
			agentDir,
			atomicWrite: async (path, bytes, mode) => {
				writes += 1;
				if (writes === 3) throw new Error("injected third-write failure");
				await writeFile(path, bytes, { mode });
				await chmod(path, mode ?? 0o600);
			},
		});

		expect(result).toMatchObject({
			status: "failed",
			errorCode: "target_write_failed",
			rolledBack: true,
		});
		await expect(readFile(join(agentDir, "auth.json"), "utf8")).resolves.toBe(originalAuth);
		await expect(readFile(join(agentDir, "models.json"), "utf8")).resolves.toBe(originalModels);
		await expect(readFile(join(agentDir, "settings.json"), "utf8")).resolves.toBe(
			originalSettings,
		);
	});

	it("rejects unknown or malformed credential allowlist entries before writing", () => {
		const invalid = envelope();
		(invalid.credentials.entries["custom-provider-a"] as Record<string, unknown>).type = "browser_cookie";

		expect(() => parseProviderProvisioningEnvelope(invalid)).toThrow(
			"not in the credential allowlist",
		);
		expect(() =>
			parseProviderProvisioningEnvelope({
				...envelope(),
				unexpected: true,
			}),
		).toThrow("must contain exactly");
	});
});
