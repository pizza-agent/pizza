/**
 * Client side of the desktop worker. The runner calls {@link runDesktopViaWorker}
 * first; a null result means the worker could not be reached or started, and
 * the caller falls back to spawning the agent-desktop CLI directly.
 */

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { resolveCliSpawn } from "../../../packages/rpc/cli-spawn.js";
import type { DesktopRunOptions, DesktopRunResult } from "./runner.js";

const REQUEST_TIMEOUT_MS = 120_000;
const SPAWN_WAIT_MS = 5_000;
const RESPAWN_COOLDOWN_MS = 10_000;

let lastSpawnAt = 0;

function socketPath(): string {
	return process.env.PIZZA_DESKTOP_WORKER_SOCKET ?? join(homedir(), ".pizza", "desktop-worker.sock");
}

function probe(path: string): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const socket = connect(path);
		socket.once("connect", () => {
			socket.destroy();
			resolvePromise(true);
		});
		socket.once("error", () => resolvePromise(false));
	});
}

/** Spawn `pizza --mode desktop-worker` detached, reusing the CLI spawn rules
 * the gateway daemon uses. Prefers Bun for the script form so the FFI path is
 * available in dev too; falls back to node (worker then CLI-fallbacks). */
function spawnWorker(path: string): void {
	const { cliPath, binary } = resolveCliSpawn();
	const logPath = join(homedir(), ".pizza", "desktop-worker.log");
	let stdio: "ignore" | ["ignore", number, number] = "ignore";
	try {
		const fd = openSync(logPath, "a");
		stdio = ["ignore", fd, fd];
	} catch {
		// keep silent stdio
	}
	const env = { ...process.env, PIZZA_DESKTOP_WORKER_SOCKET: path };
	// Under Bun (dev via `bun dist/src/cli.js` or the compiled binary) the
	// worker inherits an FFI-capable runtime. Under node it still works — the
	// worker just CLI-fallbacks for every command.
	const isBun = "bun" in (process.versions as Record<string, string>);
	const command = binary ? cliPath : isBun ? process.execPath : (process.env.PIZZA_DESKTOP_WORKER_BUN ?? "node");
	const args = binary ? ["--mode", "desktop-worker"] : [cliPath, "--mode", "desktop-worker"];
	const child = spawn(command, args, { detached: true, stdio, env });
	// An unhandled 'error' event on a ChildProcess throws — a spawn failure
	// (missing binary, EACCES) must never take down the agent.
	child.on("error", () => {});
	child.unref();
}

async function ensureWorker(path: string): Promise<boolean> {
	if (await probe(path)) return true;
	// Respawn on every cooldown window so a crashed or wedged worker self-heals;
	// a first spawn that never came up does not permanently disable the path.
	if (Date.now() - lastSpawnAt > RESPAWN_COOLDOWN_MS || lastSpawnAt === 0) {
		lastSpawnAt = Date.now();
		try {
			spawnWorker(path);
		} catch {
			return false;
		}
	}
	const deadline = Date.now() + SPAWN_WAIT_MS;
	while (Date.now() < deadline) {
		if (await probe(path)) return true;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
	}
	return false;
}

/**
 * Send one run request to the worker. Returns null when the worker cannot be
 * reached — the caller should use the CLI path. A worker that dies mid-request
 * also yields null; the next call respawns it after the cooldown.
 */
export async function runDesktopViaWorker(
	args: string[],
	options: DesktopRunOptions,
): Promise<DesktopRunResult | null> {
	if (process.env.PIZZA_DESKTOP_WORKER === "off") return null;
	const path = socketPath();
	if (!(await ensureWorker(path))) return null;

	return new Promise((resolvePromise) => {
		const socket = connect(path);
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => {
			finish(null);
		}, options.timeout ?? REQUEST_TIMEOUT_MS);

		const finish = (result: DesktopRunResult | null) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			resolvePromise(result);
		};
		const onAbort = () => finish(null);
		options.signal?.addEventListener("abort", onAbort, { once: true });

		socket.once("error", () => finish(null));
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(10);
			if (newline < 0) return;
			try {
				const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
				finish({ code: response.code ?? 1, stdout: response.stdout ?? "", stderr: response.stderr ?? "" });
			} catch {
				finish(null);
			}
		});
		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({ id: Date.now(), args, stdin: options.input, timeout: options.timeout })}\n`,
			);
		});
	});
}
