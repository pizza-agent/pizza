/**
 * Channel supervisor unit tests — the adapter env and save validation. These
 * don't spawn adapter processes or hit the network; the live spawn path is
 * covered by the running gateway.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, loadChannelConfigs, validate } from "../packages/gateway/channel-supervisor.js";
import type { ChannelConfig } from "../packages/channels/index.js";

const dirs: string[] = [];

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pizza-supervisor-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("channel supervisor childEnv", () => {
	it("injects the configured proxy from settings.json", () => {
		const dir = agentDir();
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ network: { proxy: "http://proxy.local:8080" } }));
		const saved = { ...process.env };
		for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete process.env[k];
		try {
			const env = childEnv(dir);
			expect(env.HTTPS_PROXY).toBe("http://proxy.local:8080");
			expect(env.http_proxy).toBe("http://proxy.local:8080");
		} finally {
			process.env = saved;
		}
	});

	it('strips inherited proxy vars when the proxy is "off"', () => {
		const dir = agentDir();
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ network: { proxy: "off" } }));
		const saved = { ...process.env };
		process.env.HTTPS_PROXY = "http://leak:1";
		try {
			expect(childEnv(dir).HTTPS_PROXY).toBeUndefined();
		} finally {
			process.env = saved;
		}
	});
});

describe("channel supervisor loadChannelConfigs", () => {
	it("reads channels.json and tolerates a missing or corrupt file", () => {
		const dir = agentDir();
		expect(loadChannelConfigs(dir)).toEqual([]);
		const config: ChannelConfig = { id: "ch_x", type: "webhook", name: "n", enabled: true, workspace: "/ws" };
		writeFileSync(join(dir, "channels.json"), JSON.stringify([config]));
		expect(loadChannelConfigs(dir)).toEqual([config]);
		writeFileSync(join(dir, "channels.json"), "{not json");
		expect(loadChannelConfigs(dir)).toEqual([]);
	});
});

describe("channel supervisor validate", () => {
	it("requires a name and workspace", () => {
		expect(validate({ type: "webhook", workspace: "/w", webhookUrl: "http://x" })).toMatch(/display name/i);
		expect(validate({ type: "webhook", name: "x", webhookUrl: "http://x" })).toMatch(/workspace/i);
	});

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

	it("requires a bot token for discord and telegram", () => {
		expect(validate({ type: "discord", name: "x", workspace: "/w" })).toMatch(/bot token/i);
		expect(validate({ type: "telegram", name: "x", workspace: "/w", token: "t" })).toBeNull();
	});

	it("rejects unknown types", () => {
		expect(validate({ type: "pagerduty" as ChannelConfig["type"], name: "x", workspace: "/w" })).toMatch(
			/unknown channel type/i,
		);
		expect(validate({ type: "toString" as ChannelConfig["type"], name: "x", workspace: "/w" })).toMatch(
			/unknown channel type/i,
		);
	});
});
