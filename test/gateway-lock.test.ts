/**
 * Gateway ownership lock — one gateway per agent dir.
 *
 * Regression coverage for a stray dev gateway (gateway-dev.sock) holding the
 * main agent while the installed app's gateway (gateway.sock) crash-looped
 * on "Another main agent instance is already running". A gateway now records
 * itself in <agentDir>/gateway.lock; a second gateway on another socket
 * refuses to serve (clients attach to the owner instead), and a main-agent
 * spawn backoff clears as soon as the main lock holder is gone.
 */

import { afterEach, describe, expect, it } from "vitest";
import { connect, createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGatewayServer,
	gatewaySocketPath,
	type AgentConnection,
	type GatewayServer,
} from "../packages/gateway/gateway-server.js";
import { gatewayLockPath, readGatewayOwner } from "../packages/gateway/gateway-lock.js";
import { resolveGatewaySocket } from "../packages/gateway/gateway-lifecycle.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";
import { osProcessStartedAt, readPidLock } from "../src/core/agent/main-agent.js";
import type { RpcCommand, RpcResponse } from "../packages/protocol/index.js";

const isWindows = platform() === "win32";

const lockOf = (pid: number): string => JSON.stringify({ pid, startedAt: osProcessStartedAt(pid) ?? Date.now() });
const servers: GatewayServer[] = [];
const fakes: Server[] = [];
const clients: Socket[] = [];
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pizza-gwlock-"));
	dirs.push(dir);
	return dir;
}

function socketIn(dir: string, name: string): string {
	return isWindows ? gatewaySocketPath(`${name}-${process.pid}-${Date.now()}`) : join(dir, `${name}.sock`);
}

/** A stand-in for another live gateway: answers every line with pong. */
function fakeGateway(socketPath: string): Promise<void> {
	return new Promise((resolve) => {
		const server = createServer((sock) => {
			sock.on("data", () => sock.write(`${serializeJsonLine({ type: "pong" })}\n`));
		});
		fakes.push(server);
		server.listen(socketPath, () => resolve());
	});
}

function writeOwner(agentDir: string, socket: string): void {
	// Our parent is a live process that is not us — a foreign owner.
	writeFileSync(gatewayLockPath(agentDir), JSON.stringify({ pid: process.ppid, startedAt: osProcessStartedAt(process.ppid) ?? Date.now(), socket, version: "0.0.0" }));
}

