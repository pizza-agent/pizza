import { createHash } from "node:crypto";
import { get } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	authorizeMcp, createNativeClientMetadata, discoverAuthorizationServerMetadata, discoverOAuthServerInfo,
	McpOAuthProvider, MemoryOAuthStateStore, OAuthCallbackServer, oauthCallbackId,
	parseWwwAuthenticate,
	type AuthorizationServerMetadata,
} from "../src/core/mcp/oauth/index.js";
import {
	createMcpAuthProvider, McpOAuthCredentialStore, PIZZA_MCP_OAUTH_CLIENT_METADATA_URL, signInMcpServer, type McpOAuthSettings,
} from "../src/builtin-extensions/mcp/oauth.js";
import { FileAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import { validateMcpServerConfig } from "../src/core/mcp/servers.js";
import { createMetadataServer } from "../infra/mcp-oauth/server.mjs";
import { parseOAuthTokens } from "../src/core/mcp/oauth/types.js";

const serverUrl = "https://tools.example/mcp";
const metadataUrl = PIZZA_MCP_OAUTH_CLIENT_METADATA_URL;

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function fixture() {
	const metadata: AuthorizationServerMetadata = {
		issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize",
		token_endpoint: "https://auth.example/token", registration_endpoint: "https://auth.example/register",
		response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: true,
		authorization_response_iss_parameter_supported: true,
	};
	const registration: Record<string, unknown>[] = [];
	const tokens: { url: string; params: URLSearchParams }[] = [];
	const api = {
		metadata, registration, tokens, metadataStatus: 200, metadataIdentity: "Pizza", tokenError: "", resource: serverUrl,
		fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.origin === new URL(metadataUrl).origin) {
				if (api.metadataStatus !== 200) return new Response("", { status: api.metadataStatus });
				const id = /\/([A-Za-z0-9_-]{12})\/client\.json$/.exec(url.pathname)?.[1];
				return Response.json({ ...createNativeClientMetadata(metadataUrl, id), client_name: api.metadataIdentity });
			}
			if (url.pathname.includes("oauth-protected-resource")) {
				return Response.json({ resource: api.resource, authorization_servers: [metadata.issuer], scopes_supported: ["tools.read"] });
			}
			if (url.pathname.includes("oauth-authorization-server")) return Response.json(metadata);
			if (url.pathname === "/register") {
				const body = JSON.parse(String(init?.body));
				registration.push(body);
				return Response.json({ ...body, client_id: `dynamic-${registration.length}` });
			}
			if (url.pathname.startsWith("/token")) {
				const params = new URLSearchParams(init?.body as URLSearchParams);
				tokens.push({ url: url.href, params });
				if (api.tokenError) return Response.json({ error: api.tokenError }, { status: 400 });
				return Response.json({ access_token: `access-${tokens.length}`, refresh_token: `refresh-${tokens.length}`, token_type: "Bearer", expires_in: 3600 });
			}
			return new Response("", { status: 404 });
		}),
	};
	vi.stubEnv("PIZZA_MCP_OAUTH_CLIENT_METADATA_URL", metadataUrl);
	vi.stubGlobal("fetch", api.fetch);
	return api;
}

async function productLogin(api: ReturnType<typeof fixture>, settings: McpOAuthSettings = {}, store = new MemoryOAuthStateStore()) {
	let authorization!: URL;
	await signInMcpServer({ serverUrl, store, settings, prompt: {
		showAuthorizationUrl: (url) => { authorization = url; },
		promptForRedirectUrl: async () => {
			const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
			redirect.searchParams.set("state", authorization.searchParams.get("state")!);
			redirect.searchParams.set("code", "code-one");
			if (api.metadata.authorization_response_iss_parameter_supported) redirect.searchParams.set("iss", api.metadata.issuer);
			return redirect.href;
		},
	} });
	return { authorization, store };
}

function coreClient(store = new MemoryOAuthStateStore(), clientId = "registered-client") {
	let authorization!: URL;
	const provider = new McpOAuthProvider({ serverUrl, store, clientId,
		redirectUrl: "http://127.0.0.1:12345/callback", clientMetadata: { client_name: "Pizza" },
		onRedirect: (url) => { authorization = url; },
	});
	return { provider, store, authorization: () => authorization };
}

async function begin(client: ReturnType<typeof coreClient>) {
	expect(await authorizeMcp(client.provider, { serverUrl })).toBe("REDIRECT");
	return client.authorization().searchParams.get("state")!;
}

