/**
 * Persistent ("main") agent support.
 *
 * The main agent is a single, long-lived coding companion that lives in its own
 * working directory (default `~/.pizza/main`). Unlike per-project workspaces it
 * has an identity ("soul") file and a long-term memory library that are injected
 * into the system prompt on every session boundary.
 *
 * This module owns:
 *  - first-run initialization of the main dir (SOUL.md + memory scaffold)
 *  - loading the soul file and the long-term memory index
 *  - `_index.md` consistency checks against the memory directory
 *  - main-agent-specific prompt guidelines
 *  - a best-effort single-instance lockfile
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { APP_NAME, getMainMemoryDir, getMainSoulPath } from "../../config.js";

export interface SoulFile {
	path: string;
	content: string;
}

export interface MemoryEntry {
	path: string;
	content: string;
}

/**
 * The marker placed in the default SOUL.md placeholder to signal that the user
 * has not yet defined the agent's identity. The agent sees this in its own
 * Identity section and uses it as a cue to invite the user to define who it is.
 */
export const SOUL_PLACEHOLDER_MARKER = "[NOT YET DEFINED]";

/**
 * Build the default SOUL.md placeholder. Unlike a pre-filled identity, this is
 * an empty template with `[NOT YET DEFINED]` markers — the user (or the agent,
 * on the user's behalf during conversation) fills it in to define the agent's
 * identity, values, and voice.
 */
function buildDefaultSoulTemplate(_appName: string): string {
	return `---
description: Soul not yet defined — talk to your agent to define its identity.
tags: [identity, soul, persistent-agent, memory]
---
# Identity

${SOUL_PLACEHOLDER_MARKER}

This soul file is a placeholder. The user has not yet defined who you are.
When the user describes what they want (a name, a role, a tone, values they
want you to hold, a language they want you to speak), write their choices into
this file using the write or edit command. The user can also edit this file
directly.

# Language

${SOUL_PLACEHOLDER_MARKER}

The language(s) you should use when talking to the user. Can be a single
language (e.g. "中文", "English") or a preference (e.g. "match the user's
language", "English for code, 中文 for chat").

# Values

${SOUL_PLACEHOLDER_MARKER}

# Voice

${SOUL_PLACEHOLDER_MARKER}
`;
}

/**
 * Detect whether a soul file's content is still the untouched placeholder.
 * Used to decide whether the agent should proactively invite the user to define
 * its identity during conversation.
 *
 * Checks for the presence of the {@link SOUL_PLACEHOLDER_MARKER} rather than
 * exact string matching, so minor whitespace edits by the user don't cause a
 * false "initialized" reading — as long as any section is still marked
 * `[NOT YET DEFINED]`, the soul is considered uninitialized.
 */
export function isSoulUninitialized(content: string, _appName: string): boolean {
	return content.includes(SOUL_PLACEHOLDER_MARKER);
}

const DEFAULT_INDEX_TEMPLATE = `# Memory Index

This file indexes the long-term memory library. Each entry links a memory file
to a short summary so the agent knows what exists without loading everything.

- user-profile.md — stable facts about the user (preferences, environment, style)
`;

const DEFAULT_USER_PROFILE_TEMPLATE = `# User Profile

Long-term, stable facts about the user. Update this as you learn more.

(empty)
`;

/**
 * Ensure the main agent working directory exists and is scaffolded.
 * Returns true when a fresh initialization was performed.
 */
export function initializeMainAgent(mainDir: string, memoryDir?: string): boolean {
	const soulPath = getMainSoulPath(mainDir);
	const resolvedMemoryDir = memoryDir ?? getMainMemoryDir(mainDir);
	const alreadyInitialized = existsSync(soulPath);

	mkdirSync(mainDir, { recursive: true });
	mkdirSync(resolvedMemoryDir, { recursive: true });
	mkdirSync(join(resolvedMemoryDir, "journal"), { recursive: true });

	if (!existsSync(soulPath)) {
		writeFileSync(soulPath, buildDefaultSoulTemplate(APP_NAME), "utf-8");
	}

	const indexPath = join(resolvedMemoryDir, "_index.md");
	if (!existsSync(indexPath)) {
		writeFileSync(indexPath, DEFAULT_INDEX_TEMPLATE, "utf-8");
	}

	const userProfilePath = join(resolvedMemoryDir, "user-profile.md");
	if (!existsSync(userProfilePath)) {
		writeFileSync(userProfilePath, DEFAULT_USER_PROFILE_TEMPLATE, "utf-8");
	}

	return !alreadyInitialized;
}

/** Load the soul file if it exists. */
export function loadSoulFile(mainDir: string): SoulFile | undefined {
	const soulPath = getMainSoulPath(mainDir);
	if (!existsSync(soulPath)) {
		return undefined;
	}
	try {
		return { path: soulPath, content: readFileSync(soulPath, "utf-8") };
	} catch {
		return undefined;
	}
}

