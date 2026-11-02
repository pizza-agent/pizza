import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { createMcpAuthProvider, signInMcpServer } from "../src/builtin-extensions/mcp/oauth.js";
import { authorizeMcp, McpOAuthProvider, MemoryOAuthStateStore } from "../src/core/mcp/oauth/index.js";
import { MCP_CONNECTOR_CATALOG, PIZZA_X_MCP_OAUTH_CLIENT_ID } from "../src/builtin-extensions/connectors/catalog.js";
import { validateMcpServerConfig } from "../src/core/mcp/servers.js";

// Callback fixtures must stay local even when another suite configures a system proxy.
let previousDispatcher: Dispatcher;
let directDispatcher: Agent;
beforeEach(() => {
	previousDispatcher = getGlobalDispatcher();
	directDispatcher = new Agent();
	setGlobalDispatcher(directDispatcher);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	setGlobalDispatcher(previousDispatcher);
	// Cancel any remaining fixture sockets instead of waiting for platform TCP timeouts.
	await directDispatcher.destroy();
});

describe("Notion and X OAuth interoperability", () => {
	it.each(["https://mcp.notion.com", "https://unexpected.example", undefined])("registers a public Notion client and validates the returned issuer: %s", async (iss) => {
		const realFetch = globalThis.fetch;
		const store = new MemoryOAuthStateStore();
		let auth!: URL;
		let show!: () => void;
		const shown = new Promise<void>((resolve) => { show = resolve; });
		const register = vi.fn(); const exchange = vi.fn();
		const metadata = { issuer: "https://mcp.notion.com", authorization_endpoint: "https://mcp.notion.com/authorize", token_endpoint: "https://mcp.notion.com/token", registration_endpoint: "https://mcp.notion.com/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true };
		vi.stubGlobal("fetch", vi.fn(async (input, init) => {
			const url = String(input);
			if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.notion.com", authorization_servers: [metadata.issuer], scopes_supported: ["default"] });
			if (url.endsWith("oauth-authorization-server")) return Response.json(metadata);
			if (url === metadata.registration_endpoint) {
				const body = JSON.parse(init.body as string); register(body);
				expect(body).toMatchObject({ client_name: "Pizza", token_endpoint_auth_method: "none", scope: "default" });
				return Response.json({ ...body, client_id: "notion-dynamic-client" });
			}
			if (url === metadata.token_endpoint) {
				const body = init.body as URLSearchParams; exchange();
				expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
				expect(body.get("client_secret")).toBeNull();
				return Response.json({ access_token: "notion-access", refresh_token: "notion-refresh", token_type: "bearer", expires_in: 3600 });
			}
			return new Response("", { status: 404 });
		}));
		const login = signInMcpServer({ serverUrl: "https://mcp.notion.com/mcp", store, settings: { clientName: "Pizza", scope: "default" }, prompt: { showAuthorizationUrl: (url) => { auth = url; show(); }, promptForRedirectUrl: () => new Promise(() => {}) } });
		const outcome = login.then(() => undefined, (error) => error as Error);
		await shown;
		expect(auth.searchParams.get("resource")).toBe("https://mcp.notion.com");
		const callback = new URL(auth.searchParams.get("redirect_uri")!);
		callback.searchParams.set("code", "notion-code"); callback.searchParams.set("state", "wrong-state");
		const rejectedCallback = await realFetch(callback);
		expect(rejectedCallback.status).toBe(400);
		await rejectedCallback.text();
		callback.searchParams.set("state", auth.searchParams.get("state")!);
		if (iss) callback.searchParams.set("iss", iss);
		const response = await realFetch(callback);
		await response.text();
		const error = await outcome;
		expect(register).toHaveBeenCalledTimes(1);
		if (iss === metadata.issuer) {
			expect(response.status).toBe(200); expect(error).toBeUndefined();
			expect(store.load()?.tokens?.refresh_token).toBe("notion-refresh");
			expect(store.load()?.clientInformation?.client_id).toBe("notion-dynamic-client");
		} else {
			expect(response.status).toBe(400); expect(error?.name).toBe("OAuthIssuerMismatchError");
			expect(exchange).not.toHaveBeenCalled(); expect(store.load()?.tokens).toBeUndefined();
		}
	});

	it.each([undefined, "fixture-secret"])("exchanges and rotates X tokens with the appropriate client authentication (secret=%s)", async (clientSecret) => {
		const realFetch = globalThis.fetch;
		const clientId = clientSecret ? "x-client" : PIZZA_X_MCP_OAUTH_CLIENT_ID;
		const store = new MemoryOAuthStateStore();
		let auth!: URL; let show!: () => void;
		const shown = new Promise<void>((resolve) => { show = resolve; });
		const metadata = { issuer: "https://api.x.com", authorization_endpoint: "https://x.com/i/oauth2/authorize", token_endpoint: "https://api.x.com/2/oauth2/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"] };
		let refreshes = 0;
		vi.stubGlobal("fetch", vi.fn(async (input, init) => {
			const url = String(input);
			if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://api.x.com/mcp", authorization_servers: [metadata.issuer] });
			if (url.endsWith("oauth-authorization-server")) return Response.json(metadata);
			if (url === metadata.token_endpoint) {
				const body = init.body as URLSearchParams;
				expect(body.get("resource")).toBe("https://api.x.com/mcp");
				if (clientSecret) expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`);
				else { expect(new Headers(init.headers).has("authorization")).toBe(false); expect(body.get("client_id")).toBe(clientId); }
				if (body.get("grant_type") === "refresh_token") {
					refreshes++; expect(body.get("refresh_token")).toBe("x-refresh-original");
					return Response.json({ access_token: "x-access-new", refresh_token: "x-refresh-rotated", token_type: "bearer", expires_in: 7200 });
				}
				expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
				return Response.json({ access_token: "x-access", refresh_token: "x-refresh-original", token_type: "bearer", expires_in: 7200 });
			}
			return new Response("", { status: 404 });
		}));
		const settings = { ...MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "x")!.config.oauth, clientId, clientSecret, scope: "tweet.read users.read offline.access", authServerMetadataUrl: new URL("https://api.x.com/.well-known/oauth-authorization-server"), callbackUrl: undefined };
		const login = signInMcpServer({ serverUrl: "https://api.x.com/mcp", store, settings, prompt: { showAuthorizationUrl: (url) => { auth = url; show(); }, promptForRedirectUrl: () => new Promise(() => {}) } });
		await shown; expect(auth.origin).toBe("https://x.com");
		expect(auth.searchParams.has("resource")).toBe(false);
		expect(auth.searchParams.get("scope")).toBe("tweet.read users.read offline.access");
		const callback = new URL(auth.searchParams.get("redirect_uri")!);
		callback.searchParams.set("state", auth.searchParams.get("state")!); callback.searchParams.set("code", "x-code");
		const acceptedCallback = await realFetch(callback);
		expect(acceptedCallback.status).toBe(200);
		await acceptedCallback.text(); await login;
		store.save({ ...store.load()!, tokensExpireAt: Date.now() - 1 });
		const provider = createMcpAuthProvider({ serverUrl: "https://api.x.com/mcp", store: { load: () => store.load(), save: (state) => store.save(state), withRefreshLock: (fn) => fn() }, settings: () => settings, onChallenge: () => {} });
		expect(await provider.token()).toBe("x-access-new");
		expect(store.load()?.tokens?.refresh_token).toBe("x-refresh-rotated"); expect(refreshes).toBe(1);
	});
	it("rejects an invalid resource-indicator compatibility setting", () => {
		expect(validateMcpServerConfig("x", { url: "https://api.x.com/mcp", oauth: { authorizationResourceIndicator: "false" } })).toContain("must be a boolean");
	});
	it("still rejects a mismatched resource when the browser indicator is omitted", async () => {
		const redirect = vi.fn();
		const provider = new McpOAuthProvider({ serverUrl: "https://api.x.com/mcp", redirectUrl: "http://127.0.0.1:8766/callback", clientId: "x-client", clientMetadata: {}, onRedirect: redirect });
		vi.stubGlobal("fetch", vi.fn(async (url) => String(url).includes("oauth-protected-resource")
			? Response.json({ resource: "https://other.example/mcp", authorization_servers: ["https://api.x.com"] })
			: Response.json({ issuer: "https://api.x.com", authorization_endpoint: "https://x.com/i/oauth2/authorize", token_endpoint: "https://api.x.com/2/oauth2/token", response_types_supported: ["code"] })));
		await expect(authorizeMcp(provider, { serverUrl: "https://api.x.com/mcp", authorizationResourceIndicator: false })).rejects.toThrow();
		expect(redirect).not.toHaveBeenCalled();
	});

	it("reports the missing X client before attempting unsupported dynamic registration", async () => {
		const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
		await expect(signInMcpServer({ serverUrl: "https://api.x.com/mcp", store: new MemoryOAuthStateStore(), settings: {}, prompt: { showAuthorizationUrl: vi.fn(), promptForRedirectUrl: vi.fn() } })).rejects.toThrow("Client ID");
		expect(fetch).not.toHaveBeenCalled();
		expect(MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "notion")?.config.oauth).toMatchObject({ clientName: "Pizza", scope: "default" });
	});
});
