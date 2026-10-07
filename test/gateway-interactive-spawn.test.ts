/**
 * Gateway agent spawn modes: headless vs interactive.
 *
 * PIZZA_HEADLESS agents install no approval handler (gated tool calls
 * auto-reject instead of hanging forever) — correct for tell-routed
 * sub-agents and scheduler/cron spawns, where no human is attached. Desktop
 * channel spawns (attach / channel rpc) DO have a human: the web UI answers
 * approvals via the channel's approve/reject commands, so those agents must
 * be interactive. Blanket-headless used to auto-reject every gated tool call
 * in the desktop user's own conversation.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, gatewaySocketPath, type GatewayServer, type AgentConnection } from "../packages/gateway/gateway-server.js";
import { GatewayTransport } from "../packages/gateway/channel-client.js";

function uniqueSocketPath(): string {
	return gatewaySocketPath(`pizza-gw-interactive-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tmpdir());
}

/** Fake agent recording spawn mode + stop calls. */
class FakeAgent implements AgentConnection {
	readonly stopped = false;
	constructor(readonly cwd: string, readonly interactive: boolean) {}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		(this as { stopped?: boolean }).stopped = true;
	}
	onEvent(): () => void {
		return () => {};
	}
	onExit(): () => void {
		return () => {};
	}
	async sendCommand(command: { id?: string; type: string }): Promise<unknown> {
		return { id: command.id, type: "response", command: command.type, success: true };
	}
	async prompt(): Promise<void> {}
	async followUp(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
	async getLastAssistantText(): Promise<string | null> {
		return "ok";
	}
}

function sendTell(socketPath: string, cwd: string): Promise<string> {
	const net = require("node:net") as typeof import("node:net");
	return new Promise((resolve, reject) => {
		const socket = net.connect(socketPath);
		socket.on("error", reject);
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const line = buffer.split("\n").find((l) => l.includes("tell_result"));
			if (line) {
				socket.end();
				resolve(line);
			}
		});
		socket.write(`${JSON.stringify({ type: "tell", id: "t1", to: cwd, message: "ping", timeoutMs: 2000 })}\n`);
		setTimeout(() => {
			socket.destroy();
			reject(new Error("tell timed out"));
		}, 3000);
	});
}

describe("gateway agent spawn: headless vs interactive", () => {
	const servers: GatewayServer[] = [];
	const transports: GatewayTransport[] = [];
	const dirs: string[] = [];
	const spawns: Array<{ cwd: string; interactive: boolean }> = [];

	afterEach(async () => {
		for (const transport of transports.splice(0)) {
			await transport.close().catch(() => {});
		}
		for (const server of servers.splice(0)) {
			await server.stop().catch(() => {});
		}
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		spawns.length = 0;
	});

	function makeServer(socketPath: string): GatewayServer {
		return createGatewayServer({
			socketPath,
			agentDir: "/tmp/nonexistent-agent",
			agentIdleTimeout: 0,
			agentHealthCheckInterval: 0,
			schedulerGuardInterval: 0,
			createAgent: (cwd, opts) => {
				spawns.push({ cwd, interactive: opts.interactive });
				return new FakeAgent(cwd, opts.interactive);
			},
		});
	}

	it("tell spawns a headless agent (auto-reject approvals, no hang)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-interactive-"));
		dirs.push(tmp);
		const socketPath = uniqueSocketPath();
		const server = makeServer(socketPath);
		servers.push(server);
		await server.start();

		await sendTell(socketPath, tmp);

		expect(spawns).toHaveLength(1);
		expect(spawns[0]).toMatchObject({ cwd: tmp, interactive: false });
	});

	it("channel attach spawns an interactive agent (approvals answerable via UI)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-interactive-"));
		dirs.push(tmp);
		const socketPath = uniqueSocketPath();
		const server = makeServer(socketPath);
		servers.push(server);
		await server.start();

		const client = new GatewayTransport({ socketPath });
		transports.push(client);
		await client.connect();
		await client.attach(tmp);

		expect(spawns).toHaveLength(1);
		expect(spawns[0]).toMatchObject({ cwd: tmp, interactive: true });
	});

	it("a headless resident from a tell is respawned interactive when a channel attaches", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-interactive-"));
		dirs.push(tmp);
		const socketPath = uniqueSocketPath();
		const server = makeServer(socketPath);
		servers.push(server);
		await server.start();

		// 1. A tell touches the workspace first → headless resident.
		await sendTell(socketPath, tmp);
		expect(spawns).toHaveLength(1);
		expect(spawns[0]?.interactive).toBe(false);

		// 2. A desktop window attaches → the idle headless resident is
		//    replaced by an interactive one.
		const client = new GatewayTransport({ socketPath });
		transports.push(client);
		await client.connect();
		await client.attach(tmp);

		expect(spawns).toHaveLength(2);
		expect(spawns[1]).toMatchObject({ cwd: tmp, interactive: true });
	});
});