async function finish(client: ReturnType<typeof coreClient>, state: string, iss: string | undefined = "https://auth.example") {
	return authorizeMcp(client.provider, { serverUrl, authorizationCode: "code-one", authorizationState: state, iss });
}

describe("Pizza CIMD registration", () => {
	it.each([true, false])("automatically uses Pizza's metadata and a matching callback (issuer identification=%s)", async (issuerIdentification) => {
		const api = fixture(); api.metadata.authorization_response_iss_parameter_supported = issuerIdentification;
		const { authorization, store } = await productLogin(api);
		const id = issuerIdentification ? undefined : oauthCallbackId(serverUrl);
		const expected = createNativeClientMetadata(metadataUrl, id);
		expect(authorization.searchParams.get("client_id")).toBe(expected.client_id);
		expect(new URL(authorization.searchParams.get("redirect_uri")!).pathname).toBe(`/callback${id ? `/${id}` : ""}`);
		expect(api.registration).toHaveLength(0);
		expect(api.tokens[0].params.get("resource")).toBe(serverUrl);
		expect(api.tokens[0].params.has("client_secret")).toBe(false);
		expect(createHash("sha256").update(api.tokens[0].params.get("code_verifier")!).digest("base64url"))
			.toBe(authorization.searchParams.get("code_challenge"));
		expect(store.load()?.credentialBinding).toMatchObject({ issuer: api.metadata.issuer, clientId: expected.client_id, resource: serverUrl, registrationMethod: "cimd" });
		expect(store.load()?.authorizationContext).toBeUndefined();
		expect(store.load()?.tokens?.access_token).toBe("access-1");
	});

	it.each(["unsupported", "unpublished", "custom callback", "forced DCR"])("falls back to DCR when %s", async (reason) => {
		const api = fixture();
		const settings: McpOAuthSettings = {};
		if (reason === "unsupported") api.metadata.client_id_metadata_document_supported = false;
		if (reason === "unpublished") api.metadataStatus = 404;
		if (reason === "custom callback") settings.callbackUrl = "http://127.0.0.1/custom";
		if (reason === "forced DCR") settings.clientRegistration = "dcr";
		const { authorization } = await productLogin(api, settings);
		expect(authorization.searchParams.get("client_id")).toBe("dynamic-1");
		expect(api.registration).toHaveLength(1);
		expect(api.registration[0]).toMatchObject({ application_type: "native", token_endpoint_auth_method: "none" });
	});

	it("uses a pre-registered client before CIMD, including an explicit CIMD preference", async () => {
		const api = fixture();
		const { authorization } = await productLogin(api, { clientId: "company-client", clientRegistration: "cimd" });
		expect(authorization.searchParams.get("client_id")).toBe("company-client");
		expect(api.registration).toHaveLength(0);
		expect(api.fetch.mock.calls.some(([url]) => String(url).startsWith(metadataUrl))).toBe(false);
	});

	it("requires a published metadata document when CIMD is forced", async () => {
		const api = fixture(); api.metadataStatus = 404;
		await expect(productLogin(api, { clientRegistration: "cimd" })).rejects.toThrow("HTTP 404");
		expect(api.registration).toHaveLength(0); expect(api.tokens).toHaveLength(0);
	});

	it("refuses a metadata document claiming another application's identity", async () => {
		const api = fixture(); api.metadataIdentity = "pi";
		await expect(productLogin(api)).rejects.toThrow("Invalid Pizza CIMD document");
		expect(api.registration).toHaveLength(0); expect(api.tokens).toHaveLength(0);
	});

	it("persists a CIMD registration for refresh across process restarts", async () => {
		const api = fixture();
		const { store } = await productLogin(api);
		store.save({ ...store.load()!, tokensExpireAt: Date.now() - 1 });
		const provider = createMcpAuthProvider({ serverUrl,
			store: { load: () => store.load(), save: (state) => store.save(state), withRefreshLock: (fn) => fn() },
			settings: () => ({}), onChallenge: () => {},
		});
		expect(await provider.token()).toBe("access-2");
		expect(api.tokens[1].params.get("client_id")).toBe(metadataUrl);
		expect(api.tokens[1].params.get("refresh_token")).toBe("refresh-1");
		expect(store.load()?.tokens?.refresh_token).toBe("refresh-2");
		expect(api.registration).toHaveLength(0);
	});

	it("honors forced DCR after an existing CIMD login", async () => {
		const api = fixture();
		const { store } = await productLogin(api);
		const { authorization } = await productLogin(api, { clientRegistration: "dcr" }, store);
		expect(authorization.searchParams.get("client_id")).toBe("dynamic-1");
		expect(store.load()?.credentialBinding?.registrationMethod).toBe("dcr");
		expect(api.tokens[1].params.get("grant_type")).toBe("authorization_code");
	});

	it("gives a configuration error if the provider offers neither registration method", async () => {
		const api = fixture(); api.metadata.client_id_metadata_document_supported = false;
		delete api.metadata.registration_endpoint;
		await expect(productLogin(api)).rejects.toThrow("Set oauth.clientId");
		expect(api.tokens).toHaveLength(0);
	});
});