afterEach(async () => {
	delete process.env.PIZZA_GATEWAY_SOCKET;
	for (const c of clients.splice(0)) c.destroy();
	for (const s of servers.splice(0)) await s.stop().catch(() => {});
	for (const f of fakes.splice(0)) await new Promise((r) => f.close(() => r(undefined)));
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("gateway lock", () => {
	it("records the owning gateway's socket and releases it on stop", async () => {
		const agentDir = tempDir();
		const socketPath = socketIn(agentDir, "gateway");
		const server = createGatewayServer({ socketPath, agentDir, version: "1.2.3" });
		servers.push(server);
		await server.start();

		expect(readPidLock(gatewayLockPath(agentDir))).toMatchObject({ pid: process.pid, socket: socketPath, version: "1.2.3" });

		await server.stop();
		expect(existsSync(gatewayLockPath(agentDir))).toBe(false);
	});

	it("refuses to serve when a live gateway on another socket owns the agent dir", async () => {
		const agentDir = tempDir();
		const ownerSocket = socketIn(agentDir, "gateway-dev");
		await fakeGateway(ownerSocket);
		writeOwner(agentDir, ownerSocket);

		const socketPath = socketIn(agentDir, "gateway");
		const server = createGatewayServer({ socketPath, agentDir });
		servers.push(server);
		const events: string[] = [];
		server.on("listening", () => events.push("listening"));
		server.on("conflict", (owner: { socket: string }) => events.push(`conflict:${owner.socket}`));
		await server.start();

		expect(events).toEqual([`conflict:${ownerSocket}`]);
		if (!isWindows) expect(existsSync(socketPath)).toBe(false);
		// The owner's lock is untouched.
		expect(readGatewayOwner(agentDir)?.socket).toBe(ownerSocket);
	});

	it("supersedes an owner whose socket no longer answers", async () => {
		const agentDir = tempDir();
		writeOwner(agentDir, socketIn(agentDir, "gone"));

		const socketPath = socketIn(agentDir, "gateway");
		const server = createGatewayServer({ socketPath, agentDir });
		servers.push(server);
		const events: string[] = [];
		server.on("listening", () => events.push("listening"));
		server.on("conflict", () => events.push("conflict"));
		await server.start();

		expect(events).toEqual(["listening"]);
		expect(readGatewayOwner(agentDir)?.pid).toBe(process.pid);
	});

	it("clients resolve the owner's socket from the lock", () => {
		const agentDir = tempDir();
		expect(resolveGatewaySocket(agentDir)).toBe(gatewaySocketPath());

		writeOwner(agentDir, "/tmp/owner.sock");
		expect(resolveGatewaySocket(agentDir)).toBe("/tmp/owner.sock");

		process.env.PIZZA_GATEWAY_SOCKET = "/tmp/explicit.sock";
		expect(resolveGatewaySocket(agentDir)).toBe("/tmp/explicit.sock");
	});

	it("a stale owner (dead pid) is ignored", () => {
		const agentDir = tempDir();
		writeFileSync(gatewayLockPath(agentDir), JSON.stringify({ pid: 999_999, startedAt: Date.now(), socket: "/tmp/dead.sock" }));
		expect(readGatewayOwner(agentDir)).toBeNull();
	});
});

class FailingAgent implements AgentConnection {
	constructor(private readonly error?: Error) {}
	async start(): Promise<void> {
		if (this.error) throw this.error;
	}
	async stop(): Promise<void> {}
	onEvent(): () => void {
		return () => {};
	}
	onExit(): () => void {
		return () => {};
	}
	async sendCommand(command: RpcCommand): Promise<RpcResponse> {
		return { id: command.id, type: "response", command: command.type, success: true } as unknown as RpcResponse;
	}
	async prompt(): Promise<void> {}
	async followUp(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
	async getLastAssistantText(): Promise<string | null> {
		return null;
	}
}

async function rpc(socketPath: string, workspace: string, id: string): Promise<Record<string, unknown>> {
	const socket = connect(socketPath);
	clients.push(socket);
	return new Promise((resolve, reject) => {
		let buffer = "";
		socket.once("connect", () => {
			socket.write(`${serializeJsonLine({ type: "rpc", workspace, frame: { id, type: "get_state" } })}\n`);
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (const line of buffer.split("\n").slice(0, -1)) {
				const msg = JSON.parse(line) as { type?: string; frame?: Record<string, unknown> };
				if (msg.type === "rpc" && msg.frame?.id === id) resolve(msg.frame);
			}
		});
		socket.once("error", reject);
	});
}

describe("main agent spawn backoff", () => {
	it("retries immediately once the main lock holder is gone", async () => {
		const agentDir = tempDir();
		const mainDir = join(agentDir, "main");
		mkdirSync(mainDir, { recursive: true });
		writeFileSync(join(mainDir, ".lock"), lockOf(process.ppid));

		let attempts = 0;
		const socketPath = socketIn(agentDir, "gateway");
		const server = createGatewayServer({
			socketPath,
			agentDir,
			mainDir,
			schedulerGuardInterval: 0,
			createAgent: () => {
				attempts++;
				return new FailingAgent(
					attempts === 1 ? new Error("Stderr: Another main agent instance is already running (pid 1).") : undefined,
				);
			},
		});
		servers.push(server);
		await server.start();

		expect((await rpc(socketPath, mainDir, "r1")).success).toBe(false);
		// Holder still alive → backoff applies.
		const blocked = await rpc(socketPath, mainDir, "r2");
		expect(String(blocked.error)).toContain("keeps exiting right after spawn");
		expect(attempts).toBe(1);

		// The user stops the old main agent → the next request spawns at once.
		rmSync(join(mainDir, ".lock"));
		expect((await rpc(socketPath, mainDir, "r3")).success).toBe(true);
		expect(attempts).toBe(2);
	});
});
