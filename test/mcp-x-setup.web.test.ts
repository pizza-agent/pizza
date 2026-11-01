import { describe, expect, it } from "vitest";
import { buildXMcpConfig, isLegacyXConnector, xMcpNeedsSetup } from "../apps/web/src/lib/mcp-x-setup.js";
import { MCP_CONNECTOR_CATALOG, PIZZA_X_MCP_URL, PIZZA_X_MCP_OAUTH_CALLBACK_URL } from "../src/builtin-extensions/connectors/catalog.js";

const config = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "x")!.config;
const client = { clientId: "x-native-client", clientSecret: "", callbackUrl: PIZZA_X_MCP_OAUTH_CALLBACK_URL };

describe("X OAuth setup", () => {
	it("accepts a Native app without a secret and requests refresh access", () => {
		expect(xMcpNeedsSetup(config)).toBe(true);
		const result = buildXMcpConfig(config, client);
		expect(xMcpNeedsSetup(result)).toBe(false);
		expect(result).toMatchObject({ url: PIZZA_X_MCP_URL, enabled: true, oauth: { clientId: client.clientId, callbackUrl: client.callbackUrl, scope: "tweet.read users.read offline.access" } });
		expect((result.oauth as Record<string, unknown>).clientSecret).toBeUndefined();
	});
	it("keeps confidential client credentials when explicitly provided", () => {
		expect(buildXMcpConfig(config, { ...client, clientSecret: "fixture-secret" })).toMatchObject({ oauth: { clientSecret: "fixture-secret" } });
	});
	it("converts the previous marketplace bridge only when the user saves X setup", () => {
		const legacy = { command: "npx", args: ["-y", "@xdevplatform/xurl", "mcp", PIZZA_X_MCP_URL], env: { CLIENT_ID: "${X_CLIENT_ID}" }, enabled: false, timeout: 120, description: "My X account" };
		expect(isLegacyXConnector(legacy)).toBe(true);
		expect(xMcpNeedsSetup(legacy)).toBe(true);
		const result = buildXMcpConfig(legacy, client);
		expect(result).toMatchObject({ url: PIZZA_X_MCP_URL, enabled: true, timeout: 120, description: "My X account" });
		expect(result.command).toBeUndefined();
		expect(result.env).toBeUndefined();
		expect(result.args).toBeUndefined();
	});
	it("does not divert a custom stdio server or a bearer-authenticated HTTP server", () => {
		expect(xMcpNeedsSetup({ command: "my-x-server", args: [] })).toBe(false);
		expect(xMcpNeedsSetup({ ...config, headers: { Authorization: "Bearer fixture" } })).toBe(false);
	});
	it.each(["https://example.com/callback", "http://127.0.0.1/callback", "http://localhost:8766/callback?code=test", "javascript:alert(1)"])("rejects an unsafe or unserviceable callback: %s", (callbackUrl) => {
		expect(() => buildXMcpConfig(config, { ...client, callbackUrl })).toThrow();
	});
	it("does not retain an old confidential secret when switching to a Native app", () => {
		const result = buildXMcpConfig({ ...config, oauth: { clientSecret: "old-secret", callbackPort: 8080 } }, client);
		expect((result.oauth as Record<string, unknown>).clientSecret).toBeUndefined();
		expect((result.oauth as Record<string, unknown>).callbackPort).toBeUndefined();
	});
});