/**
 * Load the long-term memory *index* only (`_index.md`).
 *
 * The full memory files are NOT loaded into the prompt — the agent reads them on
 * demand via the file tools. Before returning, the index is reconciled with the
 * actual contents of the memory directory:
 *  - files present on disk but missing from the index get an "(unindexed)" note
 *  - index entries pointing at missing files get a "(stale)" note
 */
export function loadLongTermMemory(memoryDir: string): MemoryEntry[] {
	if (!existsSync(memoryDir)) {
		return [];
	}

	const indexPath = join(memoryDir, "_index.md");
	let indexContent = "";
	let indexExists = false;
	if (existsSync(indexPath)) {
		try {
			indexContent = readFileSync(indexPath, "utf-8");
			indexExists = true;
		} catch {
			indexContent = "";
		}
	}

	const memoryFiles = listMemoryFiles(memoryDir);
	const reconciled = reconcileIndex(indexContent, memoryFiles);

	// If the index file is absent AND there are no unindexed files to report,
	// there is nothing meaningful to inject — avoid advertising a path that
	// does not exist on disk.
	if (!indexExists && reconciled.length === 0) {
		return [];
	}

	// Use a synthetic label when the index file is missing so the model does
	// not believe a real file exists at that path.
	const path = indexExists ? indexPath : `<memory index (not yet created at ${indexPath})>`;
	return [{ path, content: reconciled }];
}

