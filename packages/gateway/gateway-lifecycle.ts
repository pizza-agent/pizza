/**
 * Gateway lifecycle — ensure the gateway daemon is running before a client
 * connects, auto-starting it on demand (like `ssh-agent`).
 *
 * The flow from the client side (e.g. the `_tell` tool):
 *   1. Check if the socket exists and a gateway responds to `ping`.
 *   2. If not, spawn `pizza --mode gateway` as a detached background process
 *      and wait for the socket to appear.
 *   3. Return the socket path so the client can connect.
 *
 * If a gateway IS already running but its reported version doesn't match the
 * caller's version (e.g. the user just upgraded and the old daemon is still
 * alive), it is gracefully shut down and a fresh one is spawned — so upgrading
 * requires no manual `pizza gateway restart`.
 *
 * The gateway daemon itself is implemented in gateway-server.ts and started by
 * main.ts when invoked with `--mode gateway`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serializeJsonLine } from "./jsonl.js";
import { gatewaySocketPath } from "./gateway-server.js";
import { resolveCliSpawn } from "../rpc/cli-spawn.js";

/** How long to wait for a freshly-spawned gateway to bind its socket (ms). */
const GATEWAY_BOOT_TIMEOUT = 15_000;
/** How often to poll for the socket / ping the gateway (ms). */
const GATEWAY_POLL_INTERVAL = 100;
/** How long to wait for a graceful shutdown before giving up (ms). */
const GATEWAY_SHUTDOWN_TIMEOUT = 10_000;
/** How long to wait for busy agents to become idle before forcing shutdown (ms). */
const GATEWAY_DRAIN_TIMEOUT = 30_000;

/** One-line JSONL over a Unix socket / Windows named pipe. Returns the first parsed response. */
function sendOne<T>(socketPath: string, message: Record<string, unknown>, timeoutMs = 5_000): Promise<T> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		socket.once("connect", () => {
			try {
				socket.write(`${serializeJsonLine(message)}\n`);
			} catch (e) {
				clearTimeout(timer);
				socket.destroy();
				reject(e as Error);
			}
		});
		socket.once("error", (err) => {
			clearTimeout(timer);
			socket.destroy();
			reject(err);
		});
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			const nl = buffer.indexOf("\n");
			if (nl !== -1) {
				clearTimeout(timer);
				socket.destroy();
				try {
					resolve(JSON.parse(buffer.slice(0, nl)) as T);
				} catch (e) {
					reject(e as Error);
				}
			}
		});
	});
}

/** PING the gateway at `socketPath`. Returns true if it responds with pong. */
async function pingGateway(socketPath: string, timeoutMs = 2_000): Promise<boolean> {
	try {
		const r = await sendOne<{ type?: string }>(socketPath, { type: "ping" }, timeoutMs);
		return r.type === "pong";
	} catch {
		return false;
	}
}

interface GatewayStatus {
	type: string;
	uptime: number;
	channels: number;
	version: string;
	agents: Array<{ cwd: string; busy: boolean; queueLength: number; lastActivityMs: number }>;
}

/** Query the gateway's status (version + agent busy state). Returns null if unreachable. */
async function queryStatus(socketPath: string): Promise<GatewayStatus | null> {
	try {
		const r = await sendOne<GatewayStatus>(socketPath, { type: "status" }, 3_000);
		return r.type === "status_result" ? r : null;
	} catch {
		return null;
	}
}

/** True if any agent in the pool is currently busy (mid-turn). */
function hasBusyAgents(status: GatewayStatus | null): boolean {
	if (!status) return false;
	return status.agents.some((a) => a.busy);
}

/**
 * Gracefully shut down the gateway: send `shutdown`, then wait for the socket
 * to disappear (Unix) or ping to fail (Windows). Returns true if it stopped
 * within {@link GATEWAY_SHUTDOWN_TIMEOUT}.
 */
