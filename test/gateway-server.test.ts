/**
 * Integration test for the gateway server — verifies socket binding, ping/pong
 * health check, and clean shutdown. Does NOT test agent spawning (that requires
 * a real LLM); the tell path is exercised by the manual smoke test.
 */

import { describe, it, expect, afterEach } from "vitest";
import { connect, createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

	it("a second gateway on a live socket reports duplicate and never steals it", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await server.start();

		const second = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		const events: string[] = [];
		second.on("duplicate", () => events.push("duplicate"));
		second.on("listening", () => events.push("listening"));
		await second.start();
		expect(events).toEqual(["duplicate"]);

		// Stopping the duplicate must not tear down the incumbent's socket.
		await second.stop();
		const response = await sendAndWait(socketPath, { type: "ping" });
		expect(JSON.parse(response)).toEqual({ type: "pong" });
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

	it("does not steal the socket from a slow owner that answers within the window", async () => {
		if (platform() === "win32") return;
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		// Busy owner: answers ping only after 500ms — far beyond the old 3s
		// single-shot window's spirit of "slow", but well inside ours.
		const listener = createServer((socket) => {
			socket.on("error", () => {});
			socket.once("data", () => setTimeout(() => socket.end(`${serializeJsonLine({ type: "pong" })}\n`), 500));
		});
		await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
		const inode = statSync(socketPath).ino;
		const duplicate = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent", unresponsiveOwnerTimeout: 5_000 });
		const events: string[] = [];
		duplicate.on("duplicate", () => events.push("duplicate"));
		duplicate.on("takeover", () => events.push("takeover"));
		try {
			await duplicate.start();
			expect(events).toEqual(["duplicate"]);
			expect(statSync(socketPath).ino).toBe(inode);
		} finally {
			await duplicate.stop();
			await new Promise<void>((resolve) => listener.close(() => resolve()));
		}
	});

	it("takes over the socket from an owner that never answers ping", async () => {
		if (platform() === "win32") return;
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		// Hung owner: the kernel accepts, but nothing ever replies.
		const accepted: Socket[] = [];
		const listener = createServer((socket) => {
			accepted.push(socket);
			socket.on("error", () => {});
		});
		await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
		const inode = statSync(socketPath).ino;
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent", unresponsiveOwnerTimeout: 300 });
		const events: string[] = [];
		server.on("duplicate", () => events.push("duplicate"));
		server.on("takeover", () => events.push("takeover"));
		server.on("listening", () => events.push("listening"));
		try {
			await server.start();
			expect(events).toEqual(["takeover", "listening"]);
			expect(statSync(socketPath).ino).not.toBe(inode);
			expect(JSON.parse(await sendAndWait(socketPath, { type: "ping" }))).toEqual({ type: "pong" });
		} finally {
			// A raw net.Server unlinks its path on close (libuv) — the
			// gateway avoids that when displaced (covered below); here just
			// drop the stand-in without closing it.
			for (const socket of accepted) socket.destroy();
			listener.unref();
		}
	});

	it("only one of two candidates waiting on a hung owner takes over", async () => {
		if (platform() === "win32") return;
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		const accepted: Socket[] = [];
		const listener = createServer((socket) => {
			accepted.push(socket);
			socket.on("error", () => {});
		});
		await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
		const make = (timeout: number) => {
			const gw = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent", unresponsiveOwnerTimeout: timeout });
			const events: string[] = [];
			gw.on("duplicate", () => events.push("duplicate"));
			gw.on("listening", () => events.push("listening"));
			return { gw, events };
		};
		// Staggered windows: the first takes over, the second must notice.
		const a = make(200);
		const b = make(600);
		try {
			await Promise.all([a.gw.start(), b.gw.start()]);
			expect(a.events).toEqual(["listening"]);
			expect(b.events).toEqual(["duplicate"]);
			expect(JSON.parse(await sendAndWait(socketPath, { type: "ping" }))).toEqual({ type: "pong" });
		} finally {
			await b.gw.stop();
			await a.gw.stop();
			for (const socket of accepted) socket.destroy();
			listener.unref();
		}
	});

	it("a displaced gateway stopping does not unlink its successor's socket", async () => {
		if (platform() === "win32") return;
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		const displaced = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent" });
		await displaced.start();
		// Successor rebinds the path over the displaced gateway's inode.
		unlinkSync(socketPath);
		const successor = createServer((socket) => {
			socket.on("error", () => {});
			socket.on("data", () => socket.end(`${serializeJsonLine({ type: "pong" })}\n`));
		});
		await new Promise<void>((resolve) => successor.listen(socketPath, resolve));
		const inode = statSync(socketPath).ino;
		try {
			await displaced.stop();
			expect(statSync(socketPath).ino).toBe(inode);
			expect(JSON.parse(await sendAndWait(socketPath, { type: "ping" }))).toEqual({ type: "pong" });
		} finally {
			await new Promise<void>((resolve) => successor.close(() => resolve()));
		}
	});

	it("takes over immediately when the silent owner exits during the probe", async () => {
		if (platform() === "win32") return;
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		// Owner dies (e.g. killed by the desktop supervisor) mid-probe: its
		// accepted connection closes without a reply.
		const listener = createServer((socket) => {
			socket.on("error", () => {});
			setTimeout(() => socket.destroy(), 100);
		});
		await new Promise<void>((resolve) => listener.listen(socketPath, resolve));
		server = createGatewayServer({ socketPath, agentDir: "/tmp/nonexistent-agent", unresponsiveOwnerTimeout: 60_000 });
		const events: string[] = [];
		server.on("takeover", () => events.push("takeover"));
		server.on("listening", () => events.push("listening"));
		const started = Date.now();
		try {
			await server.start();
			expect(events).toEqual(["listening"]);
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			await new Promise<void>((resolve) => listener.close(() => resolve()));
		}
	});

	it("emits a watchdog alert from the forwarded agent event stream", async () => {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		const projectDir = mkdtempSync(join(tmpdir(), "pizza-gw-watchdog-"));
		sockets.push(projectDir);

		const listeners: Array<(event: unknown) => void> = [];
		const fakeAgent: AgentConnection = {
			async start() {},
			async stop() {},
			onEvent(listener) {
				listeners.push(listener);
				return () => {};
			},
			onExit: () => () => {},
			async sendCommand(command: RpcCommand): Promise<RpcResponse> {
				return { id: (command as { id: string }).id, type: "response", command: (command as { type: string }).type, success: true } as unknown as RpcResponse;
			},
			async prompt() {},
			async followUp() {},
			async waitForIdle() {},
			async getLastAssistantText() {
				return "ok";
			},
		};

		const alerts: Array<{ kind?: string; workspace?: string }> = [];
		server = createGatewayServer({
			socketPath,
			agentDir: "/tmp/nonexistent-agent",
			agentIdleTimeout: 0,
			agentHealthCheckInterval: 0,
			schedulerGuardInterval: 0,
			watchdog: { tickMs: 20, streamIdleMs: 20 },
			createAgent: () => fakeAgent,
		});
		server.on("watchdog", (alert) => alerts.push(alert));
		await server.start();

		const response = JSON.parse(
			await sendAndWait(socketPath, {
				type: "tell",
				id: "watchdog-tell",
				to: projectDir,
				message: "hello",
				timeoutMs: 1000,
			}),
		);
		expect(response.type).toBe("tell_result");
		expect(listeners.length).toBeGreaterThan(0);

		for (const listener of listeners) {
			listener({ type: "turn_start" });
			listener({ type: "message_start", message: { role: "assistant", content: [], timestamp: Date.now() } });
		}
		await new Promise((resolve) => setTimeout(resolve, 120));

		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ kind: "stream_idle", workspace: projectDir });
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
		const stoppedCwds: string[] = [];
		const fakeAgent = (cwd: string): AgentConnection => ({
			async start() {},
			async stop() { stoppedCwds.push(cwd); },
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
		const variants = [projectDir, `${projectDir}/`, join(projectDir, "..", basename(projectDir))];
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
  const stopped=JSON.parse(await sendAndWait(socketPath,{type:"stop_workspace",id:"stop",workspace:projectDir}));
  expect(stopped).toMatchObject({type:"workspace_stop_result",ok:true});expect(stoppedCwds).toHaveLength(1);
  const stale=JSON.parse(await sendAndWait(socketPath,{type:"rpc",workspace:projectDir,frame:{type:"get_state",id:"stale"}}));
  expect(stale.frame.success).toBe(false);expect(spawnedCwds).toHaveLength(1);
  const reopened=JSON.parse(await sendAndWait(socketPath,{type:"attach",workspace:projectDir}));
  expect(reopened.type).toBe("attach_ok");expect(spawnedCwds).toHaveLength(2);

	});
});
