import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Exercise macOS's actual signature validation rather than mocking codesign.
describe.skipIf(process.platform !== "darwin")("macOS binary preparation", () => {
	const script = resolve("scripts/prepare-macos-binary.mjs");
	function fixture(exitCode = 0) {
		const dir = mkdtempSync(join(tmpdir(), "pizza-signing-"));
		dirs.push(dir);
		const source = join(dir, "fixture.c");
		const binary = join(dir, "pizza");
		writeFileSync(source, `#include <stdio.h>\nint main(void) { puts("fixture"); return ${exitCode}; }\n`);
		const result = spawnSync("cc", [source, "-o", binary], { encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		const run = (verifyOnly = false) => spawnSync(process.execPath, [script, ...(verifyOnly ? ["--verify"] : []), binary], { encoding: "utf8" });
		return { binary, run };
	}

	it("signs an executable and verifies it without changing it", () => {
		const { binary, run } = fixture();
		const prepared = run();
		expect(prepared.status, prepared.stderr).toBe(0);
		const before = readFileSync(binary);
		const verified = run(true);
		expect(verified.status, verified.stderr).toBe(0);
		expect(readFileSync(binary)).toEqual(before);
	});

	it("rejects a damaged artifact during verification and can repair its signature", () => {
		const { binary, run } = fixture();
		expect(run().status).toBe(0);
		const damaged = readFileSync(binary);
		// The 64-bit Mach-O header's reserved field is covered by the signature.
		damaged[28] ^= 1;
		writeFileSync(binary, damaged);
		expect(run(true).status).not.toBe(0);
		expect(readFileSync(binary)).toEqual(damaged);
		const repaired = run();
		expect(repaired.status, repaired.stderr).toBe(0);
	});

	it("rejects a validly signed executable that fails its startup check", () => {
		const { run } = fixture(42);
		const result = run();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("failed (42)");
	});
});
