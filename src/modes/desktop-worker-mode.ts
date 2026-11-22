/**
 * `pizza --mode desktop-worker` — the Pizza-owned desktop automation process.
 *
 * Hosts the agent-desktop C ABI in-process (libagent_desktop_ffi) and serves
 * run requests over a unix socket. Commands the FFI does not cover are spawned
 * through the bundled agent-desktop CLI, so the worker is a drop-in execution
 * backend for runner.ts: {args, stdin} in, {code, stdout, stderr} out.
 *
 * Isolation is the point of the process boundary: a crash inside vendor Rust
 * code takes down the worker, never an agent. The runner respawns it lazily.
 */

import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { execCommand } from "../core/exec/exec.js";
import { loadDesktopFfi, type FfiAdapter } from "../builtin-extensions/agent-desktop/ffi.js";
import { dispatchViaFfi } from "../builtin-extensions/agent-desktop/ffi-dispatch.js";
import { resolveAgentDesktop } from "../builtin-extensions/agent-desktop/resolve-binary.js";

interface WorkerRequest {
	id: number;
	args: string[];
	stdin?: string;
	timeout?: number;
}

interface WorkerResponse {
	id: number;
	code: number;
	stdout: string;
	stderr: string;
}

export function desktopWorkerSocketPath(agentDir = join(homedir(), ".pizza")): string {
	return process.env.PIZZA_DESKTOP_WORKER_SOCKET ?? join(agentDir, "desktop-worker.sock");
}

export async function runDesktopWorkerMode(agentDir: string): Promise<void> {
	const socketPath = desktopWorkerSocketPath(agentDir);
	// The macOS clipboard/keyboard helper path travels in the resolved spawn
	// env for CLI calls; FFI needs it in this process's environment instead.
	const resolved = await resolveAgentDesktop();
	if (resolved?.env) Object.assign(process.env, resolved.env);
	const ffi: FfiAdapter | undefined = await loadDesktopFfi();
	process.stderr.write(
		`desktop-worker: listening on ${socketPath} (ffi: ${ffi ? "loaded" : "unavailable — CLI fallback"})\n`,
	);

	async function handle(request: WorkerRequest): Promise<WorkerResponse> {
		const { id, args, stdin, timeout } = request;
		if (ffi) {
			const ffiResult = dispatchViaFfi(ffi, args, stdin);
			if (ffiResult) return { id, ...ffiResult };
		}
		const resolved = await resolveAgentDesktop();
		if (!resolved) {
			return {
				id,
				code: 127,
				stdout: "",
				stderr: "agent-desktop is not in this Pizza install and was not found on PATH.",
			};
		}
		try {
			const result = await execCommand(resolved.command, [...resolved.argsPrefix, ...args], process.cwd(), {
				timeout,
				input: stdin,
				env: resolved.env,
			});
			return { id, code: result.code, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			return { id, code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	}

	const pending = new Map<Socket, Buffer>();
	const server: Server = createServer((socket) => {
		pending.set(socket, Buffer.alloc(0));
		socket.on("data", (chunk) => {
			const buffer = Buffer.concat([pending.get(socket)!, chunk]);
			let offset = 0;
			while (true) {
				const newline = buffer.indexOf(10, offset);
				if (newline < 0) break;
				const line = buffer.subarray(offset, newline).toString("utf8").trim();
				offset = newline + 1;
				if (!line) continue;
				void (async () => {
					let response: WorkerResponse;
					try {
						const request = JSON.parse(line) as WorkerRequest;
						response = await handle(request);
					} catch (error) {
						response = {
							id: -1,
							code: 1,
							stdout: "",
							stderr: `desktop-worker: bad request: ${error instanceof Error ? error.message : String(error)}`,
						};
					}
					socket.write(`${JSON.stringify(response)}\n`);
				})();
			}
			pending.set(socket, buffer.subarray(offset));
		});
		socket.on("close", () => pending.delete(socket));
		socket.on("error", () => pending.delete(socket));
	});

	if (existsSync(socketPath)) unlinkSync(socketPath);
	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once("error", rejectPromise);
		server.listen(socketPath, () => resolvePromise());
	});

	const shutdown = () => {
		server.close();
		try {
			unlinkSync(socketPath);
		} catch {
			// socket already gone
		}
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
