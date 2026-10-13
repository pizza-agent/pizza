/**
 * Inline channel hosting — adapters run inside the gateway process via a
 * ChannelBridge instead of a spawned `pizza channel run` subprocess.
 * Uses a fake adapter + bridge; no sockets, no child processes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelSupervisor } from "../packages/gateway/channel-supervisor.js";
import type { ChannelAdapter } from "../packages/channels/types.js";
import type { ChannelBridge, ChannelRuntime } from "../packages/channels/index.js";

const dirs: string[] = [];
const supervisors: ChannelSupervisor[] = [];

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pizza-inline-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const sup of supervisors.splice(0)) await sup.shutdown();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeBridge(): ChannelBridge & { tells: string[]; attached: string[] } {
	const tells: string[] = [];
	const attached: string[] = [];
	let listener: ((event: Record<string, unknown>, ws: string) => void) | undefined;
	return {
		tells,
		attached,
		tell: async (to, message) => {
			tells.push(`${to}:${message}`);
			const messageId = "m_test";
			// Simulate the agent: our prompt lands as USER_MESSAGE, then the
			// turn completes — the same pair ChannelRuntime watches for.
			setTimeout(() => {
				listener?.({ type: "USER_MESSAGE", payload: { content: `<message id="${messageId}">` } }, to);
				listener?.({ type: "AGENT_TURN_COMPLETED" }, to);
			}, 0);
			return { messageId };
		},
		attach: async (ws) => {
			attached.push(ws);
			return ws;
		},
		detach: async () => {},
		onEvent: (l) => {
			listener = l as never;
			return () => {};
		},
		sendToWorkspace: async () => ({ success: true, data: { text: "pong" } }),
	};
}

function fakeAdapter(starts: number[], stops: number[]): ChannelAdapter {
	return {
		validate: () => null,
		probe: async () => ({ ok: true, message: "ok" }),
		start: async (config, runtime: ChannelRuntime) => {
			starts.push(1);
			// Exercise the bridge end-to-end like a real adapter would.
			const reply = await runtime.deliver(config.workspace, "hello", { kind: "webhook", id: "t" });
			expect(reply).toBe("pong");
			return async () => {
				stops.push(1);
			};
		},
	};
}

function makeSupervisor(dir: string, adapter: ChannelAdapter, bridge?: ChannelBridge): ChannelSupervisor {
	const sup = new ChannelSupervisor(dir, {
		host: () => bridge,
		adapterFor: () => adapter,
	});
	supervisors.push(sup);
	return sup;
}

const config = {
	id: "ch_1",
	type: "webhook" as const,
	name: "wh",
	enabled: true,
	workspace: "/ws",
	webhookUrl: "http://127.0.0.1:3999",
};

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	if (!cond()) throw new Error("condition not met in time");
}

describe("inline channel hosting", () => {
	it("runs the adapter in-process through the bridge", async () => {
		const dir = agentDir();
		const bridge = fakeBridge();
		const starts: number[] = [];
		const stops: number[] = [];
		const sup = makeSupervisor(dir, fakeAdapter(starts, stops), bridge);
		const saved = sup.save({ ...config, token: "t" });

		await waitFor(() => sup.list()[0]?.status === "connected");
		expect(starts).toEqual([1]);
		expect(bridge.attached).toEqual(["/ws"]);
		expect(bridge.tells).toEqual(["/ws:hello"]);

		sup.setEnabled(saved.id, false);
		await waitFor(() => stops.length === 1);
		expect(sup.list()[0].status).toBe("disconnected");
	});

	it("marks a start failure as error and schedules respawn within budget", async () => {
		const dir = agentDir();
		const bridge = fakeBridge();
		let attempts = 0;
		const failing: ChannelAdapter = {
			validate: () => null,
			probe: async () => ({ ok: true, message: "ok" }),
			start: async () => {
				attempts++;
				throw new Error("boom");
			},
		};
		const sup = makeSupervisor(dir, failing, bridge);
		sup.save({ ...config, token: "t" });
		await waitFor(() => attempts >= 1);
		expect(sup.list()[0].status).toBe("error");
		expect(sup.list()[0].lastError).toContain("boom");
	});
});
