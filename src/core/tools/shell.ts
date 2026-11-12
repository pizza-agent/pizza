/**
 * Shell fallback of the cli tool's command table: commands whose first word
 * is not a registered `_xxx` command run here, in a real shell (local child
 * process by default, or any BashOperations backend such as SSH/sandbox).
 */

import { createWriteStream, existsSync } from "node:fs";
import { spawn } from "child_process";
import type { AgentToolResult, AgentToolUpdateCallback } from "../agent/types.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import { injectPizzaPathShims } from "../../utils/path-shims.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import { makePrivateLogPath, PRIVATE_LOG_MODE } from "../../utils/temp-files.js";
import { splitShellSegments, splitShellWords } from "../exec/shell-words.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Safety-net timeout applied to shell commands when the call omits "timeout".
 * Models routinely underestimate how long a command can block (a "find /"
 * scanning network mounts ran ~8h in the wild and starved the follow-up
 * queue), so shell commands never run unbounded by default. Pass "timeout: 0"
 * to disable, or an explicit value to extend. Underscore commands are
 * unaffected — those that wait have their own flags (e.g. "_computer_use wait
 * --timeout-ms").
 */
export const DEFAULT_CLI_SHELL_TIMEOUT_MS = 600_000;

/**
 * Pluggable operations for the shell fallback.
 * Override these to delegate command execution to remote systems (for example SSH).
 * `options.timeout` is in milliseconds, passed through unchanged from the tool call.
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			/** Timeout in milliseconds; omitted or non-positive means no timeout. */
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

/** Policy for the shell fallback. A policy, not a security boundary. */
export interface ShellPolicy {
	/** When set, the first word of every shell segment must match one entry. */
	allow?: (string | RegExp)[];
	/** The first word of no shell segment may match any entry. */
	deny?: (string | RegExp)[];
}

/** Configuration of the shell fallback (`createSessionFacade({ shell })`). */
export interface ShellOptions {
	/** Remote/sandbox execution backend. Default: local shell. */
	operations?: BashOperations;
	/** Prepended to every shell command (default: settings shellCommandPrefix). */
	commandPrefix?: string;
	/** Explicit shell binary for the local backend (default: settings shellPath). */
	shellPath?: string;
	/** Adjust command, cwd, or env right before spawning. */
	spawnHook?: BashSpawnHook;
	/**
	 * First-word allow/deny rules, checked per segment of the model's raw
	 * command (before commandPrefix/spawnHook). Can be bypassed via sh -c,
	 * env, xargs, ...; real isolation needs `operations` (sandbox/remote).
	 */
	policy?: ShellPolicy;
}

/** Details attached to shell fallback results. */
export interface ShellDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Create bash operations using Pizza's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want Pizza's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const childEnv = injectPizzaPathShims(env ?? getShellEnv());
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: true,
					env: childEnv,
					stdio: ["ignore", "pipe", "pipe"],
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

function matchesRule(word: string, rule: string | RegExp): boolean {
	return typeof rule === "string" ? word === rule : rule.test(word);
}

/**
 * First words of every segment a shell would run: chained segments
 * (&&, ||, ;, |, newline) plus command substitutions ($(...) and `...`).
 */
export function shellCommandFirstWords(command: string): string[] {
	const pieces = [command];
	for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
		pieces.push(match[1] ?? match[2] ?? "");
	}
	const words: string[] = [];
	for (const piece of pieces) {
		for (const line of piece.split("\n")) {
			for (const segment of splitShellSegments(line)) {
				const word = splitShellWords(segment.trim())[0];
				if (word) words.push(word);
			}
		}
	}
	return words;
}

/** Returns a violation message, or undefined when the command passes the policy. */
export function checkShellPolicy(command: string, policy: ShellPolicy | undefined): string | undefined {
	if (!policy || (!policy.allow && !policy.deny)) return undefined;
	for (const word of shellCommandFirstWords(command)) {
		if (policy.deny?.some((rule) => matchesRule(word, rule))) {
			return `Shell command "${word}" is denied by the session's shell policy.`;
		}
		if (policy.allow && !policy.allow.some((rule) => matchesRule(word, rule))) {
			const allowed = policy.allow.map((rule) => (typeof rule === "string" ? rule : rule.toString())).join(", ");
			return `Shell command "${word}" is not allowed by the session's shell policy. Allowed: ${allowed}.`;
		}
	}
	return undefined;
}

/**
 * Detect a command-table name that appears as the FIRST word of a shell
 * segment AFTER a chaining operator (&&, ||, ;, |). e.g.
 *   sed -i ... file && _read file 88   →  returns "_read"
 *
 * Failure heuristic only: such a command ran in the shell (the first word was
 * not a table command), which reports "_read: command not found". The result
 * is used to append advisory text after a non-zero exit — never to block.
 */
