/**
 * Crash handler tests.
 *
 * These run in child processes on purpose: the handlers call `process.exit`, and
 * `unhandledRejection` / `uncaughtException` semantics cannot be observed
 * faithfully from inside a test runner that installs its own handlers.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

describe("installCrashHandlers", () => {
	const testDir = join(tmpdir(), `pizza-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const modulePath = pathToFileURL(join(process.cwd(), "src/core/crash-handlers.ts")).href;

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	/**
	 * Run a snippet with the crash handlers installed via tsx/vitest's loader.
	 * Returns exit code plus captured output.
	 */
	function runScript(source: string): { status: number; stdout: string; stderr: string } {
		mkdirSync(testDir, { recursive: true });
		const scriptPath = join(testDir, `case-${Math.random().toString(36).slice(2)}.ts`);
		writeFileSync(scriptPath, source);
		// spawnSync (not execFileSync) so stdout AND stderr are captured on the
		// success path too — execFileSync only returns stdout when the exit code is 0.
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", scriptPath],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 },
		);
		return {
			status: result.status ?? -1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	}

	it("keeps the process alive after an unhandled rejection", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			installCrashHandlers({ label: "testd" });
			void Promise.reject(new Error("stray rejection"));
			// If the handler did not suppress the default behaviour, Node would
			// terminate before this timer fires.
			setTimeout(() => {
				process.stdout.write("SURVIVED");
				process.exit(0);
			}, 300);
		`);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("SURVIVED");
		expect(result.stderr).toContain("[testd] Unhandled promise rejection");
		expect(result.stderr).toContain("stray rejection");
	});

	it("logs rejection diagnostics to stderr, never stdout", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			installCrashHandlers({ label: "rpc" });
			void Promise.reject(new Error("protocol channel must stay clean"));
			setTimeout(() => process.exit(0), 300);
		`);

		// stdout is the JSONL protocol channel in rpc mode — it must carry nothing.
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("protocol channel must stay clean");
	});

	it("runs onFatal then exits on an uncaught exception", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			installCrashHandlers({
				label: "gateway",
				onFatal: () => { process.stderr.write("CLEANUP_RAN\\n"); },
			});
			setTimeout(() => { throw new Error("boom"); }, 50);
			// Keep the loop busy so the process would otherwise linger.
			setInterval(() => {}, 1000);
		`);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("[gateway] Uncaught exception");
		expect(result.stderr).toContain("boom");
		expect(result.stderr).toContain("CLEANUP_RAN");
	});

	it("awaits an async onFatal before exiting", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			installCrashHandlers({
				label: "gateway",
				onFatal: async () => {
					await new Promise((r) => setTimeout(r, 100));
					process.stderr.write("ASYNC_CLEANUP_DONE\\n");
				},
			});
			setTimeout(() => { throw new Error("boom"); }, 50);
			setInterval(() => {}, 1000);
		`);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("ASYNC_CLEANUP_DONE");
	});

	it("still exits when onFatal itself throws", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			installCrashHandlers({
				label: "gateway",
				onFatal: () => { throw new Error("cleanup exploded"); },
			});
			setTimeout(() => { throw new Error("boom"); }, 50);
			setInterval(() => {}, 1000);
		`);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Cleanup failed");
		expect(result.stderr).toContain("cleanup exploded");
	});

	it("force-exits when onFatal hangs past the grace period", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			installCrashHandlers({
				label: "gateway",
				fatalTimeoutMs: 200,
				onFatal: () => new Promise(() => {}), // never settles
			});
			setTimeout(() => { throw new Error("boom"); }, 50);
			setInterval(() => {}, 1000);
		`);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Uncaught exception");
	});

	it("honours a custom exit code", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			installCrashHandlers({ label: "gateway", fatalExitCode: 42 });
			setTimeout(() => { throw new Error("boom"); }, 50);
			setInterval(() => {}, 1000);
		`);

		expect(result.status).toBe(42);
	});

	it("reports non-Error throws readably", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			installCrashHandlers({ label: "gateway" });
			setTimeout(() => { throw { code: "WEIRD", detail: "not an Error" }; }, 50);
			setInterval(() => {}, 1000);
		`);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Non-error thrown");
		expect(result.stderr).toContain("WEIRD");
	});

	it("can be uninstalled by its disposer", () => {
		const result = runScript(`
			import { installCrashHandlers } from ${JSON.stringify(modulePath)};
			const dispose = installCrashHandlers({ label: "gateway" });
			dispose();
			// With handlers removed, Node's default behaviour applies: an unhandled
			// rejection terminates the process with a non-zero code.
			void Promise.reject(new Error("should be fatal again"));
			setTimeout(() => { process.stdout.write("SURVIVED"); }, 300);
		`);

		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain("SURVIVED");
	});
});