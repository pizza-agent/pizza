/**
 * Gateway scheduler-guard tests.
 *
 * The guard is the final replacement for the desktop's Rust sidecar keep-alive:
 * the gateway daemon scans scheduler scopes on disk, spawns a pooled agent for
 * any cwd with runnable scheduled tasks, and pins those agents against idle
 * eviction. These tests use a fake AgentConnection and tiny intervals.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, gatewaySocketPath, type GatewayServer, type AgentConnection } from "../packages/gateway/gateway-server.js";
import { scheduledCwdsOnDisk, normalizeCwd } from "../packages/gateway/scheduler-guard.js";
import { writeTasks } from "../src/core/scheduler/index.js";
import type { ScheduledTask } from "../src/core/scheduler/index.js";
import type { RpcCommand, RpcResponse } from "@tomsun28/pizza-protocol";

class FakeAgent implements AgentConnection {
	readonly cwd: string;
	stopCalls = 0;
	constructor(cwd: string) {
		this.cwd = cwd;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {
		this.stopCalls++;
	}
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
	getStderr(): string {
		return "";
	}
}

function uniqueSocketPath(): string {
	return gatewaySocketPath(`pizza-gw-sched-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tmpdir());
}

function tick(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

let home: string;
let agentDir: string;
let projectDir: string;
let originalHome: string | undefined;
let originalAgentDir: string | undefined;
const servers: GatewayServer[] = [];

beforeEach(() => {
	originalHome = process.env.PIZZA_HOME;
	originalAgentDir = process.env.PIZZA_CODING_AGENT_DIR;
	home = mkdtempSync(join(tmpdir(), "pizza-gw-sched-home-"));
	agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	projectDir = join(home, "project");
	mkdirSync(projectDir, { recursive: true });
	process.env.PIZZA_HOME = home;
	process.env.PIZZA_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	for (const s of servers.splice(0)) {
		await s.stop().catch(() => {});
	}
	if (originalHome === undefined) delete process.env.PIZZA_HOME;
	else process.env.PIZZA_HOME = originalHome;
	if (originalAgentDir === undefined) delete process.env.PIZZA_CODING_AGENT_DIR;
	else process.env.PIZZA_CODING_AGENT_DIR = originalAgentDir;
	rmSync(home, { recursive: true, force: true });
});

/** Register a workspace meta (workspace_id → cwd) the way the agent does. */
function writeWorkspaceMeta(workspaceId: string, cwd: string): void {
	const dir = join(agentDir, "workspaces", workspaceId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "meta.json"),
		JSON.stringify({ workspace_id: workspaceId, cwd, created_at: Date.now(), last_accessed_at: Date.now() }),
	);
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
	return {
		id: `st_${Math.random().toString(36).slice(2, 10)}`,
		name: "t",
		prompt: "ping",
		scope: "workspace",
		schedule: { mode: "every_n_minutes", everyN: { n: 5, unit: "minute" } },
		enabled: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		createdBy: "user",
		runCount: 0,
		sessionTarget: { kind: "pinned", sessionId: "sess_x" },
		...overrides,
	};
}

