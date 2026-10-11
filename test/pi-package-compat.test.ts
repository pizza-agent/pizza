/**
 * Compatibility tests for packages published for the upstream pi ecosystem
 * (https://pi.dev/packages). Those packages declare a "pi" package.json
 * manifest (instead of "pizza") and import "@earendil-works/pi-coding-agent"
 * (or the legacy "@mariozechner/*" specifiers) plus the "typebox" package.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";

describe("pi package compatibility", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should load an extension declared via a pi manifest importing pi specifiers", async () => {
		const pkgDir = join(tempDir, "pi-pkg");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({
				name: "pi-pkg",
				pi: {
					extensions: ["./index.ts"],
				},
			}),
		);
		writeFileSync(
			join(pkgDir, "index.ts"),
			`
import { Type } from "typebox";
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "pi_tool",
		label: "pi tool",
		description: "tool from a pi package",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	});
	if (typeof isToolCallEventType !== "function") {
		throw new Error("isToolCallEventType was not resolved");
	}
}
`,
		);

		const result = await discoverAndLoadExtensions([], cwd, agentDir);
		// Not discovered via agentDir; load through the explicit configured path instead.
		expect(result.errors).toEqual([]);

		const withPkg = await discoverAndLoadExtensions([pkgDir], cwd, agentDir);
		expect(withPkg.errors).toEqual([]);
		expect(withPkg.extensions).toHaveLength(1);
		expect(withPkg.extensions[0].tools.has("pi_tool")).toBe(true);
	});

	it("should load an extension importing the legacy @mariozechner/pi-coding-agent specifier", async () => {
		const pkgDir = join(tempDir, "legacy-pi-pkg");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "index.ts"),
			`
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("legacy-pi-cmd", {
		description: "command from a legacy pi package",
		handler: async () => {},
	});
}
`,
		);

		const result = await discoverAndLoadExtensions([pkgDir], cwd, agentDir);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("legacy-pi-cmd")).toBe(true);
	});
});
