/**
 * Workspace single-writer lease — the pid-lockfile machinery shared by the
 * main-agent and workspace locks. Verifies: first acquisition succeeds, a
 * concurrent acquisition by the same lockPath fails (null), a stale lock
 * (dead owner pid) is reclaimed, and release frees it for the next acquirer.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidLock, acquireWorkspaceLock } from "../src/core/main-agent.js";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "pizza-wslock-"));
}

describe("workspace single-writer lock", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("first acquisition succeeds and blocks a second on the same path", () => {
		const dir = tmpDir();
		dirs.push(dir);
		const lockPath = join(dir, ".lock");

		const first = acquirePidLock(lockPath);
		expect(first).not.toBeNull();
		// A second acquirer on the same path while the first owner (this process)
		// is alive is rejected. (acquirePidLock treats our own pid as re-entrant,
		// so simulate a different live owner by writing another pid.)
		writeFileSync(lockPath, String(process.ppid));
		const second = acquirePidLock(lockPath);
		expect(second).toBeNull();

		first!.release();
	});

	it("release lets the next acquirer take over", () => {
		const dir = tmpDir();
		dirs.push(dir);
		const lockPath = join(dir, ".lock");

		const first = acquirePidLock(lockPath);
		expect(first).not.toBeNull();
		first!.release();

		const second = acquirePidLock(lockPath);
		expect(second).not.toBeNull();
		second!.release();
	});

	it("a stale lock (dead owner) is reclaimed", () => {
		const dir = tmpDir();
		dirs.push(dir);
		const lockPath = join(dir, ".lock");
		// Write a lock owned by a pid that definitely does not exist.
		writeFileSync(lockPath, "999999");
		const reclaimed = acquirePidLock(lockPath);
		expect(reclaimed).not.toBeNull();
		// The lock file now records our pid.
		expect(readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));
		reclaimed!.release();
	});

	it("acquireWorkspaceLock locks the workspace dir", () => {
		const dir = tmpDir();
		dirs.push(dir);
		const lock = acquireWorkspaceLock(dir);
		expect(lock).not.toBeNull();
		// Same path, foreign live owner → blocked.
		writeFileSync(join(dir, ".lock"), String(process.ppid));
		expect(acquireWorkspaceLock(dir)).toBeNull();
		lock!.release();
	});
});
