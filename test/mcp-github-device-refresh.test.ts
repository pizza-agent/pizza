import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CONNECTOR_CATALOG, PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID, PIZZA_GITHUB_OAUTH_AS_METADATA } from "../src/builtin-extensions/connectors/catalog.js";
import { createMcpAuthProvider, type McpOAuthSettings } from "../src/builtin-extensions/mcp/oauth.js";
import { MemoryOAuthStateStore } from "../src/core/mcp/oauth/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub public device token refresh", () => {
	it("refreshes a device-issued expiring token without a client secret or browser", async () => {
		const serverUrl = "https://api.githubcopilot.com/mcp/";
		const settings = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "github")!.config.oauth as McpOAuthSettings;
		const store = new MemoryOAuthStateStore();
		store.save({ serverUrl, signInId: "fixture-device-signin", tokensExpireAt: Date.now() - 1,
			credentialBinding: { issuer: PIZZA_GITHUB_OAUTH_AS_METADATA.issuer, clientId: PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID, resource: serverUrl, registrationMethod: "pre-registered" },
			tokens: { access_token: "fixture-old", refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 28800 },
		});
		const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
			if (String(input).includes("oauth-protected-resource")) return Response.json({ resource: serverUrl, authorization_servers: [PIZZA_GITHUB_OAUTH_AS_METADATA.issuer] });
			expect(String(input)).toBe(PIZZA_GITHUB_OAUTH_AS_METADATA.token_endpoint);
			const params = init?.body as URLSearchParams;
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("client_id")).toBe(PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID);
			expect(params.get("client_secret")).toBeNull();
			expect(new Headers(init?.headers).has("Authorization")).toBe(false);
			return Response.json({ access_token: "fixture-new", refresh_token: "fixture-rotated", token_type: "bearer", expires_in: 28800 });
		});
		vi.stubGlobal("fetch", fetch);
		const provider = createMcpAuthProvider({ serverUrl, settings: () => settings, onChallenge: vi.fn(),
			store: { load: () => store.load(), save: (state) => store.save(state), update: (fn) => store.update(fn), withRefreshLock: (fn) => fn() },
		});
		expect(await provider.token()).toBe("fixture-new");
		expect(store.load()?.tokens?.refresh_token).toBe("fixture-rotated");
		expect(fetch.mock.calls.filter(([url]) => String(url).includes("access_token"))).toHaveLength(1);
	});
});
