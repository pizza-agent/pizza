import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PIZZA_GMAIL_DESKTOP_CLIENT_ID } from "../src/builtin-extensions/connectors/catalog.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup() { const dir = mkdtempSync(join(tmpdir(), "pizza-desktop-oauth-")); dirs.push(dir); mkdirSync(join(dir, "scripts")); const script = join(dir, "scripts", "prepare.mjs"); copyFileSync(resolve("scripts/prepare-google-desktop-oauth.mjs"), script); const input = join(dir, "client.json"), output = join(dir, "dist", "assets", "google-desktop-oauth.json"); const run = (enabled = true) => spawnSync(process.execPath, [script], { env: { ...process.env, PIZZA_GOOGLE_DESKTOP_CLIENT_FILE: enabled ? input : "" }, encoding: "utf8" }); return { input, output, run }; }
describe("Desktop OAuth release registration", () => {
	it("packages only the expected installed registration without printing its value", () => {
		const { input, output, run } = setup();
		writeFileSync(input, JSON.stringify({ installed: { client_id: PIZZA_GMAIL_DESKTOP_CLIENT_ID, client_secret: "fixture-desktop-registration", project_id: "unused", refresh_token: "must-not-package" } }));
		const result = run();
		expect(result.status).toBe(0);
		expect(result.stdout + result.stderr).not.toContain("fixture-desktop-registration");
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ installed: { client_id: PIZZA_GMAIL_DESKTOP_CLIENT_ID, client_secret: "fixture-desktop-registration" } });
	});
	it.each([{ web: { client_id: PIZZA_GMAIL_DESKTOP_CLIENT_ID, client_secret: "web-secret" } }, { installed: { client_id: "other-app", client_secret: "other-secret" } }, { installed: { client_id: PIZZA_GMAIL_DESKTOP_CLIENT_ID } }])("rejects a Web client, another product or incomplete credentials", (value) => {
		const { input, output, run } = setup();
		writeFileSync(input, JSON.stringify(value));
		expect(run().status).not.toBe(0);
		expect(existsSync(output)).toBe(false);
	});
	it("removes stale registration when rebuilding without the release input", () => {
		const { input, output, run } = setup();
		writeFileSync(input, JSON.stringify({ installed: { client_id: PIZZA_GMAIL_DESKTOP_CLIENT_ID, client_secret: "fixture" } }));
		expect(run().status).toBe(0);
		expect(run(false).status).toBe(0);
		expect(existsSync(output)).toBe(false);
	});
});
