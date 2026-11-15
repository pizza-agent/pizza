import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { GoogleOAuthSession } from "../infra/mcp-oauth/worker.mjs";
import { googleBrokerMetadata } from "../infra/mcp-oauth/google-broker.mjs";
import { MCP_CONNECTOR_CATALOG, googleApiService, PIZZA_GOOGLE_BROKER_CLIENT_ID as client, PIZZA_GOOGLE_BROKER_ISSUER as issuer } from "../src/builtin-extensions/connectors/catalog.js";
import { createMcpAuthProvider, signInMcpServer, type McpOAuthSettings } from "../src/builtin-extensions/mcp/oauth.js";
import { resolveConnectorOAuth } from "../src/builtin-extensions/connectors/registry.js";
import { MemoryOAuthStateStore } from "../src/core/mcp/oauth/index.js";

const resource = "https://www.googleapis.com/drive/v3";
const scope = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
const target = "http://127.0.0.1:34567/callback";
const verifier = "v".repeat(43);
const digest = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("base64url");
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
	const objects = new Map<string, { storage: Map<string, unknown>; alarm?: number; instance: InstanceType<typeof GoogleOAuthSession> }>();
	const upstream = vi.fn(async (_url: unknown, init?: RequestInit) => {
		const p = init?.body as URLSearchParams;
		expect(p.get("client_id")).toBe("publisher.apps.googleusercontent.com");
		expect(p.get("client_secret")).toBe("publisher-secret");
		expect(p.has("resource")).toBe(false);
		if (p.get("grant_type") === "authorization_code") {
			expect(p.get("redirect_uri")).toBe(`${issuer}/callback`);
			expect(p.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		} else expect(p.get("refresh_token")).toBe("google-private-refresh");
		return Response.json({ access_token: `google-access-${upstream.mock.calls.length}`, refresh_token: "google-private-refresh", token_type: "Bearer", expires_in: 3600, scope, id_token: "must-not-reach-desktop" });
	});
	const env = { GOOGLE_CLIENT_ID: "publisher.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "publisher-secret", GOOGLE_TOKEN_KEY: "ab".repeat(32),
		GOOGLE_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
		GOOGLE_SESSIONS: { idFromName: (id: string) => id, get: (id: string) => ({ fetch: async (request: Request) => {
			if (!objects.has(id)) {
				const storage = new Map<string, unknown>();
				let queue = Promise.resolve();
				const ctx = { storage: { get: async (key: string) => structuredClone(storage.get(key)), put: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)); },
					deleteAll: async () => { storage.clear(); }, setAlarm: async (n: number) => { objects.get(id)!.alarm = n; } },
					blockConcurrencyWhile: (fn: () => Promise<Response>) => { const next = queue.then(fn); queue = next.then(() => undefined); return next; } };
				objects.set(id, { storage, instance: new GoogleOAuthSession(ctx, env) });
			}
			return objects.get(id)!.instance.fetch(request);
		} }) } };
	const request = (path: string | URL, init?: RequestInit) => Promise.resolve(worker.fetch(new Request(new URL(path, `${issuer}/`), init), env));
	vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
		if (String(url).startsWith(issuer)) return request(String(url), init);
		if (String(url) === "https://oauth2.googleapis.com/token") return upstream(url, init);
		if (String(url).includes("/.well-known/oauth-protected-resource")) return new Response(null, { status: 404 });
		throw new Error(`Unexpected outbound request: ${url}`);
	}));
	async function start(overrides: Record<string, string> = {}) {
		const p = new URLSearchParams({ client_id: client, response_type: "code", redirect_uri: target, state: "desktop-state-123456789", resource, scope,
			code_challenge_method: "S256", code_challenge: await digest(verifier), ...overrides });
		return request(`authorize?${p}`);
	}
	async function callback(started: Response, error?: string) {
		const auth = new URL(started.headers.get("location")!);
		const response = await request(`callback?${new URLSearchParams({ state: auth.searchParams.get("state")!, ...(error ? { error } : { code: "google-single-use-code" }) })}`,
			{ headers: { Cookie: started.headers.get("set-cookie")!.split(";")[0] } });
		return response;
	}
	async function token(code: string, overrides: Record<string, string> = {}) {
		return request("token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: client, resource,
			grant_type: "authorization_code", redirect_uri: target, code_verifier: verifier, code, ...overrides }) });
	}
	return { env, objects, upstream, request, start, callback, token };
}