describe("OAuth credential and authorization binding", () => {
	it.each(["issuer", "client", "resource"])("never refreshes credentials after a %s change", async (change) => {
		const api = fixture(); const client = coreClient();
		await finish(client, await begin(client));
		if (change === "issuer") api.metadata.issuer = "https://other.example";
		if (change === "resource") api.resource = "https://tools.example";
		const next = coreClient(client.store, change === "client" ? "other-client" : "registered-client");
		await expect(authorizeMcp(next.provider, { serverUrl, allowInteraction: false })).rejects.toThrow("requires user interaction");
		expect(api.tokens).toHaveLength(1);
		if (change === "client") expect(await next.provider.tokens()).toBeUndefined();
	});

	it("requires a fresh login for legacy tokens without an issuer binding", async () => {
		const api = fixture(); const client = coreClient();
		client.store.save({ serverUrl, tokens: { access_token: "legacy", refresh_token: "legacy-refresh", token_type: "Bearer" } });
		expect(await client.provider.tokens()).toBeUndefined();
		await expect(authorizeMcp(client.provider, { serverUrl, allowInteraction: false })).rejects.toThrow("requires user interaction");
		expect(api.tokens).toHaveLength(0);
		await finish(client, await begin(client));
		expect(client.store.load()?.tokens?.access_token).toBe("access-1");
	});

	it("redeems a code against the original metadata snapshot even if discovery changes", async () => {
		const api = fixture(); const client = coreClient(); const state = await begin(client);
		api.metadata.issuer = "https://changed.example";
		api.metadata.token_endpoint = "https://changed.example/token-new";
		expect(await finish(client, state)).toBe("AUTHORIZED");
		expect(api.tokens.map((request) => request.url)).toEqual(["https://auth.example/token"]);
		await expect(finish(client, state)).rejects.toThrow("requires user interaction");
		expect(api.tokens).toHaveLength(1);
	});

	it.each(["wrong-state", "wrong-issuer", "missing-issuer"])("rejects %s before sending the code", async (reason) => {
		const api = fixture(); const client = coreClient(); const state = await begin(client);
		await expect(authorizeMcp(client.provider, { serverUrl, authorizationCode: "one-use-code",
			authorizationState: reason === "wrong-state" ? "another-attempt" : state,
			iss: reason === "missing-issuer" ? undefined : reason === "wrong-issuer" ? "https://other.example" : api.metadata.issuer,
		})).rejects.toThrow();
		expect(api.tokens).toHaveLength(0);
	});

	it("does not retry a single-use authorization code on invalid_grant", async () => {
		const api = fixture(); const client = coreClient(); const state = await begin(client);
		api.tokenError = "invalid_grant";
		await expect(finish(client, state)).rejects.toThrow("invalid_grant");
		expect(api.tokens).toHaveLength(1);
	});

	it("does not start registration or a browser after background refresh is rejected", async () => {
		const api = fixture(); const client = coreClient();
		await finish(client, await begin(client)); api.tokenError = "invalid_grant";
		await expect(authorizeMcp(client.provider, { serverUrl, allowInteraction: false })).rejects.toThrow("requires user interaction");
		expect(api.tokens).toHaveLength(2); expect(api.registration).toHaveLength(0);
		expect(client.store.load()?.tokens).toBeUndefined();
	});

	it("adopts a winning refresh from another credential-store instance after acquiring the shared lock", async () => {
		const api = fixture();
		const { store } = await productLogin(api);
		const dir = mkdtempSync(join(tmpdir(), "pizza-cimd-refresh-"));
		const file = join(dir, "mcp-auth.json");
		const first = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), dir).forServer("tools", serverUrl);
		const second = new McpOAuthCredentialStore(new FileAuthStorageBackend(file), dir).forServer("tools", serverUrl);
		await first.save({ ...store.load()!, tokensExpireAt: Date.now() - 1 });
		let entered!: () => void, attempted!: () => void, release!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const contended = new Promise<void>((resolve) => { attempted = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const fetch = api.fetch.getMockImplementation()!;
		api.fetch.mockImplementation(async (input, init) => {
			if (new URL(String(input)).pathname === "/token") { entered(); await gate; }
			return fetch(input, init);
		});
		const one = createMcpAuthProvider({ serverUrl, store: first, settings: () => ({}), onChallenge: () => {} });
		const two = createMcpAuthProvider({ serverUrl, store: { ...second, withRefreshLock: (fn) => {
			attempted(); return second.withRefreshLock(fn);
		} }, settings: () => ({}), onChallenge: () => {} });
		let pending: Promise<unknown> | undefined;
		try {
			const a = one.token();
			await started;
			const b = two.token();
			pending = Promise.all([a, b]);
			await contended;
			release();
			expect(await pending).toEqual(["access-2", "access-2"]);
			expect(api.tokens).toHaveLength(2); // One code exchange, one refresh.
			expect((await second.load())?.tokens?.refresh_token).toBe("refresh-2");
		} finally {
			release(); await pending?.catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([true, false])("validates an error response's issuer before displaying provider text (advertised=%s)", async (required) => {
		const callback = await OAuthCallbackServer.listen({ timeoutMs: 1000 });
		try {
			const outcome = callback.waitForCallback("attempt", "/callback", { expected: "https://auth.example", required })
				.then(() => undefined, (error: Error) => error);
			const url = new URL(callback.redirectUrl);
			url.search = new URLSearchParams({ state: "attempt", iss: "https://wrong.example", error: "access_denied", error_description: "untrusted provider text" }).toString();
			const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
				get(url, (response) => {
					let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; });
					response.on("end", () => resolve({ status: response.statusCode!, body }));
				}).on("error", reject);
			});
			expect(result.status).toBe(400);
			expect(result.body).not.toContain("untrusted provider text");
			expect((await outcome)?.name).toBe("OAuthIssuerMismatchError");
		} finally { await callback.close(); }
	});
});

