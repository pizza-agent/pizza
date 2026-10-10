import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "PIZZA_LOGIN_SHELL_PATH";
const AT_KEY = "PIZZA_LOGIN_SHELL_PATH_AT";

describe.skipIf(process.platform === "win32")("login-shell-path", () => {
	let dir: string;
	let counter: string;
	const saved = { shell: process.env.SHELL, inherited: process.env[ENV_KEY], at: process.env[AT_KEY] };

	beforeEach(() => {
		vi.resetModules();
		dir = mkdtempSync(join(tmpdir(), "pizza-login-path-"));
		counter = join(dir, "runs");
		// Named `bash` so it passes the POSIX-shell filter; prints rc noise
		// before the sentinel like a real interactive shell would.
		const fakeShell = join(dir, "bash");
		writeFileSync(
			fakeShell,
			`#!/bin/sh\necho run >> "${counter}"\necho "motd banner"\nprintf '%s%s' '__PIZZA_LOGIN_PATH__' '/fake/login/bin'\n`,
		);
		chmodSync(fakeShell, 0o755);
		process.env.SHELL = fakeShell;
		delete process.env[ENV_KEY];
		delete process.env[AT_KEY];
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
		process.env.SHELL = saved.shell;
		for (const [key, value] of [[ENV_KEY, saved.inherited], [AT_KEY, saved.at]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	const runs = () => (existsSync(counter) ? readFileSync(counter, "utf-8").trim().split("\n").length : 0);

	it("adopts a fresh PATH inherited from a parent pizza process without running a shell", async () => {
		process.env[ENV_KEY] = "/inherited/bin";
		process.env[AT_KEY] = String(Date.now());
		const mod = await import("../src/utils/login-shell-path.js");
		expect(mod.resolveLoginShellPath()).toBe("/inherited/bin");
		expect(await mod.prefetchLoginShellPath()).toBe("/inherited/bin");
		expect(runs()).toBe(0);
	});

	it("serves a stale inherited PATH instantly and refreshes it in the background", async () => {
		process.env[ENV_KEY] = "/old/bin";
		process.env[AT_KEY] = String(Date.now() - 11 * 60_000);
		const mod = await import("../src/utils/login-shell-path.js");
		expect(mod.resolveLoginShellPath()).toBe("/old/bin");
		expect(await mod.prefetchLoginShellPath()).toBe("/old/bin");
		await vi.waitFor(() => expect(mod.resolveLoginShellPath()).toBe("/fake/login/bin"), { timeout: 5000 });
		expect(process.env[ENV_KEY]).toBe("/fake/login/bin");
		expect(runs()).toBe(1);
	});

	it("an inherited value without a timestamp counts as stale", async () => {
		process.env[ENV_KEY] = "/old/bin";
		const mod = await import("../src/utils/login-shell-path.js");
		expect(mod.resolveLoginShellPath()).toBe("/old/bin");
		await vi.waitFor(() => expect(mod.resolveLoginShellPath()).toBe("/fake/login/bin"), { timeout: 5000 });
	});

	it("refreshes its own capture after the TTL", async () => {
		const mod = await import("../src/utils/login-shell-path.js");
		expect(await mod.prefetchLoginShellPath()).toBe("/fake/login/bin");
		expect(runs()).toBe(1);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + mod.LOGIN_SHELL_PATH_TTL_MS + 1000);
		mod.resolveLoginShellPath();
		await vi.waitFor(() => expect(runs()).toBe(2), { timeout: 5000 });
	});

	it("a failed refresh keeps the previously captured PATH", async () => {
		process.env[ENV_KEY] = "/good/bin";
		process.env[AT_KEY] = "0";
		// Every shell candidate fails (non-zero exit).
		let spawned = 0;
		vi.doMock("node:child_process", async (orig) => {
			const { EventEmitter } = await import("node:events");
			const { PassThrough } = await import("node:stream");
			return {
				...(await orig<typeof import("node:child_process")>()),
				spawn: () => {
					spawned++;
					const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
					setImmediate(() => child.emit("close", 1, null));
					return child;
				},
			};
		});
		try {
			const mod = await import("../src/utils/login-shell-path.js");
			expect(mod.resolveLoginShellPath()).toBe("/good/bin");
			await vi.waitFor(() => expect(Number(process.env[AT_KEY])).toBeGreaterThan(0));
			expect(spawned).toBeGreaterThan(0);
			expect(mod.resolveLoginShellPath()).toBe("/good/bin");
			expect(process.env[ENV_KEY]).toBe("/good/bin");
		} finally {
			vi.doUnmock("node:child_process");
		}
	});

	it("treats an inherited empty value as a failed capture", async () => {
		process.env[ENV_KEY] = "";
		process.env[AT_KEY] = String(Date.now());
		const mod = await import("../src/utils/login-shell-path.js");
		expect(mod.resolveLoginShellPath()).toBeUndefined();
		expect(runs()).toBe(0);
	});

	it("captures asynchronously once, dedupes concurrent calls, and exports the result to children", async () => {
		const mod = await import("../src/utils/login-shell-path.js");
		const [a, b] = await Promise.all([mod.prefetchLoginShellPath(), mod.prefetchLoginShellPath()]);
		expect(a).toBe("/fake/login/bin");
		expect(b).toBe("/fake/login/bin");
		expect(mod.resolveLoginShellPath()).toBe("/fake/login/bin");
		expect(process.env[ENV_KEY]).toBe("/fake/login/bin");
		expect(runs()).toBe(1);
	});

	it("sync capture also exports the result", async () => {
		const mod = await import("../src/utils/login-shell-path.js");
		expect(mod.resolveLoginShellPath()).toBe("/fake/login/bin");
		expect(process.env[ENV_KEY]).toBe("/fake/login/bin");
		expect(runs()).toBe(1);
	});
});