describe("Hosted Google OAuth broker", () => {
	it("runs the real desktop OAuth engine through broker PKCE, local callback, persistent credentials and refresh", async () => {
		const f = fixture();
		const entry = MCP_CONNECTOR_CATALOG.find(e => e.name === "google-drive")!;
		const config = resolveConnectorOAuth({ name: "renamed-drive", source: "global", config: entry.config as never })!;
		const settings = { ...config, authServerMetadataUrl: new URL(config.authServerMetadataUrl!), resourceMetadataUrl: new URL(config.resourceMetadataUrl!) } as McpOAuthSettings;
		const store = new MemoryOAuthStateStore();
		let browser!: URL;
		await signInMcpServer({ serverUrl: resource, settings, store, prompt: {
			showAuthorizationUrl: (url) => { browser = url; },
			promptForRedirectUrl: async () => {
				const started = await f.request(browser);
				expect(started.status).toBe(302);
				expect(started.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
				const google = new URL(started.headers.get("location")!);
				expect(google.origin).toBe("https://accounts.google.com");
				expect(google.searchParams.get("access_type")).toBe("offline");
				expect(google.searchParams.get("prompt")).toBe("consent");
				expect(google.searchParams.has("client_secret")).toBe(false);
				const done = await f.callback(started);
				expect(done.status).toBe(302);
				expect(done.headers.get("location")).not.toMatch(/google-access|google-private-refresh|publisher-secret/);
				return done.headers.get("location")!;
			},
		} });
		expect(store.load()?.tokens).toMatchObject({ access_token: "google-access-1", token_type: "Bearer", scope });
		expect(store.load()?.tokens?.refresh_token).not.toBe("google-private-refresh");
		expect(JSON.stringify(store.load())).not.toMatch(/publisher-secret|google-private-refresh|must-not-reach-desktop/);
		expect(store.load()?.credentialBinding).toMatchObject({ issuer, clientId: client, resource, registrationMethod: "pre-registered" });
		const previous = store.load()!.tokens!.refresh_token!;
		store.save({ ...store.load()!, tokensExpireAt: Date.now() - 1 });
		const provider = createMcpAuthProvider({ serverUrl: resource, settings: () => settings, onChallenge: vi.fn(),
			store: { load: () => store.load(), save: s => store.save(s), update: fn => store.update(fn), withRefreshLock: fn => fn() } });
		expect(await provider.token()).toBe("google-access-2");
		expect(store.load()?.tokens?.refresh_token).not.toBe(previous);
		expect(f.upstream).toHaveBeenCalledTimes(2);
		for (const object of f.objects.values()) expect(JSON.stringify([...object.storage])).not.toMatch(/google-private-refresh|google-access|publisher-secret|drive\.readonly/);
	});
	it.each([
		{ redirect_uri: "https://attacker.example/callback" }, { redirect_uri: "http://127.0.0.1:8765/callback?token=1" },
		{ redirect_uri: "http://127.0.0.1.evil.example:8765/callback" }, { redirect_uri: "http://localhost:8765/callback" },
		{ resource: "https://attacker.example/mcp" }, { scope: "https://www.googleapis.com/auth/gmail.readonly" },
		{ scope: "" }, { code_challenge_method: "plain" }, { code_challenge: "short" }, { state: "short" }, { client_id: "foreign" },
	])("rejects unbound authorization input %j before creating a session", async overrides => {
		const f = fixture();
		expect((await f.start(overrides)).status).toBe(400);
		expect(f.objects.size).toBe(0);
		expect(f.upstream).not.toHaveBeenCalled();
	});
	it("requires the initiating browser cookie and consumes the upstream callback once", async () => {
		const f = fixture(), started = await f.start();
		const auth = new URL(started.headers.get("location")!);
		expect((await f.request(`callback?state=${auth.searchParams.get("state")}&code=stolen`)).status).toBe(400);
		expect(f.upstream).not.toHaveBeenCalled();
		expect((await f.callback(started)).status).toBe(302);
		expect((await f.callback(started)).status).toBe(400);
		expect(f.upstream).toHaveBeenCalledTimes(1);
	});
	it("binds redemption to PKCE, exact resource, callback and public client; never replays a code or refresh credential", async () => {
		const f = fixture(), done = await f.callback(await f.start());
		const code = new URL(done.headers.get("location")!).searchParams.get("code")!;
		for (const changed of [{ code_verifier: "wrong".repeat(10) }, { resource: "https://gmailmcp.googleapis.com/mcp/v1" }, { redirect_uri: "http://127.0.0.1:34568/callback" }, { client_id: "other-client" }]) {
			expect((await f.token(code, changed)).status).toBe(400);
		}
		const first = await f.token(code);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		expect((await f.token(code)).status).toBe(400);
		const tokens = await first.json();
		const refresh = () => f.token("", { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
		const results = await Promise.all([refresh(), refresh()]);
		expect(results.map(r => r.status).sort()).toEqual([200, 400]);
		expect(f.upstream).toHaveBeenCalledTimes(2);
	});
	it("expires abandoned logins and ready authorization codes, and cleans stored sessions with an alarm", async () => {
		const f = fixture(), started = await f.start();
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now + 601_000);
		expect((await f.callback(started)).status).toBe(400);
		clock.mockRestore();
		const done = await f.callback(await f.start());
		const code = new URL(done.headers.get("location")!).searchParams.get("code")!;
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
		expect((await f.token(code)).status).toBe(400);
		for (const object of f.objects.values()) { await object.instance.alarm(); expect(object.storage.size).toBe(0); }
	});
	it("returns a bound denial without exchanging Google tokens", async () => {
		const f = fixture(), denied = await f.callback(await f.start(), "access_denied");
		const url = new URL(denied.headers.get("location")!);
		expect(url.origin).toBe(new URL(target).origin);
		expect(url.searchParams.get("state")).toBe("desktop-state-123456789");
		expect(url.searchParams.get("iss")).toBe(issuer);
		expect(url.searchParams.get("error")).toBe("access_denied");
		expect(f.upstream).not.toHaveBeenCalled();
	});
	it("rejects partial Google consent and never exposes upstream error text", async () => {
		const f = fixture();
		f.upstream.mockImplementationOnce(async () => Response.json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600, scope: scope.split(" ")[0] }));
		expect((await f.callback(await f.start())).status).toBe(400);
		f.upstream.mockImplementationOnce(async () => Response.json({ error: "invalid_client", error_description: "secret diagnostic" }, { status: 400 }));
		const failed = await f.callback(await f.start());
		expect(failed.status).toBe(503);
		expect(await failed.text()).not.toContain("secret diagnostic");
	});
	it("fails closed before publisher setup and applies rate limits without logging tokens", async () => {
		const f = fixture();
		const metadata = await worker.fetch(new Request(`${issuer}/.well-known/oauth-authorization-server`));
		expect(await metadata.json()).toEqual(googleBrokerMetadata());
		expect((await worker.fetch(new Request(`${issuer}/health`))).status).toBe(503);
		const landing = await worker.fetch(new Request(`${issuer}/callback`));
		expect(landing.status).toBe(200);
		expect(await landing.text()).toContain("Start sign-in from Pizza");
		expect((await worker.fetch(new Request(`${issuer}/authorize`))).status).toBe(503);
		f.env.GOOGLE_RATE_LIMITER.limit.mockResolvedValue({ success: false });
		expect((await f.start()).status).toBe(429);
		expect(f.objects.size).toBe(0);
	});
	it.each(MCP_CONNECTOR_CATALOG.filter(entry => googleApiService(entry.config)))("reports publisher setup for $name before opening a browser or changing credentials", async entry => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ configured: false }, { status: 503 })));
		const prompt = { showAuthorizationUrl: vi.fn(), promptForRedirectUrl: vi.fn() };
		const store = new MemoryOAuthStateStore();
		await expect(signInMcpServer({ serverUrl: String(entry.config.url), store, settings: entry.config.oauth as McpOAuthSettings, prompt })).rejects.toThrow("awaiting publisher setup");
		expect(prompt.showAuthorizationUrl).not.toHaveBeenCalled();
		expect(store.load()).toBeUndefined();
	});
	it("bounds token bodies and rejects duplicate authorization parameters", async () => {
		const f = fixture();
		expect((await f.request("token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x=" + "a".repeat(16_385) })).status).toBe(400);
		const started = await f.start();
		const upstream = new URL(started.headers.get("location")!);
		expect((await f.request(`callback?state=${upstream.searchParams.get("state")}&state=duplicate`)).status).toBe(400);
	});
	it("upgrades old unconfigured Workspace entries while preserving existing private client registrations", () => {
		const config = { url: "https://drivemcp.googleapis.com/mcp/v1", oauth: { authServerMetadataUrl: "https://accounts.google.com/.well-known/openid-configuration", scope } };
		expect(resolveConnectorOAuth({ name: "my-drive", source: "global", config })).toMatchObject({ clientId: client, resourceIndicator: true, authServerMetadataUrl: `${issuer}/.well-known/oauth-authorization-server`, scope });
		const privateConfig = { ...config, oauth: { ...config.oauth, clientId: "own.apps.googleusercontent.com", clientSecret: "own-secret" } };
		expect(resolveConnectorOAuth({ name: "my-drive", source: "global", config: privateConfig })).toMatchObject(privateConfig.oauth);
	});
});
