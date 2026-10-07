/**
 * End-to-end channel fan-out test.
 *
 * Spins up a real gateway server with a FAKE agent injected via
 * `createAgent` (no real `pizza` process), then connects two GatewayTransport
 * channel clients to the same workspace. Verifies the core multi-channel
 * contract:
 *   - a command from channel A is forwarded to the agent and its response is
 *     routed back to A only (by frame.id),
 *   - an event emitted by the agent fans out to BOTH A and B,
 *   - both channels share the ONE agent the gateway owns.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, gatewaySocketPath, type GatewayServer, type AgentConnection } from "../packages/gateway/gateway-server.js";
import { GatewayTransport } from "../packages/gateway/channel-client.js";
import type { RpcCommand, RpcResponse } from "../packages/rpc/rpc-types.js";

function uniqueSocketPath(): string {
	return gatewaySocketPath(`pizza-gw-fanout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tmpdir());
}

/** A fake workspace agent: records sent commands, lets the test emit events. */
class FakeAgent implements AgentConnection {
	private listeners = new Set<(event: unknown) => void>();
	readonly sent: RpcCommand[] = [];

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	onEvent(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	onExit(_listener: () => void): () => void {
		return () => {};
	}
	async sendCommand(command: RpcCommand): Promise<RpcResponse> {
		this.sent.push(command);
		// Echo a success response carrying the same id so the channel correlates it.
		return { id: command.id, type: "response", command: command.type, success: true } as unknown as RpcResponse;
	}
	async prompt(): Promise<void> {}
	async followUp(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
	async getLastAssistantText(): Promise<string | null> {
		return null;
	}

	/** Test helper: push an event to the gateway's forwarder (fans out to subscribers). */
	emit(event: Record<string, unknown>): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

describe("gateway channel fan-out", () => {
	const servers: GatewayServer[] = [];
	const transports: GatewayTransport[] = [];
	const dirs: string[] = [];
	const fakes = new Map<string, FakeAgent>();

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
		fakes.clear();
	});

	it("routes a command's response to the originating channel and fans events to all channels", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-fanout-"));
		dirs.push(tmp);
		const socketPath = uniqueSocketPath();

		// Factory memoizes one fake per cwd → both attaches share the same agent.
		const createAgent = (cwd: string): FakeAgent => {
			let fake = fakes.get(cwd);
			if (!fake) {
				fake = new FakeAgent();
				fakes.set(cwd, fake);
			}
			return fake;
		};

		const server = createGatewayServer({
			socketPath,
			agentDir: tmp,
			agentIdleTimeout: 0,
			createAgent: createAgent as (cwd: string) => AgentConnection,
		});
		servers.push(server);
		await server.start();

		const workspace = join(tmp, "web"); // absolute cwd → resolveDestination returns it verbatim

		// Two independent channel clients.
		const clientA = new GatewayTransport({ socketPath });
		const clientB = new GatewayTransport({ socketPath });
		transports.push(clientA, clientB);
		await clientA.connect();
		await clientB.connect();

		const eventsA: Record<string, unknown>[] = [];
		const eventsB: Record<string, unknown>[] = [];
		clientA.onEvent((event) => eventsA.push(event));
		clientB.onEvent((event) => eventsB.push(event));

		await clientA.attach(workspace);
		await clientB.attach(workspace);

		// Command from A → agent → response routed back to A only.
		const response = await clientA.sendToWorkspace(workspace, { id: "r1", type: "get_state" });
		expect(response).toMatchObject({ id: "r1", type: "response", command: "get_state", success: true });
		expect(fakes.get(workspace)?.sent.some((c) => c.id === "r1")).toBe(true);

		// The agent emits an event → it must fan out to BOTH channels.
		fakes.get(workspace)?.emit({ type: "AGENT_MESSAGE", text: "hello from the agent" });
		// Give the socket a tick to flush.
		await new Promise((r) => setTimeout(r, 50));

		expect(eventsA.some((e) => e.type === "AGENT_MESSAGE")).toBe(true);
		expect(eventsB.some((e) => e.type === "AGENT_MESSAGE")).toBe(true);

		// B never received A's id-routed response (only events fan out).
		expect(eventsB.some((e) => (e as { id?: string }).id === "r1")).toBe(false);
	});

	it("detach stops event delivery to that channel but not others", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pizza-gw-fanout-"));
		dirs.push(tmp);
		const socketPath = uniqueSocketPath();
		const createAgent = (cwd: string): FakeAgent => {
			let fake = fakes.get(cwd);
			if (!fake) {
				fake = new FakeAgent();
				fakes.set(cwd, fake);
			}
			return fake;
		};
		const server = createGatewayServer({
			socketPath,
			agentDir: tmp,
			agentIdleTimeout: 0,
			createAgent: createAgent as (cwd: string) => AgentConnection,
		});
		servers.push(server);
		await server.start();

		const workspace = join(tmp, "api");
		const clientA = new GatewayTransport({ socketPath });
		const clientB = new GatewayTransport({ socketPath });
		transports.push(clientA, clientB);
		await clientA.connect();
		await clientB.connect();

		const eventsA: Record<string, unknown>[] = [];
		const eventsB: Record<string, unknown>[] = [];
		clientA.onEvent((event) => eventsA.push(event));
		clientB.onEvent((event) => eventsB.push(event));

		await clientA.attach(workspace);
		await clientB.attach(workspace);

		fakes.get(workspace)?.emit({ type: "AGENT_MESSAGE", text: "before detach" });
		await new Promise((r) => setTimeout(r, 50));
		expect(eventsA).toHaveLength(1);
		expect(eventsB).toHaveLength(1);

		await clientA.detach(workspace);
		await new Promise((r) => setTimeout(r, 50));

		fakes.get(workspace)?.emit({ type: "AGENT_MESSAGE", text: "after detach" });
		await new Promise((r) => setTimeout(r, 50));
		expect(eventsA).toHaveLength(1); // A got nothing more
		expect(eventsB).toHaveLength(2); // B keeps receiving
	});
});
