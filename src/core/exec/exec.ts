/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../../utils/child-process.js";
import { getShellEnv } from "../../utils/shell.js";
import { prefetchLoginShellPath } from "../../utils/login-shell-path.js";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/** Extra environment variables to merge into the login-shell environment. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	// Capture the login-shell PATH without blocking the event loop; the
	// sync getShellEnv() below then hits the cache.
	await prefetchLoginShellPath();
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// Inherit the login-shell PATH so user-installed tools (homebrew, nvm,
			// cargo, etc.) are found even when the agent was launched from a GUI
			// context with a minimal PATH (e.g. macOS launchd/Tauri). Without this,
			// `npm install -g agent-browser` fails with exit 1 because `npm` is not
			// on the inherited PATH.
			env: { ...getShellEnv(), ...options?.env },
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work. unref() so
				// the fallback timer doesn't keep a dying parent alive for 5s
				// after the child already exited.
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000).unref();
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		// Bound captured output: a runaway command (e.g. `yes`, a log follower)
		// would otherwise grow these strings until OOM. Truncating the kept
		// tail is safe — callers log/parse these, they don't need megabytes.
		const OUTPUT_CAP = 4 * 1024 * 1024;
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
			if (stdout.length > OUTPUT_CAP) stdout = stdout.slice(-OUTPUT_CAP);
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
			if (stderr.length > OUTPUT_CAP) stderr = stderr.slice(-OUTPUT_CAP);
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
