/**
 * Webhook channel adapter tests — drives createWebhookServer over real HTTP
 * on an ephemeral port with a stub deliver(). Verifies auth, validation, and
 * provenance mapping without needing a gateway or agent.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createWebhookServer, listenAddress } from "../packages/channels/webhook.js";
import type { MessageSource } from "../packages/channels/runtime.js";

const servers: Server[] = [];

afterEach(async () => {
	for (const s of servers.splice(0)) {
		await new Promise<void>((resolve) => s.close(() => resolve()));
	}
});

interface Call {
	workspace: string;
	message: string;
	source: MessageSource;
}

async function start(opts: { token?: string } = {}): Promise<{ port: number; calls: Call[] }> {
	const calls: Call[] = [];
	const server = createWebhookServer({
		token: opts.token,
		defaultWorkspace: "/default-ws",
		deliver: async (workspace, message, source) => {
			calls.push({ workspace, message, source });
			return "pong";
		},
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: (server.address() as AddressInfo).port, calls };
}

async function post(port: number, init?: RequestInit, query = ""): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/${query}`, { method: "POST", ...init });
}

describe("webhook channel adapter", () => {
	it("rejects non-POST methods", async () => {
		const { port } = await start();
		const res = await fetch(`http://127.0.0.1:${port}/`);
		expect(res.status).toBe(405);
	});

	it("enforces the shared secret via Bearer header or ?token=", async () => {
		const { port, calls } = await start({ token: "s3cret" });
		const body = JSON.stringify({ message: "hi" });

		expect((await post(port, { body })).status).toBe(401);
		expect((await post(port, { body, headers: { authorization: "Bearer wrong" } })).status).toBe(401);
		expect((await post(port, { body, headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
		expect((await post(port, { body }, "?token=s3cret")).status).toBe(200);
		expect(calls).toHaveLength(2);
	});

	it("requires a message field", async () => {
		const { port } = await start();
		const res = await post(port, { body: JSON.stringify({}) });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "missing 'message'" });
	});

	it("rejects malformed JSON with 400", async () => {
		const { port } = await start();
		const res = await post(port, { body: "{not json" });
		expect(res.status).toBe(400);
	});

	it("rejects oversized bodies with 413", async () => {
		const { port } = await start();
		const res = await post(port, { body: `{"message":"${"x".repeat(1024 * 1024)}"}` });
		expect(res.status).toBe(413);
	});

	it("delivers to the default workspace with webhook provenance", async () => {
		const { port, calls } = await start();
		const res = await post(port, { body: JSON.stringify({ message: "hello" }) });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ reply: "pong" });
		expect(calls).toEqual([
			{ workspace: "/default-ws", message: "hello", source: { kind: "webhook", id: "webhook" } },
		]);
	});

	it("honours per-request workspace, source and sender", async () => {
		const { port, calls } = await start();
		const res = await post(port, {
			body: JSON.stringify({ message: "deploy?", workspace: "/repo", source: "ci-bot", sender: "CI Bot" }),
		});
		expect(res.status).toBe(200);
		expect(calls[0].workspace).toBe("/repo");
		expect(calls[0].source).toEqual({ kind: "webhook", id: "ci-bot", name: "CI Bot" });
	});

	it("surfaces deliver failures as 502", async () => {
		const server = createWebhookServer({
			defaultWorkspace: "/ws",
			deliver: async () => {
				throw new Error("gateway down");
			},
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		const res = await post(port, { body: JSON.stringify({ message: "x" }) });
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "gateway down" });
	});
});

describe("webhook listenAddress", () => {
	it("derives host/port from webhookUrl", () => {
		expect(listenAddress({ webhookUrl: "http://0.0.0.0:9999/hook" })).toEqual({ host: "0.0.0.0", port: 9999 });
	});

	it("falls back to 127.0.0.1:3002 for a missing port or unparsable URL", () => {
		expect(listenAddress({ webhookUrl: "http://localhost/hook" })).toEqual({ host: "localhost", port: 3002 });
		expect(listenAddress({ webhookUrl: "not a url" })).toEqual({ host: "127.0.0.1", port: 3002 });
	});
});