export function detectChainedBuiltin(command: string, tokens: readonly string[]): string | null {
	const names = new Set(tokens.map((token) => token.toLowerCase()));
	const segments = splitShellSegments(command);
	for (let i = 1; i < segments.length; i++) {
		const word = splitShellWords(segments[i])[0]?.toLowerCase() ?? "";
		if (word && names.has(word)) return word;
	}
	return null;
}

export interface RunShellCommandOptions {
	cwd: string;
	operations: BashOperations;
	commandPrefix?: string;
	spawnHook?: BashSpawnHook;
	timeout?: number;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<ShellDetails | undefined>;
	/** Command-table names, for the chained-command hint on failure. */
	commandNames: readonly string[];
}

/**
 * Run one command through the shell fallback. Resolves with the (tail
 * truncated) output; rejects with the output on non-zero exit, timeout or
 * abort so the call is recorded as an error.
 */
export function runShellCommand(command: string, options: RunShellCommandOptions): Promise<AgentToolResult<ShellDetails | undefined>> {
	const { cwd, operations, commandPrefix, spawnHook, timeout, signal, onUpdate } = options;
	const prefixed = commandPrefix ? `${commandPrefix}\n${command}` : command;
	const baseContext: BashSpawnContext = { command: prefixed, cwd, env: { ...getShellEnv() } };
	const spawnContext = spawnHook ? spawnHook(baseContext) : baseContext;
	onUpdate?.({ content: [], details: undefined });
	return new Promise((resolve, reject) => {
		let tempFilePath: string | undefined;
		let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
		let totalBytes = 0;
		const chunks: Buffer[] = [];
		let chunksBytes = 0;
		const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

		const ensureTempFile = () => {
			if (tempFilePath) return;
			tempFilePath = makePrivateLogPath("bash");
			tempFileStream = createWriteStream(tempFilePath, { mode: PRIVATE_LOG_MODE });
			for (const chunk of chunks) tempFileStream.write(chunk);
		};

		const handleData = (data: Buffer) => {
			totalBytes += data.length;
			// Start writing to a temp file once output exceeds the in-memory threshold.
			if (totalBytes > DEFAULT_MAX_BYTES) {
				ensureTempFile();
			}
			if (tempFileStream) tempFileStream.write(data);
			// Keep a rolling buffer of recent output for tail truncation.
			chunks.push(data);
			chunksBytes += data.length;
			while (chunksBytes > maxChunksBytes && chunks.length > 1) {
				const removed = chunks.shift()!;
				chunksBytes -= removed.length;
			}
			// Stream partial output using the rolling tail buffer.
			if (onUpdate) {
				const truncation = truncateTail(Buffer.concat(chunks).toString("utf-8"));
				if (truncation.truncated) {
					ensureTempFile();
				}
				onUpdate({
					content: [{ type: "text", text: truncation.content || "" }],
					details: {
						truncation: truncation.truncated ? truncation : undefined,
						fullOutputPath: tempFilePath,
					},
				});
			}
		};

		operations
			.exec(spawnContext.command, spawnContext.cwd, {
				onData: handleData,
				signal,
				timeout,
				env: spawnContext.env,
			})
			.then(({ exitCode }) => {
				const fullOutput = Buffer.concat(chunks).toString("utf-8");
				const truncation = truncateTail(fullOutput);
				if (truncation.truncated) {
					ensureTempFile();
				}
				if (tempFileStream) tempFileStream.end();
				let outputText = truncation.content || "(no output)";
				let details: ShellDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: tempFilePath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						// Edge case: the last line alone is larger than the byte limit.
						const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
						outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
					} else if (truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
					} else {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
					}
				}
				if (exitCode !== 0 && exitCode !== null) {
					outputText += `\n\nCommand exited with code ${exitCode}`;
					// Failure heuristic: a command-table name chained after a shell
					// operator ran in the shell as an unknown command. Advisory only.
					const chained = detectChainedBuiltin(command, options.commandNames);
					if (chained) {
						outputText +=
							"\n\n" +
							`(${chained} is a Pizza underscore command. It cannot be ` +
							`chained after shell operators like &&, ||, ;, or | — the shell ran it ` +
							`as an unknown command. Reissue it as a single pure command, e.g. ` +
							`cli("${chained} <args>").)`;
					}
					reject(new Error(outputText));
				} else {
					resolve({ content: [{ type: "text", text: outputText }], details });
				}
			})
			.catch((err: Error) => {
				if (tempFileStream) tempFileStream.end();
				let output = Buffer.concat(chunks).toString("utf-8");
				if (err.message === "aborted") {
					if (output) output += "\n\n";
					output += "Command aborted";
					reject(new Error(output));
				} else if (err.message.startsWith("timeout:")) {
					const timeoutMs = err.message.split(":")[1];
					if (output) output += "\n\n";
					output += `Command timed out after ${timeoutMs}ms`;
					reject(new Error(output));
				} else {
					reject(err);
				}
			});
	});
}
