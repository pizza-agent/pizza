import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CONNECTOR_CATALOG } from "../src/builtin-extensions/connectors/catalog.js";
import { createMcpAuthProvider, signInMcpServer, type McpOAuthSettings } from "../src/builtin-extensions/mcp/oauth.js";
import { discoverOAuthServerInfo, MemoryOAuthStateStore, parseWwwAuthenticate, refreshAuthorization, type AuthorizationServerMetadata } from "../src/core/mcp/oauth/index.js";
import { metadataResponse } from "../examples/mcp-oauth/metadata.mjs";

// Anonymous public discovery responses, recorded by scripts/check-mcp-oauth-catalog.mjs.
// Account login and token responses below are simulated; no live credentials or network are used.
const { records } = JSON.parse(readFileSync(new URL("./fixtures/mcp/official-oauth-discovery.json", import.meta.url), "utf8")) as {
	records: Array<{ name: string; url: string; resource: string; challenge: string; responses: Array<{ url: string; status: number; body: string }> }>;
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Official provider OAuth compatibility", () => {
	it.each(records)("uses $name discovery through registration, PKCE exchange and refresh", async (record) => {
		const entry = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === record.name)!;
		const storedResponses = new Map(record.responses.map((response) => [response.url, response]));
		const settings = { ...(entry.config.oauth as object) } as McpOAuthSettings;
		if (settings.authServerMetadataUrl) settings.authServerMetadataUrl = new URL(settings.authServerMetadataUrl);
		if (entry.oauthSetup) Object.assign(settings, { clientId: "fixture-registered", clientSecret: "fixture-secret", callbackUrl: "http://127.0.0.1:8767/callback" });
		const challenge = parseWwwAuthenticate(record.challenge);
		const fixtureFetch = vi.fn(async (input: string | URL) => {
			const response = storedResponses.get(String(input));
			if (!response) throw new Error(`Unrecorded discovery request: ${input}`);
			return new Response(response.body, { status: response.status });
		});
		const discovered = await discoverOAuthServerInfo(record.url, {
			resourceMetadataUrl: challenge.resourceMetadataUrl, authorizationServerMetadataUrl: settings.authServerMetadataUrl, fetch: fixtureFetch,
		});
		const metadata = discovered.authorizationServerMetadata!;
		let authorization!: URL;
		let exchanges = 0, refreshes = 0, registrations = 0;
		const store = new MemoryOAuthStateStore();
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			if (new URL(url).origin === "https://pizza.hertzbeat.com") return metadataResponse(new Request(url));
			if (init?.method === "POST" && url === metadata.registration_endpoint) {
				registrations++;
				const requested = JSON.parse(String(init.body));
				// Real Supabase DCR assigns a secret; GitLab assigns "none" despite its global metadata.
				return Response.json({ ...requested, client_id: "fixture-dynamic", ...(record.name === "supabase"
					? { client_secret: "fixture-dynamic-secret", token_endpoint_auth_method: "client_secret_basic" }
					: { token_endpoint_auth_method: "none" }) });
			}
			if (init?.method === "POST" && url === metadata.token_endpoint) {
				const params = init.body as URLSearchParams;
				expect(params.get("resource")).toBe(record.resource);
				const state = store.load()!;
				const method = state.clientInformation?.token_endpoint_auth_method;
				const headers = new Headers(init.headers);
				if (method === "none") {
					expect(headers.has("Authorization")).toBe(false);
					expect(params.get("client_secret")).toBeNull();
				} else expect(headers.has("Authorization") || params.has("client_secret")).toBe(true);
				if (params.get("grant_type") === "authorization_code") {
					exchanges++;
					expect(params.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
					expect(params.get("code_verifier")).toBe(state.authorizationContext?.codeVerifier);
				} else {
					refreshes++;
					expect(params.get("grant_type")).toBe("refresh_token");
					expect(params.get("refresh_token")).toBe("fixture-refresh-1");
				}
				return Response.json({ access_token: `fixture-access-${exchanges + refreshes}`, refresh_token: `fixture-refresh-${exchanges + refreshes}`, token_type: "Bearer", expires_in: 3600 });
			}
			return fixtureFetch(input);
		}));
		vi.stubEnv("PIZZA_MCP_OAUTH_CLIENT_METADATA_URL", "https://pizza.hertzbeat.com/oauth/client.json");
		await signInMcpServer({ serverUrl: record.url, store, settings, challenge, prompt: {
			showAuthorizationUrl: (url) => { authorization = url; },
			promptForRedirectUrl: async () => {
				const url = new URL(authorization.searchParams.get("redirect_uri")!);
				url.searchParams.set("state", authorization.searchParams.get("state")!);
				url.searchParams.set("code", "fixture-code");
				if (metadata.authorization_response_iss_parameter_supported) url.searchParams.set("iss", metadata.issuer);
				return url.href;
			},
		} });
		expect(exchanges).toBe(1);
		expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
		const cimd = metadata.client_id_metadata_document_supported && settings.clientRegistration !== "dcr" && !entry.oauthSetup;
		expect(store.load()?.credentialBinding?.registrationMethod).toBe(entry.oauthSetup ? "pre-registered" : cimd ? "cimd" : "dcr");
		expect(registrations).toBe(entry.oauthSetup || cimd ? 0 : 1);
		store.save({ ...store.load()!, tokensExpireAt: Date.now() - 1 });
		const auth = createMcpAuthProvider({ serverUrl: record.url, settings: () => settings, onChallenge: () => {},
			store: { load: () => store.load(), save: (state) => store.save(state), update: (fn) => store.update(fn), withRefreshLock: (fn) => fn() },
		});
		expect(await auth.token()).toBe("fixture-access-2");
		expect(refreshes).toBe(1);
		expect(store.load()?.tokens?.refresh_token).toBe("fixture-refresh-2");
		expect(store.load()?.codeVerifier).toBeUndefined();
	});

	it("never silently downgrades an unsupported registered method to public authentication", async () => {
		const fetch = vi.fn();
		await expect(refreshAuthorization("https://issuer.example", {
			clientInformation: { client_id: "client", token_endpoint_auth_method: "private_key_jwt" },
			metadata: { token_endpoint: "https://issuer.example/token", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"] } as AuthorizationServerMetadata,
			refreshToken: "fixture-refresh", fetch,
		})).rejects.toThrow("Unsupported registered OAuth client authentication method");
		expect(fetch).not.toHaveBeenCalled();
	});
});
