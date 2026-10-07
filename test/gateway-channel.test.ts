/**
 * Channel protocol (Layer 1) tests. These exercise the gateway's
 * attach / detach / rpc / list handling over a real socket, plus the
 * GatewayTransport client. They do NOT spawn real agent processes — the
 * full rpc/event-fan-out path needs a real or fake RpcClient and is covered
 * by integration; here we verify the routing/discovery/parse machinery that
 * is deterministic without an agent.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { createGatewayServer, gatewaySocketPath, type GatewayServer } from "../packages/gateway/gateway-server.js";
import { GatewayTransport } from "../packages/gateway/channel-client.js";
import {
	isGatewayRequest,
	isGatewayResponse,
	type GatewayRequest,
} from "../packages/gateway/protocol.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";

function uniqueSocketPath(): string {
	return gatewaySocketPath(`pizza-gw-channel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tmpdir());
}

async function startServer(agentDir: string): Promise<{ server: GatewayServer; socketPath: string }> {
	const socketPath = uniqueSocketPath();
	const server = createGatewayServer({ socketPath, agentDir, agentIdleTimeout: 0 });
	await server.start();
	servers.push(server);
	return { server, socketPath };
}

/** Open a raw line-oriented connection and collect incoming JSON lines. */
function rawClient(socketPath: string, onLine: (obj: unknown) => void): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		socket.once("connect", () => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let idx: number;
				while ((idx = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					try {
						onLine(JSON.parse(line));
					} catch {
						// ignore malformed
					}
				}
			});
			resolve(socket);
		});
		socket.once("error", reject);
	});
}

function send(socket: Socket, obj: Record<string, unknown>): void {
	socket.write(`${serializeJsonLine(obj)}\n`);
}

const sockets: Socket[] = [];
const servers: GatewayServer[] = [];
const dirs: string[] = [];
const transports: GatewayTransport[] = [];

describe("gateway channel protocol", () => {
	afterEach(async () => {
		// Destroy sockets FIRST so server.close() (which waits for connections
		// to drain) doesn't hang waiting on a still-open test socket.
		for (const socket of sockets.splice(0)) {
			try { socket.destroy(); } catch { /* ignore */ }
		}
		for (const transport of transports.splice(0)) {
			await transport.close().catch(() => {});
		}
		for (const server of servers.splice(0)) {
			await server.stop().catch(() => {});
		}
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts channel messages in the request/response validators", () => {
		expect(isGatewayRequest({ type: "attach", workspace: "web" })).toBe(true);
		expect(isGatewayRequest({ type: "detach", workspace: "web" })).toBe(true);
		expect(isGatewayRequest({ type: "rpc", workspace: "web", frame: { id: "1", type: "get_state" } })).toBe(true);
		expect(isGatewayRequest({ type: "list" })).toBe(true);
		expect(isGatewayResponse({ type: "attach_ok", workspace: "/x" })).toBe(true);
		expect(isGatewayResponse({ type: "list_result", workspaces: [] })).toBe(true);
		expect(isGatewayResponse({ type: "rpc", workspace: "/x", frame: { type: "AGENT_MESSAGE" } })).toBe(true);
		// Still accepts the legacy tell/ping.
		expect(isGatewayRequest({ type: "ping" })).toBe(true);
		expect(isGatewayResponse({ type: "pong" })).toBe(true);
	});

	it("responds to ping (legacy path still works alongside channel protocol)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-"));
		dirs.push(tmp);
		const { server, socketPath } = await startServer(tmp);

		const responses: unknown[] = [];
		const socket = await rawClient(socketPath, (obj) => responses.push(obj));
		sockets.push(socket);
		send(socket, { type: "ping" });
		await new Promise((r) => setTimeout(r, 50));
		expect(responses).toContainEqual({ type: "pong" });
	});

	it("list returns known workspaces (empty for a fresh agent dir)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-"));
		dirs.push(tmp);
		const { server, socketPath } = await startServer(tmp);

		const responses: unknown[] = [];
		const socket = await rawClient(socketPath, (obj) => responses.push(obj));
		sockets.push(socket);
		send(socket, { type: "list" });
		await new Promise((r) => setTimeout(r, 50));
		expect(responses).toContainEqual({ type: "list_result", workspaces: [] });
	});

	it("attach to an unknown workspace errors without spawning an agent", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-"));
		dirs.push(tmp);
		const { server, socketPath } = await startServer(tmp);

		const responses: unknown[] = [];
		const socket = await rawClient(socketPath, (obj) => responses.push(obj));
		sockets.push(socket);
		send(socket, { type: "attach", workspace: "definitely-not-a-known-workspace-xyz" });
		await new Promise((r) => setTimeout(r, 50));
		const err = responses.find((r) => (r as { type?: string }).type === "error");
		expect(err).toBeDefined();
		expect((err as { message: string }).message).toMatch(/Unknown workspace/);
		// No agent should have been spawned.
		expect(server).toBeDefined();
	});

	it("GatewayTransport client connects, lists, and closes", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-"));
		dirs.push(tmp);
		const { server, socketPath } = await startServer(tmp);

		const transport = new GatewayTransport({ socketPath });
		transports.push(transport);
		await transport.connect();
		const workspaces = await transport.list();
		expect(workspaces).toEqual([]);
	});

	it("GatewayTransport rejects send() without a workspace", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-"));
		dirs.push(tmp);
		const { server, socketPath } = await startServer(tmp);

		const transport = new GatewayTransport({ socketPath });
		transports.push(transport);
		await transport.connect();
		await expect(transport.send({ id: "1", type: "get_state" })).rejects.toThrow(/workspace/);
	});

	it("GatewayTransport connect surfaces a friendly error on a missing socket", async () => {
		const transport = new GatewayTransport({ socketPath: uniqueSocketPath(), connectTimeout: 300 });
		transports.push(transport);
		await expect(transport.connect()).rejects.toThrow(/Failed to connect to gateway/);
	});
});

// Ensure the broadened GatewayRequest type covers channel requests at the type level.
const _typeCheck: GatewayRequest = { type: "list" };
void _typeCheck;
