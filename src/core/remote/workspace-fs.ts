/**
 * Read-only workspace operations used by the desktop remote bridge.
 *
 * The desktop cannot use its Rust filesystem helpers for an SSH workspace
 * because those helpers only see the local machine. This module runs inside
 * the remote Pizza process and returns the same shapes the desktop file tree
 * and Git panel already consume.
 */

import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_LIMIT = 5_000;
const GIT_MAX_BUFFER = 20 * 1024 * 1024;

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"target",
	".next",
	".cache",
	".turbo",
	"dist",
	"build",
	".DS_Store",
]);

export interface RemoteDirEntry {
	name: string;
	path: string;
	is_dir: boolean;
	size: number;
}

export interface RemoteFileSearchEntry {
	name: string;
	path: string;
	is_dir: boolean;
}

export interface RemoteGitStatusEntry {
	xy: string;
	path: string;
	orig_path: string | null;
	additions: number | null;
	deletions: number | null;
}

export interface RemoteGitStatusSummary {
	is_repo: boolean;
	branch: string;
	head: string;
	head_subject: string;
	upstream: string;
	ahead: number;
	behind: number;
	entries: RemoteGitStatusEntry[];
	untracked: number;
	staged: number;
	unstaged: number;
}

export interface RemoteGitBranchEntry {
	name: string;
	is_current: boolean;
	is_remote: boolean;
	upstream: string | null;
}

export interface RemoteGitLogEntry {
	hash: string;
	short: string;
	author: string;
	date: string;
	subject: string;
	refs: string;
}

export type RemoteFsMethod =
	| "list_dir"
	| "read_file"
	| "search_files"
	| "git_status"
	| "git_diff"
	| "git_branches"
	| "git_log"
	| "git_show";

export interface RemoteFsRequest {
	id?: string;
	method: RemoteFsMethod;
	params?: Record<string, unknown>;
}

export type RemoteFsResponse =
	| { id?: string; ok: true; data: unknown }
	| { id?: string; ok: false; error: string };

function isInside(base: string, candidate: string): boolean {
	const rel = relative(base, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function resolveExistingWorkspacePath(subPath?: string): Promise<string> {
	const base = await realpath(process.cwd());
	if (!subPath?.trim()) {
		return base;
	}
	if (isAbsolute(subPath)) {
		throw new Error("Absolute paths are not allowed");
	}
	const candidate = await realpath(resolve(base, subPath));
	if (!isInside(base, candidate)) {
		throw new Error("Path escapes the workspace");
	}
	return candidate;
}

async function resolveWorkspaceRoot(): Promise<string> {
	return await realpath(process.cwd());
}

function workspaceRelativePath(base: string, absolutePath: string): string {
	return relative(base, absolutePath).split(sep).join("/");
}

export async function listDir(subPath?: string): Promise<RemoteDirEntry[]> {
	const base = await resolveWorkspaceRoot();
	const dir = await resolveExistingWorkspacePath(subPath);
	const dirStats = await stat(dir);
	if (!dirStats.isDirectory()) {
		throw new Error(`Not a directory: ${dir}`);
	}

	const entries = await readdir(dir, { withFileTypes: true });
	const result: RemoteDirEntry[] = [];
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) {
			continue;
		}
		const fullPath = resolve(dir, entry.name);
		const isDirectory = entry.isDirectory();
		const size = isDirectory ? 0 : (await stat(fullPath)).size;
		result.push({
			name: entry.name,
			path: workspaceRelativePath(base, fullPath),
			is_dir: isDirectory,
			size,
		});
	}
	result.sort(
		(a, b) =>
			Number(b.is_dir) - Number(a.is_dir) ||
			a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
	);
	return result;
}

export async function readFileContent(filePath: string): Promise<string> {
	const fullPath = await resolveExistingWorkspacePath(filePath);
	const fileStats = await stat(fullPath);
	if (fileStats.isDirectory()) {
		throw new Error(`Path is a directory: ${fullPath}`);
	}
	if (fileStats.size > MAX_READ_BYTES) {
		throw new Error(`File is too large (${fileStats.size} bytes, max ${MAX_READ_BYTES} bytes)`);
	}
	return await readFile(fullPath, "utf8");
}

