import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CONNECTOR_CATALOG, registeredOAuthConnector } from "../src/builtin-extensions/connectors/catalog.js";
import { oauthSetupDefinition, requiredOAuthSetup } from "../apps/web/src/lib/mcp-oauth-setup.js";
import { signInMcpServer } from "../src/builtin-extensions/mcp/oauth.js";
import { MemoryOAuthStateStore } from "../src/core/mcp/oauth/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("Registered OAuth marketplace connections", () => {
	const registered = MCP_CONNECTOR_CATALOG.filter((entry) => entry.oauthSetup === "registered");
	it.each(registered)("requires app credentials and a registered callback for $name", ({ name, config }) => {
		expect(requiredOAuthSetup(config)).toBe("registered");
		const configured = oauthSetupDefinition("registered").build(config, {
			clientId: " own-client ", clientSecret: " own-secret ", callbackUrl: "http://127.0.0.1:8767/callback",
		});
		expect(requiredOAuthSetup(configured)).toBeUndefined();
		expect(configured.oauth).toMatchObject({ clientId: "own-client", clientSecret: "own-secret", callbackUrl: "http://127.0.0.1:8767/callback" });
		expect(registeredOAuthConnector({ ...config, name: `renamed-${name}` })?.name).toBe(name);
	});

	it("does not apply setup requirements by server name or to static-token connections", () => {
		expect(requiredOAuthSetup({ name: "slack", url: "https://other.example/mcp" })).toBeUndefined();
		expect(requiredOAuthSetup({ url: "https://mcp.slack.com/mcp", headers: { authorization: "Bearer ${SLACK_TOKEN}" } })).toBeUndefined();
		expect(registeredOAuthConnector({ url: "https://mcp.box.com/" })?.name).toBe("box");
		expect(registeredOAuthConnector({ url: "https://mcp.box.com.evil.example/" })).toBeUndefined();
	});

	it.each(["https://example.com/callback", "http://127.0.0.1/callback", "http://127.0.0.1:8767/callback?extra=1", "http://user:password@localhost:8767/callback"])("rejects a callback the desktop cannot safely receive: %s", (callbackUrl) => {
		expect(() => oauthSetupDefinition("registered").build(registered[0].config, { clientId: "client", clientSecret: "secret", callbackUrl })).toThrow();
	});

	it("preserves provider settings and clears a stale callback port on edits", () => {
		const config = { ...registered[0].config, oauth: { scope: "specific:read", callbackPort: 4321, clientRegistration: "dcr" }, headers: { "X-Context": "kept" } };
		const configured = oauthSetupDefinition("registered").build(config, { clientId: "client", clientSecret: "secret", callbackUrl: "http://localhost:8767/callback" });
		expect(configured).toMatchObject({ headers: { "X-Context": "kept" }, oauth: { scope: "specific:read", clientRegistration: "dcr" } });
		expect((configured.oauth as Record<string, unknown>).callbackPort).toBeUndefined();
		expect(config.oauth.callbackPort).toBe(4321);
	});

	it.each(registered)("fails before discovery or credential mutation when $name lacks its app", async ({ config }) => {
		const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
		const store = new MemoryOAuthStateStore();
		await expect(signInMcpServer({ serverUrl: String(config.url), store, settings: {}, prompt: { showAuthorizationUrl: vi.fn(), promptForRedirectUrl: vi.fn() } })).rejects.toThrow("OAuth client ID");
		expect(fetch).not.toHaveBeenCalled();
		expect(store.load()).toBeUndefined();
	});
});
