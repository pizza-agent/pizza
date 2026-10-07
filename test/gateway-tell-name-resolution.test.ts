/**
 * Regression test: workspace-name resolution must include the gateway's own
 * main workspace.
 *
 * `_tell list` (run in the SENDER's agent process) shows every known
 * workspace, including the gateway's main workspace (/Users/…/.pizza/main →
 * "main"). But `resolveDestination` resolved names against
 * `listKnownWorkspaces(agentDir, mainDir)` — which EXCLUDED the main
 * workspace — so `_tell send --to main` failed with "Unknown workspace"
 * while the equivalent absolute path worked. The gateway is not the tell
 * caller; its main workspace is a valid destination like any other.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGatewayServer,
	gatewaySocketPath,
	type GatewayServer,
	type AgentConnection,
} from "../packages/gateway/gateway-server.js";
import { serializeJsonLine } from "../packages/gateway/jsonl.js";

class RecordingAgent implements AgentConnection {
	readonly cwd: string;
	received: string[] = [];
	constructor(cwd: string) {
		this.cwd = cwd;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	onEvent(): () => void {
		return () => {};
	}
	onExit(): () => void {
		return () => {};
	}
	async prompt(message?: string): Promise<void> {
		if (message !== undefined) this.received.push(message);
	}
	async followUp(message?: string): Promise<void> {
		if (message !== undefined) this.received.push(message);
	}
	async waitForIdle(): Promise<void> {}
	async getLastAssistantText(): Promise<string | null> {
		return null;
	}
	getStderr(): string {
		return "";
	}
	async sendCommand(): Promise<never> {
		throw new Error("not implemented in test fake");
	}
}

function uniqueSocketPath(): string {
	return gatewaySocketPath(`pizza-gw-name-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tmpdir());
}

async function sendAndWait(socketPath: string, message: object, timeoutMs = 3000): Promise<string> {
	const { connect } = await import("node:net");
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

describe("gateway tell destination name resolution", () => {
	let server: GatewayServer | undefined;
	const sockets: string[] = [];
	const dirs: string[] = [];

	afterEach(async () => {
		if (server) {
			await server.stop().catch(() => {});
			server = undefined;
		}
		for (const s of sockets.splice(0)) rmSync(s, { recursive: true, force: true });
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** The registry name of a workspace is the LAST PATH COMPONENT of its cwd. */
	/** Register a fake known workspace in the agent dir. */
	function registerWorkspace(agentDir: string, workspaceId: string, cwd: string): void {
		const wsDir = join(agentDir, "workspaces", workspaceId);
		mkdirSync(wsDir, { recursive: true });
		writeFileSync(
			join(wsDir, "meta.json"),
			JSON.stringify({ workspace_id: workspaceId, cwd, created_at: 0, last_accessed_at: 1 }),
		);
	}

	async function startServer(agentDir: string, mainDir: string, createAgent: (cwd: string) => AgentConnection): Promise<void> {
		const socketPath = uniqueSocketPath();
		sockets.push(socketPath);
		server = createGatewayServer({ socketPath, agentDir, mainDir, createAgent });
		await server.start();
	}

	it("resolves the gateway main workspace by NAME despite the mainDir exclusion", async () => {
		// cwd ends in /main so the registry NAME is "main" (last path component).
		const mainWorkspace = join(tmpdir(), `pizza-gw-${process.pid}`, "main");
		const agentDir = mkdtempSync(join(tmpdir(), "pizza-gw-name-"));
		dirs.push(agentDir, mainWorkspace);
		// The known-workspace registry lists the gateway's OWN main workspace.
		registerWorkspace(agentDir, "ws_main", mainWorkspace);

		const fake = new RecordingAgent(mainWorkspace);
		await startServer(agentDir, mainWorkspace, () => fake);

		// Tell it BY NAME — the exact shape that failed before the fix.
		const res = await sendAndWait(server!.socketPath, {
			type: "tell",
			id: "r1",
			to: "main",
			message: "ping by name",
			from: { kind: "agent", id: "/some/other/workspace" },
		});
		const parsed = JSON.parse(res);
		expect(parsed.type).toBe("tell_result");
		expect(parsed.error ?? parsed.ok, JSON.stringify(parsed)).toBeUndefined ?? undefined;
		expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
		expect(fake.received).toHaveLength(1);
		expect(fake.received[0]).toContain("ping by name");
	});

	it("still resolves other workspaces by name (case-insensitive)", async () => {
		const webWorkspace = join(tmpdir(), `pizza-gw-${process.pid}`, "web");
		const agentDir = mkdtempSync(join(tmpdir(), "pizza-gw-name2-"));
		dirs.push(agentDir, webWorkspace);
		registerWorkspace(agentDir, "ws_web", webWorkspace);

		const fake = new RecordingAgent(webWorkspace);
		await startServer(agentDir, join(tmpdir(), `pizza-gw-unrelated-main-${process.pid}`), () => fake);

		const res = await sendAndWait(server!.socketPath, {
			type: "tell",
			id: "r2",
			to: "WEB", // case-insensitive match on the last path component
			message: "hello web",
		});
		const parsed = JSON.parse(res);
		expect(parsed.ok).toBe(true);
		expect(fake.received).toHaveLength(1);
	});

	it("channel list includes the gateway main workspace", async () => {
		const mainWorkspace = join(tmpdir(), `pizza-gw2-${process.pid}`, "main");
		const agentDir = mkdtempSync(join(tmpdir(), "pizza-gw-name3-"));
		dirs.push(agentDir, mainWorkspace);
		registerWorkspace(agentDir, "ws_main", mainWorkspace);

		await startServer(agentDir, mainWorkspace, () => new RecordingAgent(mainWorkspace));

		const res = await sendAndWait(server!.socketPath, { type: "list" });
		const parsed = JSON.parse(res);
		expect(parsed.type).toBe("list_result");
		const cwds = (parsed.workspaces as Array<{ cwd: string }>).map((ws) => ws.cwd);
		expect(cwds).toContain(mainWorkspace);
	});
});
