import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CONNECTOR_CATALOG, PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID, PIZZA_GITHUB_OAUTH_AS_METADATA } from "../src/builtin-extensions/connectors/catalog.js";
import { createMcpAuthProvider, signInMcpServer, type McpOAuthSettings } from "../src/builtin-extensions/mcp/oauth.js";
import { canonicalOAuthResource, MemoryOAuthStateStore } from "../src/core/mcp/oauth/index.js";

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
		expect(store.load()?.credentialBinding?.resource).toBe(canonicalOAuthResource(serverUrl));
		expect(fetch.mock.calls.filter(([url]) => String(url).includes("access_token"))).toHaveLength(1);
	});

	it("refreshes a stored catalog resource that still has a trailing slash against PRM without one", async () => {
		const github = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "github")!;
		const catalogUrl = String(github.config.url);
		const prmResource = "https://api.githubcopilot.com/mcp";
		expect(catalogUrl).toBe(`${prmResource}/`);
		expect(canonicalOAuthResource(catalogUrl)).toBe(prmResource);
		expect(canonicalOAuthResource(prmResource)).toBe(prmResource);

		const settings = github.config.oauth as McpOAuthSettings;
		const store = new MemoryOAuthStateStore();
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url === settings.deviceAuthorizationUrl) {
				return Response.json({ device_code: "device-secret", user_code: "PZZA-TEST", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 0.001 });
			}
			if (url === PIZZA_GITHUB_OAUTH_AS_METADATA.token_endpoint) {
				return Response.json({ access_token: "device-access", refresh_token: "device-refresh", token_type: "bearer", expires_in: 28800 });
			}
			return new Response("", { status: 404 });
		}));
		await signInMcpServer({
			serverUrl: catalogUrl,
			store,
			settings,
			prompt: { showAuthorizationUrl: () => {}, showDeviceCode: () => {}, promptForRedirectUrl: () => new Promise(() => {}) },
		});
		// Device login persists the normalized resource, not the catalog URL's trailing slash.
		expect(store.load()?.credentialBinding?.resource).toBe(prmResource);

		const saved = store.load()!;
		store.save({
			...saved,
			tokensExpireAt: Date.now() - 1,
			credentialBinding: { ...saved.credentialBinding!, resource: catalogUrl },
		});
		const refresh = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("oauth-protected-resource")) {
				return Response.json({ resource: prmResource, authorization_servers: [PIZZA_GITHUB_OAUTH_AS_METADATA.issuer] });
			}
			expect(url).toBe(PIZZA_GITHUB_OAUTH_AS_METADATA.token_endpoint);
			const params = init?.body as URLSearchParams;
			expect(params.get("grant_type")).toBe("refresh_token");
			expect(params.get("refresh_token")).toBe("device-refresh");
			expect(params.get("resource")).toBe(prmResource);
			expect(params.get("client_secret")).toBeNull();
			expect(new Headers(init?.headers).has("Authorization")).toBe(false);
			return Response.json({ access_token: "refreshed-access", refresh_token: "refreshed-refresh", token_type: "bearer", expires_in: 28800 });
		});
		vi.stubGlobal("fetch", refresh);
		const provider = createMcpAuthProvider({
			serverUrl: catalogUrl,
			settings: () => settings,
			onChallenge: vi.fn(),
			store: { load: () => store.load(), save: (state) => store.save(state), update: (fn) => store.update(fn), withRefreshLock: (fn) => fn() },
		});
		expect(await provider.token()).toBe("refreshed-access");
		expect(store.load()?.credentialBinding?.resource).toBe(prmResource);
		expect(refresh.mock.calls.filter(([url]) => String(url).includes("access_token"))).toHaveLength(1);
	});
});