export async function searchFiles(query?: string, limit?: number): Promise<RemoteFileSearchEntry[]> {
	const base = await resolveWorkspaceRoot();
	const normalizedQuery = query?.trim().toLowerCase();
	const cap = Math.max(1, Math.min(limit ?? 1_000, MAX_SEARCH_LIMIT));
	const result: RemoteFileSearchEntry[] = [];
	const queue: string[] = [base];

	while (queue.length > 0 && result.length < cap) {
		const dir = queue.shift()!;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (result.length >= cap) {
				break;
			}
			if (SKIP_DIRS.has(entry.name)) {
				continue;
			}
			const fullPath = resolve(dir, entry.name);
			if (entry.isDirectory()) {
				queue.push(fullPath);
				continue;
			}
			const rel = workspaceRelativePath(base, fullPath);
			if (normalizedQuery && !rel.toLowerCase().includes(normalizedQuery)) {
				continue;
			}
			result.push({ name: entry.name, path: rel, is_dir: false });
		}
	}

	result.sort((a, b) => {
		const depthDiff = a.path.split("/").length - b.path.split("/").length;
		return depthDiff || a.path.localeCompare(b.path);
	});
	return result;
}

interface GitExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runGitAllowFailure(cwd: string, args: string[]): Promise<GitExecResult> {
	try {
		const result = await execFile("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: GIT_MAX_BUFFER,
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failure = error as Error & {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			code?: number | string;
		};
		return {
			stdout: typeof failure.stdout === "string" ? failure.stdout : failure.stdout?.toString("utf8") ?? "",
			stderr: typeof failure.stderr === "string" ? failure.stderr : failure.stderr?.toString("utf8") ?? "",
			exitCode: typeof failure.code === "number" ? failure.code : 1,
		};
	}
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const result = await runGitAllowFailure(cwd, args);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
	const stats = new Map<string, { additions: number; deletions: number }>();
	const fields = raw.split("\0");
	let index = 0;
	while (index < fields.length) {
		const field = fields[index++] ?? "";
		if (!field) {
			continue;
		}
		const [addsRaw, delsRaw, pathRaw = ""] = field.split("\t", 3);
		const additions = Number.parseInt(addsRaw ?? "", 10);
		const deletions = Number.parseInt(delsRaw ?? "", 10);
		if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
			if (!pathRaw) {
				index += 2;
			}
			continue;
		}
		if (pathRaw) {
			stats.set(pathRaw, { additions, deletions });
		} else {
			const _oldPath = fields[index++];
			const newPath = fields[index++];
			if (newPath) {
				stats.set(newPath, { additions, deletions });
			}
		}
	}
	return stats;
}

function parsePorcelain(
	raw: string,
	stats: Map<string, { additions: number; deletions: number }>,
): RemoteGitStatusEntry[] {
	const entries: RemoteGitStatusEntry[] = [];
	const fields = raw.split("\0");
	let index = 0;
	while (index < fields.length) {
		const record = fields[index++] ?? "";
		if (record.length < 4) {
			continue;
		}
		const xy = record.slice(0, 2);
		const path = record.slice(3);
		const origPath = xy.startsWith("R") || xy.startsWith("C") ? (fields[index++] ?? null) : null;
		const lineStats = stats.get(path);
		entries.push({
			xy,
			path,
			orig_path: origPath,
			additions: lineStats?.additions ?? null,
			deletions: lineStats?.deletions ?? null,
		});
	}
	return entries;
}

function emptyGitStatus(): RemoteGitStatusSummary {
	return {
		is_repo: false,
		branch: "",
		head: "",
		head_subject: "",
		upstream: "",
		ahead: 0,
		behind: 0,
		entries: [],
		untracked: 0,
		staged: 0,
		unstaged: 0,
	};
}