function listMemoryFiles(memoryDir: string): string[] {
	try {
		return readdirSync(memoryDir)
			.filter((name) => {
				if (name === "_index.md") return false;
				if (!name.endsWith(".md")) return false;
				try {
					return statSync(join(memoryDir, name)).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}

/**
 * Append consistency notes to the raw index content so the agent always sees an
 * accurate picture of the memory directory even if `_index.md` drifted.
 *
 * Only filenames that appear as the first token of a list item (`- foo.md ...`)
 * are treated as indexed entries, so prose mentions of `README.md` inside a
 * description do not produce false "stale" reports.
 */
function reconcileIndex(indexContent: string, memoryFiles: string[]): string {
	const listedFiles = new Set<string>();
	// Match the first filename-like token of each bullet list item. Anchoring
	// to the start of a line + bullet avoids matching `.md` mentions in prose.
	for (const match of indexContent.matchAll(/^\s*[-*]\s+([A-Za-z0-9._-]+\.md)\b/gm)) {
		listedFiles.add(basename(match[1]));
	}

	const unindexed = memoryFiles.filter((file) => !listedFiles.has(file));
	const stale = [...listedFiles].filter(
		(file) => file !== "_index.md" && !memoryFiles.includes(file),
	);

	let result = indexContent.trimEnd();
	if (unindexed.length > 0 || stale.length > 0) {
		result += "\n\n<!-- consistency check (auto-generated) -->";
		for (const file of unindexed) {
			result += `\n- ${file} (unindexed)`;
		}
		for (const file of stale) {
			result += `\n- ${file} (stale — listed but not found on disk)`;
		}
	}

	return result.length > 0 ? `${result}\n` : "";
}

/** Options for {@link getMainAgentGuidelines}. */
export interface MainAgentGuidelinesOptions {
	/** Path to the soul file, so the agent can edit it. */
	soulPath?: string;
	/** True when the soul file is still the untouched default template. */
	soulUninitialized?: boolean;
}

/**
 * Guidelines appended to the system prompt when running as the main agent.
 *
 * When `soulUninitialized` is true, an extra guideline is prepended instructing
 * the agent to proactively invite the user to define its identity — either by
 * editing the soul file directly or by describing what they want in
 * conversation, in which case the agent updates the file itself.
 */
export function getMainAgentGuidelines(
	memoryDir: string,
	options?: MainAgentGuidelinesOptions,
): string[] {
	const guidelines: string[] = [];

	if (options?.soulUninitialized && options?.soulPath) {
		guidelines.push(
			`IMPORTANT: Your soul file (${options.soulPath}) is a placeholder — your identity, values, and voice are all marked [NOT YET DEFINED]. You MUST proactively invite the user to define who you are. In your FIRST response to the user, before addressing their question, ask them to describe what kind of agent they want: a name, a role, a tone, values they want you to hold. Tell them they can either describe it in conversation (and you will write it to the soul file) or edit the file directly. This is required — do not skip it. After the user has defined your soul, never repeat this invitation.`,
		);
	}

	if (options?.soulPath) {
		guidelines.push(
			`When the user asks you to remember a preference, update your personality, or change your voice/values, edit your soul file at ${options.soulPath} with the write or edit command. Treat the soul as your self-definition: keep it concise and meaningful. When the user describes what they want, write it into the soul file immediately — do not just acknowledge, actually update the file.`,
		);
	}

	guidelines.push(
		"You are a persistent agent: your identity lives in the Identity section and your long-term memory index is in the Long-Term Memory section of this prompt.",
		"Before starting a new topic, review the relevant long-term memory; the index is in the prompt, read the specific memory file with the read command when you need details.",
		`When you learn a stable fact about the user, write it to the appropriate file under ${memoryDir} (create a new file for a new topic and add it to _index.md).`,
		`When you notice outdated or inaccurate information in memory, update or delete the corresponding file under ${memoryDir} and keep _index.md in sync.`,
		`At a meaningful milestone or natural session boundary, you may append a short factual entry to ${join(memoryDir, "journal")}/YYYY-MM-DD.md using the user's local calendar date. Read existing entries first; avoid duplicates, raw logs, secrets, invented feelings, or filler just because a day passed. Keep journals separate from the topic index; promote only durable findings into topic memories.`,
		"Memory you write during a session is loaded into the system prompt at the next session boundary (after _session_split), not immediately.",
		"You can delegate a task to a sub-agent in another project directory (workspace) with the built-in `_tell` cli command. Run `_tell list` first to see which workspaces are available — each shows a name (the last path component, e.g. \"web\"), its cwd, and metadata. Then `_tell send --to <name> --message \"...\"` (or a project path) to hand off the task. The target agent runs in its own workspace (kept alive by the gateway) and only its reply enters this conversation — keep other projects' context out of this conversation by delegating instead of handling them inline.",
	);

	return guidelines;
}

// ── Single-instance lockfile ───────────────────────────────────────────────

export interface MainAgentLock {
	release(): void;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH = no such process; EPERM = exists but not ours (treat as alive)
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Core single-writer lockfile: write our pid to `lockPath` (exclusive create),
 * reclaiming it if the recorded owner is no longer alive. The returned handle
 * releases on call, on `exit`, and on SIGINT/SIGTERM/SIGHUP — so a process
 * killed by a signal (e.g. the Bun --compile sidecar) still frees the lock.
 *
 * Returns null if another LIVE process holds it. Best-effort: a permission
 * error or an unreadable lock gives up (null) rather than throwing.
 *
 * Shared by {@link acquireMainLock} (one main agent) and
 * {@link acquireWorkspaceLock} (one active driver per workspace).
 */
export function acquirePidLock(lockPath: string): MainAgentLock | null {
	// Fast path: atomically create the lock file. If it does not exist yet,
	// `wx` succeeds and we own the lock.
	try {
		writeFileSync(lockPath, String(process.pid), { encoding: "utf-8", flag: "wx" });
	} catch (error) {
		// EEXIST → a lock file is present; fall through to the reclaim path.
		// Anything else (e.g. permission error) → give up.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			return null;
		}
	}

	// Reclaim path: a lock file already exists. Check whether its owner is
	// still alive; if not, overwrite it and take ownership.
	if (existsSync(lockPath)) {
		let ownerPid = NaN;
		try {
			ownerPid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
		} catch {
			ownerPid = NaN;
		}
		if (!Number.isNaN(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
			return null;
		}
		// Owner is dead or it's our own pid (re-entrant call) — reclaim.
		try {
			writeFileSync(lockPath, String(process.pid), "utf-8");
		} catch {
			return null;
		}
	}

	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		try {
			const current = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
			if (current === process.pid) {
				rmSync(lockPath, { force: true });
			}
		} catch {
			// ignore
		}
	};

	const onExit = (): void => release();
	process.once("exit", onExit);

	// Belt-and-suspenders: in some runtimes (notably the Bun --compile binary
	// used as the desktop sidecar) `process.on("exit")` can be skipped or
	// fired late if the process is killed by a signal. Hook SIGINT/SIGTERM/
	// SIGHUP explicitly so the lock is released promptly and a fresh process
	// can take over without hitting a stale-lock path. The `release()`
	// guard makes the redundant exit-path call a no-op.
	const onSignal = (): void => release();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	process.once("SIGHUP", onSignal);

	return { release };
}

/**
 * Acquire a best-effort single-instance lock for the main agent.
 * Returns a lock handle on success, or null if another live instance holds it.
 * A stale lock (owning process no longer alive) is reclaimed automatically.
 *
 * The create path uses `flag: "wx"` (exclusive create) to avoid the TOCTOU
 * race between `existsSync` and `writeFileSync`.
 */
export function acquireMainLock(mainDir: string): MainAgentLock | null {
	mkdirSync(mainDir, { recursive: true });
	return acquirePidLock(join(mainDir, ".lock"));
}

/**
 * Acquire a single-writer lock for a workspace — ensures only one Pizza
 * process actively drives a given workspace's session at a time. Without this,
 * a direct-mode sidecar and a gateway-pooled agent (or two CLI runs) on the
 * same workspace would both write turns concurrently and interleave events.
 *
 * `workspaceDir` is the per-workspace directory (e.g.
 * `~/.pizza/agent/workspaces/<id>/`); the caller is responsible for creating
 * it. The lock lives at `<workspaceDir>/.lock`, auto-released on exit/signal,
 * and stale locks are reclaimed via pid liveness — same machinery as the main
 * agent lock. Returns null if another live process holds it.
 */
export function acquireWorkspaceLock(workspaceDir: string): MainAgentLock | null {
	return acquirePidLock(join(workspaceDir, ".lock"));
}
