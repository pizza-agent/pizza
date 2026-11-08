import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliTestTool } from "./helpers/cli-tool.js";

const testDir = join(tmpdir(), "pizza-chained-builtin-it-" + Math.random().toString(36).slice(2));
afterEach(() => {
	try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("cli tool: chained-builtin failure hint", () => {
	beforeEach(() => { mkdirSync(testDir, { recursive: true }); });

	it("appends a built-in hint when a built-in is chained after && and the command fails", async () => {
		const bash = createCliTestTool(testDir);
		// `echo before` succeeds, then `_read` is run by the shell → "command not found"
		// → non-zero exit. The hint should point at _read.
		let error: Error | undefined;
		try {
			await bash.execute("probe", { command: "echo before && _read nonexistent-file-xyz.ts" });
		} catch (e) {
			error = e as Error;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error!.message).toContain("Command exited with code");
		expect(error!.message).toContain("_read");
		expect(error!.message).toMatch(/cannot be chained after shell operators|ran it as an unknown command/i);
	});

	it("does not add a hint for a normal failing shell command", async () => {
		const bash = createCliTestTool(testDir);
		let error: Error | undefined;
		try {
			await bash.execute("probe", { command: "git --no-such-flag-xyz" });
		} catch (e) {
			error = e as Error;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error!.message).toContain("Command exited with code");
		expect(error!.message).not.toMatch(/ran it as an unknown command/i);
	});
});