describe("OAuth discovery and capability validation", () => {
	it.each([401, 429, 500, 502])("does not downgrade discovery after HTTP %s", async (status) => {
		const fetch = vi.fn(async () => new Response("", { status }));
		await expect(discoverOAuthServerInfo(serverUrl, { fetch })).rejects.toThrow(`HTTP ${status}`);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not downgrade a malformed resource metadata document", async () => {
		const fetch = vi.fn(async () => new Response("{broken", { headers: { "content-type": "application/json" } }));
		await expect(discoverOAuthServerInfo(serverUrl, { fetch })).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("compares metadata issuers exactly, including trailing slashes", async () => {
		const api = fixture(); api.metadata.issuer += "/";
		await expect(discoverAuthorizationServerMetadata("https://auth.example")).rejects.toThrow("issuer mismatch");
	});

	it.each([undefined, ["plain"]])("rejects unverified S256 support: %s", async (methods) => {
		const api = fixture(); api.metadata.code_challenge_methods_supported = methods;
		await expect(productLogin(api, { clientRegistration: "dcr" })).rejects.toThrow("PKCE S256");
		expect(api.registration).toHaveLength(0); expect(api.tokens).toHaveLength(0);
	});

	it("validates the new registration settings and rejects insecure metadata URLs", () => {
		expect(validateMcpServerConfig("tools", { url: serverUrl, oauth: { clientRegistration: "auto", clientMetadataUrl: metadataUrl } }))
			.toMatchObject({ oauth: { clientRegistration: "auto" } });
		for (const url of ["http://pizza.hertzbeat.com/oauth/client.json", "https://u:p@pizza.hertzbeat.com/oauth/client.json", `${metadataUrl}?x=1`, `${metadataUrl}#x`]) {
			expect(validateMcpServerConfig("tools", { url: serverUrl, oauth: { clientMetadataUrl: url } })).toContain("clientMetadataUrl");
		}
	});
});

describe("deployable public metadata service", () => {
	it("serves the shared and server-specific identities without trusting the Host header", async () => {
		const server = createMetadataServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		const request = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
			get({ hostname: "127.0.0.1", port, path, headers: { Host: "attacker.example" } }, (response) => {
				let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; });
				response.on("end", () => resolve({ status: response.statusCode!, body }));
			}).on("error", reject);
		});
		try {
			const id = oauthCallbackId(serverUrl);
			for (const callbackId of [undefined, id]) {
				const expected = createNativeClientMetadata(metadataUrl, callbackId);
				const result = await request(new URL(expected.client_id).pathname);
				expect(result.status).toBe(200); expect(JSON.parse(result.body)).toEqual(expected);
			}
			expect((await request("/oauth/invalid/client.json")).status).toBe(404);
			expect((await request("/oauth/client.json?secret=anything")).status).toBe(404);
			expect(JSON.parse(readFileSync(new URL("../infra/mcp-oauth/client.json", import.meta.url), "utf8")))
				.toEqual(createNativeClientMetadata(metadataUrl));
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("OAuth authorization races", () => {
	function delayedToken(api: ReturnType<typeof fixture>, error = false) {
		let entered!: () => void, release!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const fetch = api.fetch.getMockImplementation()!;
		let held = false;
		api.fetch.mockImplementation(async (input, init) => {
			if (!held && new URL(String(input)).pathname === "/token") {
				held = true;
				const response = error ? Response.json({ error: "invalid_grant" }, { status: 400 }) : await fetch(input, init);
				entered(); await gate; return response;
			}
			return fetch(input, init);
		});
		return { started, release };
	}

	it.each([false, true])("cannot overwrite or invalidate a newer login when an older token response arrives (error=%s)", async (error) => {
		const api = fixture(), store = new MemoryOAuthStateStore(), delayed = delayedToken(api, error);
		const old = productLogin(api, {}, store).then(() => undefined, (value: Error) => value);
		await delayed.started;
		try {
			await productLogin(api, {}, store);
			const latest = store.load();
			delayed.release();
			expect((await old)?.name).toBe("McpOAuthAuthorizationRequiredError");
			expect(store.load()).toEqual(latest);
			expect(latest?.tokens?.access_token).toBeDefined();
		} finally { delayed.release(); await old; }
	});

	it("does not restore credentials after signing out during code exchange", async () => {
		const api = fixture(), store = new MemoryOAuthStateStore(), delayed = delayedToken(api);
		const login = productLogin(api, {}, store).then(() => undefined, (value: Error) => value);
		await delayed.started;
		store.update(() => undefined); delayed.release();
		expect((await login)?.name).toBe("McpOAuthAuthorizationRequiredError");
		expect(store.load()).toBeUndefined();
	});

	it("does not restore credentials after signing out during refresh", async () => {
		const api = fixture(), { store } = await productLogin(api);
		store.save({ ...store.load()!, tokensExpireAt: Date.now() - 1 });
		const delayed = delayedToken(api);
		const provider = createMcpAuthProvider({ serverUrl, store: {
			load: () => store.load(), save: (state) => store.save(state), update: (update) => store.update(update), withRefreshLock: (fn) => fn(),
		}, settings: () => ({}), onChallenge: () => {} });
		const refresh = provider.token().then(() => undefined, (value: Error) => value);
		await delayed.started; store.update(() => undefined); delayed.release();
		expect((await refresh)?.name).toBe("McpOAuthAuthorizationRequiredError");
		expect(store.load()).toBeUndefined();
	});

	it("does not restore credentials after signing out during device polling", async () => {
		const api = fixture(), store = new MemoryOAuthStateStore();
		const fetch = api.fetch.getMockImplementation()!;
		api.fetch.mockImplementation(async (input, init) => new URL(String(input)).pathname === "/device"
			? Response.json({ device_code: "test-device", user_code: "TEST-CODE", verification_uri: "https://auth.example/verify", expires_in: 60, interval: 0.001 })
			: fetch(input, init));
		const delayed = delayedToken(api);
		const login = signInMcpServer({ serverUrl, store, settings: { clientId: "device-client", deviceAuthorizationUrl: "https://auth.example/device", authorizationServerMetadata: api.metadata },
			prompt: { showAuthorizationUrl: () => {}, showDeviceCode: () => {}, promptForRedirectUrl: () => new Promise(() => {}) },
		}).then(() => undefined, (value: Error) => value);
		await delayed.started; store.update(() => undefined); delayed.release();
		expect((await login)?.name).toBe("McpOAuthAuthorizationRequiredError");
		expect(store.load()).toBeUndefined();
	});

	it("uses distinct nonces for simultaneous authorizations of the same client", async () => {
		fixture(); const first = coreClient();
		const a = await begin(first), second = coreClient(first.store), b = await begin(second);
		expect(a).not.toBe(b);
		await expect(finish(first, a)).rejects.toThrow("requires user interaction");
		expect(await finish(second, b)).toBe("AUTHORIZED");
	});

	it("uses a fresh nonce when the same provider re-authenticates after success", async () => {
		fixture(); const client = coreClient(), first = await begin(client);
		await finish(client, first);
		await authorizeMcp(client.provider, { serverUrl, skipRefresh: true });
		expect(client.store.load()?.authorizationContext?.state).not.toBe(first);
	});

	it("preserves a pending browser authorization when background refresh succeeds", async () => {
		fixture(); const client = coreClient();
		await finish(client, await begin(client));
		await authorizeMcp(client.provider, { serverUrl, skipRefresh: true });
		const pending = client.store.load()?.authorizationContext;
		await authorizeMcp(coreClient(client.store).provider, { serverUrl, allowInteraction: false });
		expect(client.store.load()?.authorizationContext).toEqual(pending);
		expect(await finish(client, pending!.state!)).toBe("AUTHORIZED");
	});

	it("does not lose independent state updates from separate provider instances", async () => {
		const store = new MemoryOAuthStateStore(), one = coreClient(store), two = coreClient(store);
		await Promise.all([
			one.provider.saveClientInformation({ client_id: "ignored-for-configured-client" }),
			one.provider.saveCredentialBinding({ issuer: "https://auth.example", clientId: "registered-client", resource: serverUrl }),
			two.provider.saveCodeVerifier("pending-proof"),
		]);
		expect(store.load()).toMatchObject({ codeVerifier: "pending-proof", credentialBinding: { clientId: "registered-client" } });
	});
});

describe("OAuth wire protocol validation", () => {
	it("parses bearer challenges after other schemes and does not treat quoted text as parameters", () => {
		const challenge = parseWwwAuthenticate('Basic realm="first", Bearer error_description="scope=admin, say \\"ok\\"", scope="tools.read tools.write", resource_metadata="https://auth.example/metadata"');
		expect(challenge.scope).toBe("tools.read tools.write");
		expect(challenge.errorDescription).toBe('scope=admin, say "ok"');
		expect(challenge.resourceMetadataUrl?.href).toBe("https://auth.example/metadata");
	});

	it.each(['Bearer scope="one", scope="two"', 'Bearer resource_metadata="not a URL"', 'Bearer scope="unclosed'])("rejects an ambiguous or invalid challenge: %s", (header) => {
		expect(() => parseWwwAuthenticate(header)).toThrow();
	});

	it.each(["DPoP", "Basic", "unknown"])("does not misrepresent a %s token as a bearer credential", (token_type) => {
		expect(() => parseOAuthTokens({ access_token: "value", token_type })).toThrow("Unsupported OAuth token type");
	});

	it.each([-1, "-100", Infinity, "NaN"])("rejects invalid token lifetimes: %s", (expires_in) => {
		expect(() => parseOAuthTokens({ access_token: "value", token_type: "Bearer", expires_in })).toThrow("Invalid expires_in");
	});

	it("form-encodes client identifiers and secrets before HTTP Basic authentication", async () => {
		const api = fixture(); api.metadata.token_endpoint_auth_methods_supported = ["client_secret_basic"];
		const provider = new McpOAuthProvider({ serverUrl, clientId: "client:id +", clientSecret: "sec:ret/+%",
			redirectUrl: "http://127.0.0.1:12345/callback", clientMetadata: {}, onRedirect: () => {},
		});
		await authorizeMcp(provider, { serverUrl });
		await authorizeMcp(provider, { serverUrl, authorizationCode: "code", authorizationState: (await provider.authorizationContext())?.state, iss: api.metadata.issuer });
		const request = api.fetch.mock.calls.find(([input]) => String(input).endsWith("/token"))!;
		const encoded = new Headers(request[1]?.headers).get("Authorization")!.slice("Basic ".length);
		expect(Buffer.from(encoded, "base64").toString()).toBe("client%3Aid+%2B:sec%3Aret%2F%2B%25");
	});
});