async function shutdownGateway(socketPath: string): Promise<boolean> {
	try {
		await sendOne(socketPath, { type: "shutdown" }, 5_000);
	} catch {
		// The gateway may close the connection before replying — that's fine.
	}
	const deadline = Date.now() + GATEWAY_SHUTDOWN_TIMEOUT;
	while (Date.now() < deadline) {
		if (!existsSync(socketPath) || !(await pingGateway(socketPath, 1_000))) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

/**
 * Spawn the gateway as a detached background process. Returns the
 * ChildProcess plus the path of the log file capturing its stdout/stderr;
 * the caller does not wait for it.
 *
 * The gateway inherits PIZZA_AGENT_DIR from the environment so spawned
 * sub-agents share the caller's auth/models.
 */
function spawnGateway(socketPath: string, agentDir: string, cliPathOverride?: string): { child: ChildProcess; logPath: string } {
	// When the caller is not the pizza CLI itself (a channel adapter process
	// whose argv[1] is its own entry script), an explicit cliPath is required —
	// resolveCliSpawn() would otherwise spawn the channel again as "gateway".
	const resolved = cliPathOverride
		? { cliPath: cliPathOverride, binary: false }
		: resolveCliSpawn();
	const { cliPath, binary } = resolved;
	const args = ["--mode", "gateway"];
	// Pass the socket path via env so the daemon picks it up.
	const env: Record<string, string> = {
		...process.env,
		PIZZA_AGENT_DIR: agentDir,
		PIZZA_GATEWAY_SOCKET: socketPath,
	} as Record<string, string>;
	const command = binary ? cliPath : "node";
	const commandArgs = binary ? args : [cliPath, ...args];

	// Capture the daemon's output so a failed boot is diagnosable — the
	// process is detached, so nothing else retains it. Unix sockets get a
	// sibling log (`gateway.sock` → `gateway.log`); Windows named pipes have
	// no filesystem location, so the log goes to the temp dir.
	const logPath = socketPath.endsWith(".sock")
		? `${socketPath.slice(0, -".sock".length)}.log`
		: join(tmpdir(), "pizza-gateway.log");
	let stdio: "ignore" | ["ignore", number, number] = "ignore";
	let logFd: number | undefined;
	try {
		logFd = openSync(logPath, "a");
		stdio = ["ignore", logFd, logFd];
	} catch {
		// Log file unavailable — keep silent stdio.
	}

	const child = spawn(command, commandArgs, {
		detached: true,
		stdio,
		env,
	});
	if (logFd !== undefined) {
		try { closeSync(logFd); } catch { /* ignore */ }
	}
	// Detach so the gateway outlives the parent process.
	child.unref();
	return { child, logPath };
}

/** Remove a stale socket file (Unix only — Windows named pipes have no file). */
function cleanStaleSocket(socketPath: string): void {
	if (existsSync(socketPath)) {
		try { unlinkSync(socketPath); } catch { /* ignore */ }
	}
}

/**
 * Ensure the gateway daemon is running, reachable, and running the same
 * version as the caller. If it's not running, spawn it. If it's running an
 * outdated version (e.g. after an upgrade), gracefully shut it down and
 * spawn a fresh one — waiting for busy agents to finish first so an
 * in-flight turn isn't interrupted.
 *
 * @param agentDir The agent config directory (shared with sub-agents).
 * @param socketPath Optional explicit socket path (default: standard location).
 * @param expectedVersion The caller's Pizza version (from package.json). When
 *   omitted, version checking is skipped (back-compat for callers that don't
 *   pass it).
 * @param cliPath Explicit path to the pizza CLI entry (dist/src/cli.js) to
 *   spawn. Required when the caller is not the CLI itself (e.g. a channel
 *   adapter package) — otherwise the spawn would re-run the caller's own
 *   entry point instead of the pizza CLI.
 */
export async function ensureGateway(agentDir: string, socketPath?: string, expectedVersion?: string, cliPath?: string): Promise<string> {
	const sock = socketPath ?? gatewaySocketPath();

	// Fast path: already running?
	if (existsSync(sock) && (await pingGateway(sock))) {
		// Version check: if the caller knows its version and the running
		// gateway reports a different one, it's a stale daemon from before
		// an upgrade — replace it.
		if (expectedVersion) {
			const status = await queryStatus(sock);
			if (status && status.version && status.version !== expectedVersion) {
				// Wait for busy agents to finish so we don't kill a mid-turn task.
				const drainDeadline = Date.now() + GATEWAY_DRAIN_TIMEOUT;
				while (hasBusyAgents(status) && Date.now() < drainDeadline) {
					await new Promise((r) => setTimeout(r, 1_000));
				}
				// Graceful shutdown, then clean any residual socket file.
				const stopped = await shutdownGateway(sock);
				if (!stopped) {
					cleanStaleSocket(sock);
				}
				// Fall through to spawn a fresh gateway.
			} else {
				return sock;
			}
		} else {
			return sock;
		}
	}

	// Clean up stale socket if any.
	cleanStaleSocket(sock);

	// Spawn the daemon and wait for it to bind. Also watch the child: when
	// the daemon dies before binding (invalid code signature, missing
	// module), its exit status is far more useful than a bare timeout.
	const { child, logPath } = spawnGateway(sock, agentDir, cliPath);

	const deadline = Date.now() + GATEWAY_BOOT_TIMEOUT;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, GATEWAY_POLL_INTERVAL));
		if (existsSync(sock) && (await pingGateway(sock))) {
			return sock;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			const how = child.signalCode
				? `terminated by ${child.signalCode}` +
					(child.signalCode === "SIGKILL"
						? " — on macOS this often means an invalid code signature; run `codesign -v` on the binary"
						: "")
				: `exited with code ${child.exitCode}`;
			throw new Error(
				`Gateway process exited before binding ${sock} (${how}). Daemon log: ${logPath}`,
			);
		}
	}

	throw new Error(
		`Gateway failed to start within ${GATEWAY_BOOT_TIMEOUT / 1000}s (socket: ${sock}). ` +
			`Daemon log: ${logPath}. Try running \`pizza --mode gateway\` manually to see the error.`,
	);
}
