/**
 * Idle-eviction liveness tests.
 *
 * Regression coverage for the bug where the gateway decided "is the agent
 * busy" only from the `tell` path: `busy` / `lastActivity` / the idle timer
 * were all maintained exclusively there, while the desktop UI drives agents
 * over the channel `rpc` path (and a prompt command is acked instantly, then
 * the turn plays out as a stream of events). So an agent could be evicted
 * mid-turn.
 *
 * The fix makes the **event stream** the authoritative liveness signal:
 *   - every forwarded event refreshes `lastActivity`,
 *   - the idle timer re-validates against fresh `lastActivity` (not just
 *     `busy || queue`),
 *   - an agent is kept resident while a channel subscriber is attached.
 *
 * These tests use a fake AgentConnection (no real process) and tiny idle
 * timeouts to exercise the eviction logic deterministically.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { createGatewayServer, gatewaySocketPath, type GatewayServer, type AgentConnection } from "../packages/gateway/gateway-server.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";
import type { RpcCommand, RpcResponse } from "@tomsun28/pizza-protocol";

/** Minimal fake agent: records stop() and lets the test emit events. */
class FakeAgent implements AgentConnection {
	readonly cwd: string;
	stopCalls = 0;
	private listeners: Array<(event: unknown) => void> = [];
	constructor(cwd: string) {
		this.cwd = cwd;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopCalls++;
	}
	onEvent(listener: (event: unknown) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
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
	getStderr(): string {
		return "";
	}
	/** Test hook: push an event into every attached listener (the gateway's
	 *  event forwarder subscribes via onEvent, so this exercises it). */
	emit(event: unknown): void {
		for (const l of this.listeners) l(event);
	}
}

function uniqueSocketPath(): string {
	return gatewaySocketPath(`pizza-gw-idle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tmpdir());
}

function tick(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

const servers: GatewayServer[] = [];
const sockets: Socket[] = [];
const intervals: NodeJS.Timeout[] = [];
const dirs: string[] = [];

function rawClient(socketPath: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		socket.once("connect", () => {
			// Drain & discard incoming lines.
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let idx: number;
				while ((idx = buffer.indexOf("\n")) !== -1) buffer = buffer.slice(idx + 1);
			});
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

function send(socket: Socket, obj: Record<string, unknown>): void {
	socket.write(`${serializeJsonLine(obj)}\n`);
}

async function startServer(agentDir: string, idleMs: number): Promise<{
	server: GatewayServer;
	socketPath: string;
	fakes: Map<string, FakeAgent>;
}> {
	const socketPath = uniqueSocketPath();
	const fakes = new Map<string, FakeAgent>();
	const server = createGatewayServer({
		socketPath,
		agentDir,
		agentIdleTimeout: idleMs,
		agentHealthCheckInterval: 0, // disable health checks; we test idle eviction only
		createAgent: (cwd) => {
			const fake = new FakeAgent(cwd);
			fakes.set(cwd, fake);
			return fake;
		},
	});
	await server.start();
	servers.push(server);
	return { server, socketPath, fakes };
}

describe("gateway idle eviction", () => {
	afterEach(async () => {
		for (const iv of intervals.splice(0)) clearInterval(iv);
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

	it("keeps an agent alive while it is streaming events (no subscriber, no tell)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-idle-"));
		dirs.push(tmp);
		const cwd = join(tmp, "ws"); // absolute path → resolveDestination uses it verbatim
		const idleMs = 100;
		const { socketPath, fakes } = await startServer(tmp, idleMs);

		const socket = await rawClient(socketPath);
		sockets.push(socket);
		// Spawn the agent over the channel `rpc` path (no subscriber, no busy).
		send(socket, { type: "rpc", workspace: cwd, frame: { id: "r1", type: "get_state" } });
		await tick(30); // let getOrCreateAgent + forwarder attach
		const fake = fakes.get(cwd)!;
		expect(fake).toBeDefined();

		// Stream events faster than the idle window, well past the timeout.
		const iv = setInterval(() => fake.emit({ type: "AGENT_MESSAGE_CHUNK" }), 25);
		intervals.push(iv);
		await tick(350); // ~3.5x the idle timeout

		// NOT evicted: events refreshed lastActivity even though busy=false and
		// there is no subscriber.
		expect(fake.stopCalls).toBe(0);
	});

	it("keeps an agent resident while a channel subscriber is attached (no events)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-idle-"));
		dirs.push(tmp);
		const cwd = join(tmp, "ws");
		const idleMs = 100;
		const { socketPath, fakes } = await startServer(tmp, idleMs);

		const socket = await rawClient(socketPath);
		sockets.push(socket);
		send(socket, { type: "attach", workspace: cwd });
		await tick(30);
		const fake = fakes.get(cwd)!;
		expect(fake).toBeDefined();

		// No events at all — just an open channel (e.g. a desktop window).
		await tick(350);

		// Resident because a subscriber is attached.
		expect(fake.stopCalls).toBe(0);
	});

	it("still evicts a genuinely idle agent with no subscriber", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-idle-"));
		dirs.push(tmp);
		const cwd = join(tmp, "ws");
		const idleMs = 100;
		const { socketPath, fakes } = await startServer(tmp, idleMs);

		const socket = await rawClient(socketPath);
		sockets.push(socket);
		// Spawn via rpc, then go completely silent (no events, no subscriber).
		send(socket, { type: "rpc", workspace: cwd, frame: { id: "r1", type: "get_state" } });
		await tick(30);
		const fake = fakes.get(cwd)!;
		expect(fake).toBeDefined();

		await tick(350); // well past the idle timeout

		// Evicted: idle, not busy, no subscriber, stale lastActivity.
		expect(fake.stopCalls).toBeGreaterThanOrEqual(1);
	});
});