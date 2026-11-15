import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { copyReleaseContent } from "../scripts/copy-release-content.mjs";

it("ships the OAuth service sources without deployment dependencies, local state or credentials", () => {
	const dir = mkdtempSync(join(tmpdir(), "pizza-release-content-"));
	const source = join(dir, "source"), target = join(dir, "dist");
	const publicFiles = ["CHANGELOG.md", "docs/guide.md", "examples/mcp-oauth/worker.mjs", "examples/mcp-oauth/client.json", "examples/mcp-oauth/package-lock.json"];
	const privateFiles = ["examples/mcp-oauth/node_modules/wrangler/index.js", "examples/mcp-oauth/.wrangler/state/session.json", "examples/mcp-oauth/.dev.vars", "examples/mcp-oauth/.dev.vars.production", "examples/mcp-oauth/.env", "examples/mcp-oauth/.env.local"];
	try {
		for (const file of [...publicFiles, ...privateFiles]) {
			const path = join(source, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file);
		}
		copyReleaseContent(source, target);
		for (const file of publicFiles) expect(readFileSync(join(target, file), "utf8")).toBe(file);
		for (const file of privateFiles) expect(existsSync(join(target, file))).toBe(false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