describe("scheduledCwdsOnDisk", () => {
	it("finds a workspace cwd with a runnable task", () => {
		writeWorkspaceMeta("ws_guard1", projectDir);
		writeTasks("workspace", "ws_guard1", [makeTask({ workspaceId: "ws_guard1" })]);
		const cwds = scheduledCwdsOnDisk(agentDir);
		expect(cwds.has(normalizeCwd(projectDir))).toBe(true);
	});

	it("ignores disabled / unsupported-target / capped tasks", () => {
		writeWorkspaceMeta("ws_guard2", projectDir);
		writeTasks("workspace", "ws_guard2", [
			makeTask({ enabled: false }),
			makeTask({ sessionTarget: { kind: "current" } }),
			makeTask({ sessionTarget: { kind: "pinned" } }), // no sessionId
			makeTask({ maxRuns: 3, runCount: 3 }),
		]);
		expect(scheduledCwdsOnDisk(agentDir).size).toBe(0);
	});

	it("includes the main scope via mainDir", () => {
		const mainDir = join(home, "main");
		mkdirSync(mainDir, { recursive: true });
		writeTasks("main", undefined, [makeTask({ scope: "main" })]);
		const cwds = scheduledCwdsOnDisk(agentDir, mainDir);
		expect(cwds.has(normalizeCwd(mainDir))).toBe(true);
	});

	it("skips workspaces whose cwd no longer exists", () => {
		writeWorkspaceMeta("ws_gone", join(home, "deleted-project"));
		writeTasks("workspace", "ws_gone", [makeTask({ workspaceId: "ws_gone" })]);
		expect(scheduledCwdsOnDisk(agentDir).size).toBe(0);
	});
});

describe("gateway scheduler guard", () => {
	it("spawns an agent for a scheduled cwd and pins it against idle eviction", async () => {
		writeWorkspaceMeta("ws_pin", projectDir);
		writeTasks("workspace", "ws_pin", [makeTask({ workspaceId: "ws_pin" })]);

		const agents = new Map<string, FakeAgent>();
		const server = createGatewayServer({
			socketPath: uniqueSocketPath(),
			agentDir,
			agentIdleTimeout: 50, // tiny idle timeout: unpinned agents die fast
			agentHealthCheckInterval: 0,
			schedulerGuardInterval: 40,
			createAgent: (cwd) => {
				const agent = new FakeAgent(cwd);
				agents.set(cwd, agent);
				return agent;
			},
		});
		servers.push(server);
		await server.start();

		// Guard's immediate first tick spawns the scheduled agent.
		await tick(30);
		const spawned = Array.from(agents.keys()).find((k) => normalizeCwd(k) === normalizeCwd(projectDir));
		expect(spawned).toBeDefined();

		// Wait well past the idle timeout — the pinned agent must survive.
		await tick(200);
		expect(agents.get(spawned!)!.stopCalls).toBe(0);
	});

	it("lets the agent be evicted once its tasks are gone", async () => {
		writeWorkspaceMeta("ws_unpin", projectDir);
		writeTasks("workspace", "ws_unpin", [makeTask({ workspaceId: "ws_unpin" })]);

		const agents = new Map<string, FakeAgent>();
		const server = createGatewayServer({
			socketPath: uniqueSocketPath(),
			agentDir,
			agentIdleTimeout: 60,
			agentHealthCheckInterval: 0,
			schedulerGuardInterval: 40,
			createAgent: (cwd) => {
				const agent = new FakeAgent(cwd);
				agents.set(cwd, agent);
				return agent;
			},
		});
		servers.push(server);
		await server.start();

		await tick(30);
		const spawned = Array.from(agents.keys()).find((k) => normalizeCwd(k) === normalizeCwd(projectDir));
		expect(spawned).toBeDefined();

		// Remove the task → next guard tick unpins → idle eviction may fire.
		writeTasks("workspace", "ws_unpin", []);
		await tick(300);
		expect(agents.get(spawned!)!.stopCalls).toBeGreaterThan(0);
	});

	it("does not spawn for cwds without runnable tasks", async () => {
		writeWorkspaceMeta("ws_none", projectDir);
		writeTasks("workspace", "ws_none", [makeTask({ enabled: false })]);

		const agents = new Map<string, FakeAgent>();
		const server = createGatewayServer({
			socketPath: uniqueSocketPath(),
			agentDir,
			agentHealthCheckInterval: 0,
			schedulerGuardInterval: 40,
			createAgent: (cwd) => {
				const agent = new FakeAgent(cwd);
				agents.set(cwd, agent);
				return agent;
			},
		});
		servers.push(server);
		await server.start();
		await tick(100);
		expect(agents.size).toBe(0);
	});
});