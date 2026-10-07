/**
 * Integration test for the gateway server — verifies socket binding, ping/pong
 * health check, and clean shutdown. Does NOT test agent spawning (that requires
 * a real LLM); the tell path is exercised by the manual smoke test.
 */

import { describe, it, expect, afterEach } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, gatewaySocketPath, type GatewayServer, type AgentConnection } from "../packages/gateway/gateway-server.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";
import { mkdirSync, statSync } from "node:fs";
import { platform } from "node:os";
import type { RpcCommand, RpcResponse } from "../packages/rpc/rpc-types.js";

function uniqueSocketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pizza-gw-"));
	const basename = platform() === "win32" ? `pizza-gw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : "gateway";
	return gatewaySocketPath(basename, dir);
}

async function sendAndWait(socketPath: string, message: object, timeoutMs = 3000): Promise<string> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath);
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("timeout waiting for gateway response"));
		}, timeoutMs);
		sock.once("connect", () => {
			sock.write(`${serializeJsonLine(message)}\n`);
		});
		let buf = "";
		sock.on("data", (chunk) => {
			buf += chunk.toString();
			if (buf.includes("\n")) {
				clearTimeout(timer);
				sock.destroy();
				resolve(buf.trim());
			}
		});
		sock.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

describe("gateway server", () => {
	let server: GatewayServer | undefined;
	const sockets: string[] = [];

	afterEach(async () => {
		if (server) {
			await server.stop().catch(() => {});
			server = undefined;
		}
		for (const sock of sockets) {
			rmSync(sock, { recursive: true, force: true });
		}
		sockets.length = 0;
	});

	it("binds a socket and responds to ping with pong", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();

		const response = await sendAndWait(socketPath, { type: "ping" });
		expect(JSON.parse(response)).toEqual({ type: "pong" });
	});

	it("returns an error for unknown message types", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();

		const response = await sendAndWait(socketPath, { type: "bogus" });
		const parsed = JSON.parse(response);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("bogus");
	});

	it("rejects tell without an id", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();

		const response = await sendAndWait(socketPath, { type: "tell", to: "x", message: "y" });
		const parsed = JSON.parse(response);
		expect(parsed.type).toBe("error");
		expect(parsed.message).toContain("id");
	});

	it("stops cleanly and removes the socket file", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();
		await server.stop();
		server = undefined;
		// After stop, a new connection should fail.
		await expect(sendAndWait(socketPath, { type: "ping" })).rejects.toThrow();
	});

	it("restricts the socket to owner-only permissions (0600)", async () => {
		if (platform() === "win32") return; // named pipes use ACLs
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();
		const mode = statSync(socketPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("normalizes destination paths so path variants share ONE pool entry", async () => {
		// /a/b, /a/b/ and /a/../a/b must resolve to the same agent — divergent
		// pool keys would spawn a second agent for the same workspace and lose
		// the single-instance lock race.
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		const projectDir = mkdtempSync(join(tmpdir(), "pizza-gw-norm-"));
		sockets.push(projectDir);
		mkdirSync(projectDir, { recursive: true });

		const spawnedCwds: string[] = [];
		const fakeAgent = (cwd: string): AgentConnection => ({
			async start() {},
			async stop() {},
			onEvent: () => () => {},
			onExit: () => () => {},
			async sendCommand(command: RpcCommand): Promise<RpcResponse> {
				return { id: (command as { id: string }).id, type: "response", command: (command as { type: string }).type, success: true } as unknown as RpcResponse;
			},
			async prompt() {},
			async followUp() {},
			async waitForIdle() {},
			async getLastAssistantText() { return "ok"; },
		});

		server = createGatewayServer({
			socketPath,
			agentDir: "/tmp/nonexistent-agent",
			agentIdleTimeout: 0,
			agentHealthCheckInterval: 0,
			schedulerGuardInterval: 0,
			createAgent: (cwd) => {
				spawnedCwds.push(cwd);
				return fakeAgent(cwd);
			},
		});
		await server.start();

		// Same directory in three spellings.
		const variants = [projectDir, `${projectDir}/`, `${projectDir}/../${projectDir.split("/").pop()}`];
		for (let i = 0; i < variants.length; i++) {
			const response = await sendAndWait(socketPath, {
				type: "tell",
				id: `t${i}`,
				to: variants[i],
				message: "ping",
				timeoutMs: 2000,
			});
			expect(JSON.parse(response).type).toBe("tell_result");
		}

		// All three tells must have reused ONE agent.
		expect(spawnedCwds).toHaveLength(1);
	});
});