export async function gitStatus(): Promise<RemoteGitStatusSummary> {
	const cwd = await resolveWorkspaceRoot();
	const inside = await runGitAllowFailure(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
		return emptyGitStatus();
	}

	const branch = await runGitAllowFailure(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const headLine = await runGitAllowFailure(cwd, ["log", "-1", "--format=%h%x09%s"]);
	const [head = "", headSubject = ""] = headLine.stdout.trim().split("\t", 2);
	const upstreamResult = await runGitAllowFailure(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
	const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : "";

	let ahead = 0;
	let behind = 0;
	if (upstream) {
		const counts = await runGitAllowFailure(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
		const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/, 2);
		ahead = Number.parseInt(aheadRaw ?? "0", 10) || 0;
		behind = Number.parseInt(behindRaw ?? "0", 10) || 0;
	}

	const statsResult = await runGitAllowFailure(cwd, ["diff", "--numstat", "-z", "HEAD"]);
	const stats = parseNumstat(statsResult.stdout);
	const statusResult = await runGit(cwd, ["status", "--porcelain=v1", "-z"]);
	const entries = parsePorcelain(statusResult, stats);

	let untracked = 0;
	let staged = 0;
	let unstaged = 0;
	for (const entry of entries) {
		if (entry.xy === "??") {
			untracked += 1;
			continue;
		}
		if (entry.xy[0] !== " " && entry.xy[0] !== "?") {
			staged += 1;
		}
		if (entry.xy[1] !== " " && entry.xy[1] !== "?") {
			unstaged += 1;
		}
	}

	return {
		is_repo: true,
		branch: branch.exitCode === 0 ? branch.stdout.trim() : "",
		head,
		head_subject: headSubject,
		upstream,
		ahead,
		behind,
		entries,
		untracked,
		staged,
		unstaged,
	};
}

export async function gitDiff(path: string, mode: string): Promise<string> {
	const cwd = await resolveWorkspaceRoot();
	if (mode === "untracked") {
		if (!path) {
			return "";
		}
		const result = await runGitAllowFailure(cwd, ["diff", "--no-index", "--", "/dev/null", path]);
		if (result.stdout) {
			return result.stdout;
		}
		if (result.stderr.trim()) {
			throw new Error(result.stderr.trim());
		}
		return "";
	}
	const args = mode === "staged" ? ["diff", "--cached", "--"] : ["diff", "--"];
	if (path) {
		args.push(path);
	}
	return await runGit(cwd, args);
}

export async function gitBranches(): Promise<RemoteGitBranchEntry[]> {
	const cwd = await resolveWorkspaceRoot();
	const inside = await runGitAllowFailure(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
		return [];
	}
	const raw = await runGit(cwd, [
		"for-each-ref",
		"--format=%(HEAD)%09%(refname)%09%(upstream:short)",
		"refs/heads",
		"refs/remotes",
	]);
	const branches: RemoteGitBranchEntry[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line) {
			continue;
		}
		const [headMarker = "", refname = "", upstreamRaw = ""] = line.split("\t", 3);
		let isRemote: boolean;
		let name: string;
		if (refname.startsWith("refs/remotes/")) {
			name = refname.slice("refs/remotes/".length);
			if (name.endsWith("/HEAD")) {
				continue;
			}
			isRemote = true;
		} else if (refname.startsWith("refs/heads/")) {
			name = refname.slice("refs/heads/".length);
			isRemote = false;
		} else {
			continue;
		}
		branches.push({
			name,
			is_current: headMarker === "*",
			is_remote: isRemote,
			upstream: upstreamRaw || null,
		});
	}
	return branches;
}

export async function gitLog(limit?: number): Promise<RemoteGitLogEntry[]> {
	const cwd = await resolveWorkspaceRoot();
	const inside = await runGitAllowFailure(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
		return [];
	}
	const count = Math.max(1, Math.min(limit ?? 100, 200));
	const raw = await runGit(cwd, [
		"log",
		"-z",
		"-n",
		String(count),
		"--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%d",
	]);
	return raw
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const [hash = "", short = "", author = "", date = "", subject = "", refsRaw = ""] =
				record.split("\x1f", 6);
			const refs = refsRaw.trim().replace(/^\(/, "").replace(/\)$/, "");
			return { hash, short, author, date, subject, refs };
		});
}

export async function gitShow(hash: string): Promise<string> {
	if (!hash || hash.startsWith("-") || !/^[A-Za-z0-9/._-]+$/.test(hash)) {
		throw new Error("invalid commit ref");
	}
	const cwd = await resolveWorkspaceRoot();
	return await runGit(cwd, [
		"diff-tree",
		"-p",
		"--no-color",
		"--root",
		"--no-commit-id",
		hash,
	]);
}

export async function handleRemoteFsRequest(request: RemoteFsRequest): Promise<unknown> {
	const params = request.params ?? {};
	switch (request.method) {
		case "list_dir":
			return await listDir(typeof params.subPath === "string" ? params.subPath : undefined);
		case "read_file": {
			const filePath = typeof params.filePath === "string" ? params.filePath : "";
			if (!filePath) {
				throw new Error("filePath is required");
			}
			return await readFileContent(filePath);
		}
		case "search_files":
			return await searchFiles(
				typeof params.query === "string" ? params.query : undefined,
				typeof params.limit === "number" ? params.limit : undefined,
			);
		case "git_status":
			return await gitStatus();
		case "git_diff": {
			const path = typeof params.path === "string" ? params.path : "";
			const mode = typeof params.mode === "string" ? params.mode : "worktree";
			return await gitDiff(path, mode);
		}
		case "git_branches":
			return await gitBranches();
		case "git_log":
			return await gitLog(typeof params.limit === "number" ? params.limit : undefined);
		case "git_show": {
			const hash = typeof params.hash === "string" ? params.hash : "";
			return await gitShow(hash);
		}
		default:
			throw new Error(`Unknown remote filesystem method: ${String(request.method)}`);
	}
}
