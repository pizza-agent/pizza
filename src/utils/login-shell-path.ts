import { existsSync } from "node:fs";
import { basename, delimiter } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Capture the PATH the user's login shell would set, so processes that inherit
 * a minimal PATH (e.g. GUI/launchd-launched agents that never source
 * ~/.zprofile / ~/.bash_profile / ~/.zshrc) still find tools the user installed
 * via homebrew / cargo / nvm / etc.
 *
 * Direct port of the Rust desktop's `capture_login_shell_path()` /
 * `resolve_shell_path()` in apps/desktop/src/bridge.rs.
 *
 * Runs `<shell> -lic '<sentinel>$PATH'` with stdin wired to /dev/null and a
 * hard timeout, so a misbehaving rc file can't hang the process. The result is
 * captured once and cached for the lifetime of the process.
 */

const CAPTURE_TIMEOUT_MS = 3000;

/**
 * Marker printed immediately before the PATH. Interactive rc files routinely
 * echo banners, version-manager notices, motd, etc. to stdout; without a
 * sentinel that noise would be spliced into the PATH we hand to every child
 * process. Everything before the last marker is discarded.
 */
const SENTINEL = "__PIZZA_LOGIN_PATH__";

/** Shells whose `"$PATH"` expands to a single delimiter-separated string. */
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash", "mksh"]);

/**
 * Env var carrying an already-captured login-shell PATH to child processes
 * ("" = capture was attempted and failed). Starting an interactive login
 * shell costs ~1s+ on a typical oh-my-zsh/nvm setup, and the sync capture
 * blocks the whole event loop — so the gateway captures once and every
 * agent it spawns inherits the result instead of re-running the shell.
 */
const INHERITED_ENV_KEY = "PIZZA_LOGIN_SHELL_PATH";
/** Epoch ms of the capture carried in {@link INHERITED_ENV_KEY}. */
const INHERITED_AT_ENV_KEY = "PIZZA_LOGIN_SHELL_PATH_AT";

/**
 * After this long a captured PATH is refreshed in the background
 * (stale-while-revalidate): callers keep getting the old value instantly, and
 * the next caller after the refresh lands sees the new one. Lets edits to the
 * user's rc files reach long-lived gateways/agents without a restart.
 */
export const LOGIN_SHELL_PATH_TTL_MS = 10 * 60_000;

/** null = never captured; path undefined = capture failed. */
let cached: { path: string | undefined; at: number } | null = null;
let pending: Promise<string | undefined> | null = null;

const captureArgs = ["-lic", `printf '%s%s' '${SENTINEL}' "$PATH"`];

function parseCaptureOutput(stdout: string): string | undefined {
	const marker = stdout.lastIndexOf(SENTINEL);
	// No marker means the shell never ran our command (or mangled it) — the
	// output is not a PATH, so refuse it rather than poisoning every child.
	if (marker < 0) return undefined;
	const path = stdout.slice(marker + SENTINEL.length).trim();
	return path.length > 0 ? path : undefined;
}

function runShellCapturePath(shell: string): string | undefined {
	const result = spawnSync(shell, captureArgs, {
		timeout: CAPTURE_TIMEOUT_MS,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Timed out / killed / non-zero exit -> no usable PATH.
	if (result.signal || result.status !== 0) return undefined;
	return parseCaptureOutput(result.stdout ?? "");
}

function runShellCapturePathAsync(shell: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		let stdout = "";
		const child = spawn(shell, captureArgs, { stdio: ["ignore", "pipe", "ignore"] });
		const timer = setTimeout(() => child.kill("SIGKILL"), CAPTURE_TIMEOUT_MS);
		child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (stdout += chunk));
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve(signal || code !== 0 ? undefined : parseCaptureOutput(stdout));
		});
	});
}

function shellCandidates(): string[] {
	// POSIX shells only: on Windows there is no login shell to source and
	// `-lic` is meaningless.
	if (platform() === "win32") return [];

	// Prefer the user's configured login shell, then common fallbacks.
	const configured = process.env.SHELL;
	const candidates: string[] = [];
	if (configured) candidates.push(configured);
	for (const fallback of ["/bin/zsh", "/bin/bash"]) {
		if (!candidates.includes(fallback)) candidates.push(fallback);
	}

	return candidates.filter((shell) => {
		// Only Bourne-family shells: `"$PATH"` in fish/csh is a list that
		// expands space-separated, so the "PATH" we'd read back is garbage.
		if (!POSIX_SHELLS.has(basename(shell))) return false;
		try {
			return existsSync(shell);
		} catch {
			return false;
		}
	});
}

/** Cache the result and export it so spawned children skip the capture. */
function store(path: string | undefined): string | undefined {
	// A failed refresh must not discard a previously good PATH.
	const value = path ?? cached?.path;
	cached = { path: value, at: Date.now() };
	process.env[INHERITED_ENV_KEY] = value ?? "";
	process.env[INHERITED_AT_ENV_KEY] = String(cached.at);
	return value;
}

/** Load the cache, adopting a PATH captured by an ancestor pizza process. Returns false if there is none. */
function loadCache(): boolean {
	if (cached) return true;
	const inherited = process.env[INHERITED_ENV_KEY];
	if (inherited === undefined) return false;
	// Missing/garbled timestamp → treat as stale so it gets refreshed.
	cached = { path: inherited || undefined, at: Number(process.env[INHERITED_AT_ENV_KEY]) || 0 };
	return true;
}

function captureAsync(): Promise<string | undefined> {
	pending ??= (async () => {
		let path: string | undefined;
		for (const shell of shellCandidates()) {
			path = await runShellCapturePathAsync(shell);
			if (path) break;
		}
		return store(path);
	})().finally(() => {
		pending = null;
	});
	return pending;
}

/** Kick off a background refresh when the cached PATH has expired. */
function revalidateIfStale(): void {
	if (cached && Date.now() - cached.at > LOGIN_SHELL_PATH_TTL_MS) void captureAsync();
}

/**
 * Join PATH-ish values in priority order, dropping empties and duplicates.
 * Earlier entries win, so callers list the environment they trust most first.
 */
export function mergePathValues(...values: Array<string | undefined>): string {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const value of values) {
		for (const dir of (value ?? "").split(delimiter)) {
			if (dir && !seen.has(dir)) {
				seen.add(dir);
				merged.push(dir);
			}
		}
	}
	return merged.join(delimiter);
}

/**
 * Resolve the login-shell PATH (cached, refreshed in the background after
 * {@link LOGIN_SHELL_PATH_TTL_MS}). Only the very first capture in a process
 * tree blocks. Returns undefined if no shell produced a PATH (caller should
 * then keep the inherited PATH).
 */
export function resolveLoginShellPath(): string | undefined {
	if (!loadCache()) {
		let path: string | undefined;
		for (const shell of shellCandidates()) {
			path = runShellCapturePath(shell);
			if (path) break;
		}
		return store(path);
	}
	revalidateIfStale();
	return cached?.path;
}

/**
 * Non-blocking variant of {@link resolveLoginShellPath}: runs the capture
 * without stalling the event loop and fills the same cache. Async callers
 * should prefer this; later sync calls then hit the cache.
 */
export function prefetchLoginShellPath(): Promise<string | undefined> {
	if (!loadCache()) return captureAsync();
	revalidateIfStale();
	return Promise.resolve(cached?.path);
}
