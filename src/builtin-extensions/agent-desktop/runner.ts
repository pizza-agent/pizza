/**
 * Process boundary for the agent-desktop CLI.
 *
 * Tests replace the runner. Production spawns `agent-desktop` once per
 * command and reads the single JSON envelope on stdout.
 */

import { execCommand, type ExecResult } from "../../core/exec/exec.js";
import { resolveAgentDesktop } from "./resolve-binary.js";

export interface DesktopRunOptions {
	cwd: string;
	input?: string;
	signal?: AbortSignal;
	timeout?: number;
}

export interface DesktopRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type DesktopRunner = (args: string[], options: DesktopRunOptions) => Promise<DesktopRunResult>;

async function defaultRunner(args: string[], options: DesktopRunOptions): Promise<DesktopRunResult> {
	const resolved = await resolveAgentDesktop();
	if (!resolved) {
		return {
			code: 127,
			stdout: "",
			stderr: "agent-desktop is not in this Pizza install and was not found on PATH.",
		};
	}
	let result: ExecResult;
	try {
		result = await execCommand(resolved.command, [...resolved.argsPrefix, ...args], options.cwd, {
			timeout: options.timeout,
			signal: options.signal,
			input: options.input,
			env: resolved.env,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: 127, stdout: "", stderr: message };
	}
	return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

let runner: DesktopRunner = defaultRunner;

export function setDesktopRunnerForTests(next?: DesktopRunner): void {
	runner = next ?? defaultRunner;
}

export function runAgentDesktop(args: string[], options: DesktopRunOptions): Promise<DesktopRunResult> {
	return runner(args, options);
}

export interface DesktopEnvelope {
	ok?: boolean;
	command?: string;
	data?: Record<string, unknown> & { snapshot_id?: string; app?: string; tree?: unknown; matches?: unknown };
	error?: { code?: string; message?: string; details?: { kind?: string } };
}

export function parseEnvelope(stdout: string): DesktopEnvelope | undefined {
	const line = stdout
		.split("\n")
		.map((item) => item.trim())
		.filter((item) => item.startsWith("{"))
		.at(-1);
	if (!line) return undefined;
	try {
		return JSON.parse(line) as DesktopEnvelope;
	} catch {
		return undefined;
	}
}
