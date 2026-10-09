/**
 * Channel supervisor unit tests — the pure config→env translation and save
 * validation. These don't spawn adapter processes or hit the network; the
 * live spawn path is covered by the running gateway.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFor, validate, type ManagedChannelConfig } from "../packages/gateway/channel-supervisor.js";

function agentDir(): string {
	return mkdtempSync(join(tmpdir(), "pizza-supervisor-"));
}

function baseConfig(over: Partial<ManagedChannelConfig>): ManagedChannelConfig {
	return { id: "ch_x", type: "webhook", name: "n", enabled: true, workspace: "/ws", ...over };
}

describe("channel supervisor envFor", () => {
	it("maps webhook config to WEBHOOK_TOKEN / PORT / WEBHOOK_HOST", () => {
		const dir = agentDir();
		try {
			const env = envFor(
				baseConfig({ token: "s3cret", webhookUrl: "http://0.0.0.0:9999/hook" }),
				dir,
			);
			expect(env.WEBHOOK_TOKEN).toBe("s3cret");
			expect(env.PORT).toBe("9999");
			expect(env.WEBHOOK_HOST).toBe("0.0.0.0");
			expect(env.PIZZA_WORKSPACE).toBe("/ws");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("webhook ignores the channel field — no PIZZA_ROUTES", () => {
		const dir = agentDir();
		try {
			const env = envFor(baseConfig({ webhookUrl: "http://127.0.0.1:3002", channel: "#alerts" }), dir);
			expect(env.PIZZA_ROUTES).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("unparsable webhook URL keeps adapter defaults", () => {
		const dir = agentDir();
		try {
			const env = envFor(baseConfig({ webhookUrl: "not a url" }), dir);
			expect(env.PORT).toBeUndefined();
			expect(env.WEBHOOK_HOST).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("non-webhook types still get PIZZA_ROUTES from channel", () => {
		const dir = agentDir();
		try {
			const env = envFor(baseConfig({ type: "discord", token: "t", channel: "综合" }), dir);
			expect(env.PIZZA_ROUTES).toBe("#综合=/ws");
			expect(env.DISCORD_TOKEN).toBe("t");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("channel supervisor validate", () => {
	it("requires a webhook URL", () => {
		expect(validate({ type: "webhook", name: "x", workspace: "/w" })).toMatch(/webhook url/i);
		expect(validate({ type: "webhook", name: "x", workspace: "/w", webhookUrl: "http://127.0.0.1:3002" })).toBeNull();
	});

	it("requires app credentials for lark", () => {
		expect(validate({ type: "lark", name: "x", workspace: "/w" })).toMatch(/app id/i);
		expect(validate({ type: "lark", name: "x", workspace: "/w", appId: "a", appSecret: "s" })).toBeNull();
	});

	it("requires both tokens for slack", () => {
		expect(validate({ type: "slack", name: "x", workspace: "/w", token: "xoxb-1" })).toMatch(/app-level token/i);
		expect(validate({ type: "slack", name: "x", workspace: "/w", token: "xoxb-1", appToken: "xapp-1" })).toBeNull();
	});

	it("rejects unknown types", () => {
		expect(validate({ type: "pagerduty" as ManagedChannelConfig["type"], name: "x", workspace: "/w" })).toMatch(
			/unknown channel type/i,
		);
	});
});
