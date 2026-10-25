/**
 * Spawn crash-loop backoff tests.
 *
 * Regression coverage for the case where an agent can never start — e.g.
 * `~/.pizza/main` whose --main lock is held by a stray `pizza --main`
 * process. Before the backoff, the pool spawned, the process died instantly,
 * its onExit evicted the entry, and the next channel request / scheduler
 * tick spawned again — a hot crash loop that spammed the log and surfaced
 * only "Agent process stopped" to the UI.
 *
 * Now a `start()` rejection (or an exit within AGENT_STABLE_MS of spawning)
 * earns the cwd an exponential backoff: requests during the window are
 * rejected with the recorded stderr instead of re-spawning.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import {
	createGatewayServer,
	gatewaySocketPath,
	type GatewayServer,
	type AgentConnection,
} from "../packages/gateway/gateway-server.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";
import type { RpcCommand, RpcResponse } from "../packages/protocol/index.js";

class FakeAgent implements AgentConnection {
	stopCalls = 0;
	private exitListeners: Array<() => void> = [];
	constructor(
		private startError?: Error,
	) {}
	async start(): Promise<void> {
		if (this.startError) throw this.startError;
	}
	async stop(): Promise<void> {
		this.stopCalls++;
	}
	onEvent(): () => void {
		return () => {};
	}
	onExit(listener: () => void): () => void {
		this.exitListeners.push(listener);
		return () => {
			this.exitListeners = this.exitListeners.filter((l) => l !== listener);
		};
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
	getStderr(): string {
		return "simulated early exit";
	}
	/** Simulate the process dying on its own while pooled. */
	crash(): void {
		for (const l of this.exitListeners) l();
	}
}

const servers: GatewayServer[] = [];
const sockets: Socket[] = [];
const dirs: string[] = [];

function uniqueSocketPath(): string {
	return gatewaySocketPath(
		`pizza-gw-backoff-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		tmpdir(),
	);
}

function tick(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function rawClient(socketPath: string): Promise<{ socket: Socket; lines: unknown[] }> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const lines: unknown[] = [];
		socket.once("connect", () => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let idx: number;
				while ((idx = buffer.indexOf("\n")) !== -1) {
					try {
						lines.push(JSON.parse(buffer.slice(0, idx)));
					} catch { /* ignore */ }
					buffer = buffer.slice(idx + 1);
				}
			});
			resolve({ socket, lines });
		});
		socket.once("error", reject);
	});
}

function send(socket: Socket, obj: Record<string, unknown>): void {
	socket.write(`${serializeJsonLine(obj)}\n`);
}

async function rpc(socket: Socket, cwd: string, id: string): Promise<Record<string, unknown>> {
	send(socket, { type: "rpc", workspace: cwd, frame: { id, type: "get_state" } });
	for (let i = 0; i < 100; i++) {
		await tick(20);
		const hit = (socket as unknown as { __lines: unknown[] }).__lines ?? [];
		const frame = (hit as Array<{ type?: string; frame?: { id?: string } }>)
			.find((m) => m.type === "rpc" && m.frame?.id === id);
		if (frame) return (frame as { frame: Record<string, unknown> }).frame;
	}
	throw new Error("timed out waiting for rpc response");
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) {
		try { socket.destroy(); } catch { /* ignore */ }
	}
	for (const server of servers.splice(0)) {
		await server.stop().catch(() => {});
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("gateway spawn backoff", () => {
	it("backs off instead of hot-looping when start() keeps rejecting", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-backoff-"));
		dirs.push(tmp);
		const cwd = join(tmp, "ws");
		const socketPath = uniqueSocketPath();
		let spawnAttempts = 0;
		const server = createGatewayServer({
			socketPath,
			agentDir: tmp,
			createAgent: () => {
				spawnAttempts++;
				return new FakeAgent(new Error("Agent process failed to start. Stderr: Another main agent instance is already running."));
			},
		});
		await server.start();
		servers.push(server);

		const client = await rawClient(socketPath);
		sockets.push(client.socket);
		(client.socket as unknown as { __lines: unknown[] }).__lines = client.lines;

		const first = await rpc(client.socket, cwd, "r1");
		expect(first.success).toBe(false);
		expect(String(first.error)).toContain("Another main agent instance is already running");
		expect(spawnAttempts).toBe(1);

		// Retries inside the backoff window must NOT spawn again.
		const second = await rpc(client.socket, cwd, "r2");
		expect(second.success).toBe(false);
		expect(String(second.error)).toContain("keeps exiting right after spawn");
		expect(String(second.error)).toContain("Another main agent instance is already running");
		expect(spawnAttempts).toBe(1);
	});

	it("backs off when a pooled agent dies right after spawn", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-backoff-"));
		dirs.push(tmp);
		const cwd = join(tmp, "ws");
		const socketPath = uniqueSocketPath();
		const fakes: FakeAgent[] = [];
		const server = createGatewayServer({
			socketPath,
			agentDir: tmp,
			createAgent: () => {
				const fake = new FakeAgent();
				fakes.push(fake);
				return fake;
			},
		});
		await server.start();
		servers.push(server);

		const client = await rawClient(socketPath);
		sockets.push(client.socket);
		(client.socket as unknown as { __lines: unknown[] }).__lines = client.lines;

		const first = await rpc(client.socket, cwd, "r1");
		expect(first.success).toBe(true);
		expect(fakes.length).toBe(1);

		// The agent dies on its own well within AGENT_STABLE_MS.
		fakes[0].crash();
		await tick(50);

		const second = await rpc(client.socket, cwd, "r2");
		expect(second.success).toBe(false);
		expect(String(second.error)).toContain("keeps exiting right after spawn");
		expect(fakes.length).toBe(1); // no respawn during backoff
	});
});
