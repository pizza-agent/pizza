/**
 * `pizza gateway` subcommand — manage the gateway daemon.
 *
 *   pizza gateway status    Show gateway uptime, channels, and agent pool.
 *   pizza gateway stop      Gracefully stop the gateway and all its agents.
 *   pizza gateway restart   Stop the gateway, then start a fresh one.
 *   pizza gateway start     Start the gateway if it isn't already running.
 */

import { connect } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import chalk from "chalk";
import { gatewaySocketPath, ensureGateway } from "../packages/gateway/index.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";
import { getAgentDir } from "./config.js";
import { mergePathValues, resolveLoginShellPath } from "./utils/login-shell-path.js";

/** One-line JSONL over a Unix socket. Returns the first parsed response. */
function sendOne<T>(socketPath: string, message: Record<string, unknown>, timeoutMs = 5000): Promise<T> {
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

/** Ping the gateway. Returns true if it responds with pong. */
async function pingGateway(socketPath: string): Promise<boolean> {
	try {
		const r = await sendOne<{ type?: string }>(socketPath, { type: "ping" }, 2000);
		return r.type === "pong";
	} catch {
		return false;
	}
}

/** Format milliseconds as a human-readable duration. */
function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

interface StatusResult {
	type: string;
	uptime: number;
	channels: number;
	agents: Array<{ cwd: string; busy: boolean; queueLength: number; lastActivityMs: number }>;
}

async function cmdStatus(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		console.log(chalk.yellow("Gateway is not running (socket not found)."));
		return;
	}
	if (!(await pingGateway(socketPath))) {
		console.log(chalk.yellow("Gateway is not responding (socket exists but ping failed)."));
		console.log(chalk.dim(`  Socket: ${socketPath}`));
		console.log(chalk.dim("  Try: pizza gateway restart"));
		return;
	}
	const r = await sendOne<StatusResult>(socketPath, { type: "status" }, 5000);
	if (r.type !== "status_result") {
		console.log(chalk.red(`Unexpected response: ${JSON.stringify(r)}`));
		return;
	}
	console.log(chalk.green("Gateway is running"));
	console.log(chalk.dim(`  Socket:  ${socketPath}`));
	console.log(chalk.dim(`  Uptime:  ${fmtDuration(r.uptime)}`));
	console.log(chalk.dim(`  Channels: ${r.channels}`));
	if (r.agents.length === 0) {
		console.log(chalk.dim("  Agents:  (none)"));
	} else {
		console.log(chalk.dim(`  Agents:  ${r.agents.length}`));
		for (const a of r.agents) {
			const state = a.busy ? chalk.yellow("busy") : chalk.green("idle");
			const queue = a.queueLength > 0 ? chalk.red(` (queue: ${a.queueLength})`) : "";
			const last = fmtDuration(a.lastActivityMs);
			console.log(`    ${state}  ${a.cwd}${queue} ${chalk.dim(`active ${last} ago`)}`);
		}
	}
}

async function cmdStop(socketPath: string): Promise<void> {
	if (!existsSync(socketPath) || !(await pingGateway(socketPath))) {
		console.log(chalk.yellow("Gateway is not running."));
		// Clean up stale socket.
		if (existsSync(socketPath)) {
			try { unlinkSync(socketPath); } catch { /* ignore */ }
			console.log(chalk.dim("  Removed stale socket."));
		}
		return;
	}
	console.log(chalk.dim("Sending shutdown..."));
	try {
		await sendOne(socketPath, { type: "shutdown" }, 5000);
	} catch {
		// Gateway may close the connection before replying — that's fine.
	}
	// Wait for the socket to disappear.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!existsSync(socketPath) || !(await pingGateway(socketPath))) {
			console.log(chalk.green("Gateway stopped."));
			return;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	console.log(chalk.yellow("Gateway did not stop within 5s — try killall pizza."));
}

async function cmdStart(socketPath: string): Promise<void> {
	if (await pingGateway(socketPath)) {
		console.log(chalk.green("Gateway is already running."));
		console.log(chalk.dim(`  Socket: ${socketPath}`));
		return;
	}
	// Clean up stale socket if any.
	if (existsSync(socketPath)) {
		try { unlinkSync(socketPath); } catch { /* ignore */ }
	}
	console.log(chalk.dim("Starting gateway..."));
	// Spawn `pizza --mode gateway` as a detached process. We use process.argv[1]
	// (the pizza CLI script/binary) directly instead of ensureGateway's
	// resolveCliSpawn, which can misidentify the CLI as a binary when run via
	// a symlink (e.g. npm global install).
	const cliPath = process.argv[1] ?? "pizza";
	const child = spawn(process.execPath, [cliPath, "--mode", "gateway"], {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			// The gateway daemon is spawned from launchd's minimal PATH (GUI/IDE
			// launchers) and never sources the user rc files, so homebrew/cargo/nvm
			// would be missing. Append the captured login-shell PATH so the daemon
			// and every agent it runs finds user-installed tools — after our own
			// PATH, which still describes the environment we were started in.
			PATH: mergePathValues(process.env.PATH, resolveLoginShellPath()),
			PIZZA_GATEWAY_SOCKET: socketPath,
			PIZZA_AGENT_DIR: getAgentDir(),
		},
	});
	child.unref();
	// Wait for the socket to appear and respond to ping.
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 200));
		if (existsSync(socketPath) && (await pingGateway(socketPath))) {
			console.log(chalk.green("Gateway started."));
			console.log(chalk.dim(`  Socket: ${socketPath}`));
			return;
		}
	}
	console.log(chalk.red("Gateway failed to start within 15s."));
	console.log(chalk.dim("Try running: pizza --mode gateway"));
}

async function cmdRestart(socketPath: string): Promise<void> {
	await cmdStop(socketPath);
	await cmdStart(socketPath);
}

function printHelp(): void {
	console.log(`${chalk.bold("pizza gateway")} — manage the gateway daemon

${chalk.bold("Usage:")}
  pizza gateway <command>

${chalk.bold("Commands:")}
  status     Show gateway uptime, channels, and agent pool
  start      Start the gateway if it isn't already running
  stop       Gracefully stop the gateway and all its agents
  restart    Stop the gateway, then start a fresh one
`);
}

export async function handleGatewayCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "gateway") return false;

	const sub = args[1];
	// PIZZA_GATEWAY_SOCKET lets you target a non-default socket, e.g. the
	// dev desktop's gateway-dev.sock: `PIZZA_GATEWAY_SOCKET=~/.pizza/gateway-dev.sock pizza gateway status`
	const socketPath = process.env.PIZZA_GATEWAY_SOCKET ?? gatewaySocketPath();

	switch (sub) {
		case "status":
			await cmdStatus(socketPath);
			return true;
		case "stop":
			await cmdStop(socketPath);
			return true;
		case "start":
			await cmdStart(socketPath);
			return true;
		case "restart":
			await cmdRestart(socketPath);
			return true;
		case "-h":
		case "--help":
		case undefined:
			printHelp();
			return true;
		default:
			console.error(chalk.red(`Unknown gateway subcommand: ${sub}`));
			printHelp();
			process.exit(1);
	}
}
