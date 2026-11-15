import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { copyReleaseContent } from "../scripts/copy-release-content.mjs";

it("ships public examples without local docs, infra, deployment dependencies or credentials", () => {
	const dir = mkdtempSync(join(tmpdir(), "pizza-release-content-"));
	const source = join(dir, "source"), target = join(dir, "dist");
	const publicFiles = ["CHANGELOG.md", "examples/sdk-server.mjs", "examples/theme-aurora/theme.json"];
	const privateFiles = ["docs/guide.md", "infra/mcp-oauth/worker.mjs",
		"examples/tool/node_modules/wrangler/index.js", "examples/tool/.wrangler/state/session.json",
		"examples/tool/.dev.vars", "examples/tool/.dev.vars.production", "examples/tool/.env", "examples/tool/.env.local"];
	try {
		for (const file of [...publicFiles, ...privateFiles]) {
			const path = join(source, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file);
		}
		copyReleaseContent(source, target);
		for (const file of publicFiles) expect(readFileSync(join(target, file), "utf8")).toBe(file);
		for (const file of privateFiles) expect(existsSync(join(target, file))).toBe(false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
