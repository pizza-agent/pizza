import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGateway } from "../packages/gateway/gateway-lifecycle.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe.skipIf(process.platform === "win32")("gateway startup diagnostics", () => {
	it("reports an early exit and captures daemon output before the boot timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pizza-boot-"));
		dirs.push(dir);
		const cli = join(dir, "fixture.cjs");
		const socket = join(dir, "gateway.sock");
		const log = join(dir, "gateway.log");
		writeFileSync(cli, 'console.log("boot stdout"); console.error("boot failed"); process.exitCode = 42;');
		await expect(ensureGateway(dir, socket, undefined, cli)).rejects.toThrow(
			`Gateway process exited before binding ${socket} (exited with code 42). Daemon log: ${log}`,
		);
		expect(readFileSync(log, "utf8")).toContain("boot stdout");
		expect(readFileSync(log, "utf8")).toContain("boot failed");
	}, 5_000);
});
