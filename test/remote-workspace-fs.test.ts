/**
 * Regression coverage for the filesystem RPC executed on an SSH host.
 *
 * These tests run against a real temporary Git repository so the desktop can
 * keep using the same file-tree and Git panel data shapes for local and remote
 * workspaces.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	gitBranches,
	gitDiff,
	gitLog,
	gitShow,
	gitStatus,
	listDir,
	readFileContent,
	searchFiles,
} from "../src/core/remote/workspace-fs.js";

const originalCwd = process.cwd();
let repoDir = "";

function git(...args: string[]): string {
	return execFileSync("git", args, {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

describe("remote workspace filesystem", () => {
	beforeAll(async () => {
		repoDir = await mkdtemp(join(tmpdir(), "pizza-remote-fs-"));
		await mkdir(join(repoDir, "src"), { recursive: true });
		await mkdir(join(repoDir, "node_modules", "ignored"), { recursive: true });
		await writeFile(join(repoDir, "README.md"), "# Remote Pizza\n", "utf8");
		await writeFile(join(repoDir, ".gitignore"), "node_modules/\n", "utf8");
		await writeFile(join(repoDir, "src", "app.ts"), "export const value = 1;\n", "utf8");
		await writeFile(join(repoDir, "node_modules", "ignored", "index.js"), "ignored\n", "utf8");
		git("init", "-q", "-b", "main");
		git("config", "user.name", "Pizza Test");
		git("config", "user.email", "pizza-test@example.com");
		git("add", ".gitignore", "README.md", "src/app.ts");
		git("commit", "-q", "-m", "initial commit");
		await writeFile(join(repoDir, "src", "app.ts"), "export const value = 2;\n", "utf8");
		await writeFile(join(repoDir, "notes.txt"), "untracked\n", "utf8");
		process.chdir(repoDir);
	});

	afterAll(async () => {
		process.chdir(originalCwd);
		await rm(repoDir, { recursive: true, force: true });
	});

	it("lists real workspace entries while hiding dependency directories", async () => {
		const entries = await listDir();
		expect(entries.map((entry) => entry.name)).toEqual([
			"src",
			".gitignore",
			"notes.txt",
			"README.md",
		]);
		expect(entries.some((entry) => entry.name === "node_modules")).toBe(false);
		const src = await listDir("src");
		expect(src).toEqual([
			expect.objectContaining({ name: "app.ts", path: "src/app.ts", is_dir: false }),
		]);
	});

	it("reads only files inside the workspace", async () => {
		await expect(readFileContent("src/app.ts")).resolves.toContain("value = 2");
		await expect(readFileContent("../outside.txt")).rejects.toThrow();
	});

	it("searches relative paths and skips ignored directories", async () => {
		const results = await searchFiles("app");
		expect(results).toEqual([
			expect.objectContaining({ name: "app.ts", path: "src/app.ts" }),
		]);
	});

	it("returns Git status with staged and unstaged counts", async () => {
		const status = await gitStatus();
		expect(status.is_repo).toBe(true);
		expect(status.branch).toBe("main");
		expect(status.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "src/app.ts", xy: " M" }),
				expect.objectContaining({ path: "notes.txt", xy: "??" }),
			]),
		);
		expect(status.unstaged).toBe(1);
		expect(status.untracked).toBe(1);
	});

	it("returns worktree, untracked, branch, log, and commit diff data", async () => {
		await expect(gitDiff("src/app.ts", "worktree")).resolves.toContain("-export const value = 1;");
		await expect(gitDiff("notes.txt", "untracked")).resolves.toContain("+untracked");

		const branches = await gitBranches();
		expect(branches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "main", is_current: true, is_remote: false }),
			]),
		);

		const commits = await gitLog(5);
		expect(commits).toHaveLength(1);
		expect(commits[0]).toEqual(expect.objectContaining({ subject: "initial commit" }));
		await expect(gitShow(commits[0]!.hash)).resolves.toContain("+# Remote Pizza");
	});

	it("associates NUL-separated rename stats with the new path", async () => {
		git("mv", "README.md", "GUIDE.md");
		const status = await gitStatus();
		expect(status.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					xy: "R ",
					path: "GUIDE.md",
					orig_path: "README.md",
					additions: 0,
					deletions: 0,
				}),
			]),
		);
	});
});
