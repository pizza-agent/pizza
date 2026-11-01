import { describe, expect, it } from "vitest";
import { buildGoogleMcpConfig, googleMcpNeedsSetup, parseGoogleOAuthClient } from "../apps/web/src/lib/mcp-google-setup.js";
import { MCP_CONNECTOR_CATALOG, PIZZA_GMAIL_MCP_URL, PIZZA_GMAIL_MCP_OAUTH_CALLBACK_URL } from "../src/builtin-extensions/connectors/catalog.js";

const config = { url: PIZZA_GMAIL_MCP_URL, oauth: {} };
const credentials = { clientId: "pizza-example.apps.googleusercontent.com", clientSecret: "fixture-only-secret", callbackUrl: PIZZA_GMAIL_MCP_OAUTH_CALLBACK_URL };

describe("Gmail setup", () => {
 it("connects marketplace Gmail without a per-user Google Cloud form", () => {
  const entry = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "gmail")!;
  expect(entry.oauthSetup).toBeUndefined();
  expect(entry.config.adapter).toBe("gmail");
  expect(googleMcpNeedsSetup(entry.config)).toBe(false);
  expect((entry.config.oauth as Record<string, unknown>).clientSecret).toBeUndefined();
 });
	it("requires configuration before sign-in, then preserves the user's server options", () => {
		expect(googleMcpNeedsSetup(config)).toBe(true);
		const configured = buildGoogleMcpConfig({ ...config, timeout: 120, description: "My mailbox", oauth: { scope: "custom-scope", callbackPort: 1234 } }, credentials);
		expect(googleMcpNeedsSetup(configured)).toBe(false);
		expect(configured).toMatchObject({ timeout: 120, description: "My mailbox", oauth: { ...credentials, scope: "custom-scope", authorizationParams: { access_type: "offline", prompt: "consent" }, authCheck: { tool: "list_labels" } } });
		expect((configured.oauth as Record<string, unknown>).callbackPort).toBeUndefined();
	});
	it("imports the downloaded Web client and uses its registered loopback callback", () => {
		expect(parseGoogleOAuthClient(JSON.stringify({ web: { client_id: credentials.clientId, client_secret: credentials.clientSecret, redirect_uris: ["https://example.com/callback", "http://localhost:9876/gmail/callback"] } }))).toEqual({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, callbackUrl: "http://localhost:9876/gmail/callback" });
	});
	it.each(["not json", '{"installed":{"client_id":"desktop-client"}}', '{"web":{"client_id":"no-secret"}}'])("rejects an incomplete or incompatible client file", (text) => {
		expect(() => parseGoogleOAuthClient(text)).toThrow();
	});
	it.each(["https://example.com/callback", "http://127.0.0.1/callback", "http://127.0.0.1:8765/callback?state=test", "javascript:alert(1)"])("rejects a callback that Pizza cannot serve: %s", (callbackUrl) => {
		expect(() => buildGoogleMcpConfig(config, { ...credentials, callbackUrl })).toThrow();
	});
	it("keeps PAT-based Gmail and other providers on their existing sign-in path", () => {
		expect(googleMcpNeedsSetup({ ...config, headers: { Authorization: "Bearer fixture-token" } })).toBe(false);
		expect(googleMcpNeedsSetup({ url: "https://mcp.notion.com/mcp", oauth: {} })).toBe(false);
	});
});
