import { LEGACY_GOOGLE_WORKSPACE_CONNECTORS } from "../../src/builtin-extensions/connectors/catalog.ts";
import { GOOGLE_API_SERVICES, PIZZA_GOOGLE_BROKER_CLIENT_ID, PIZZA_GOOGLE_BROKER_ISSUER } from "../../src/builtin-extensions/connectors/google-services.ts";

const ISSUER = PIZZA_GOOGLE_BROKER_ISSUER;
const CALLBACK = `${ISSUER}/callback`;
const CLIENT = PIZZA_GOOGLE_BROKER_CLIENT_ID;
const ID = /^[A-Za-z0-9_-]{43}$/;
const HANDLE = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const TEN_MINUTES = 600_000;
const GRANT_IDLE = 180 * 24 * 60 * 60_000;
const encoder = new TextEncoder();
const resources = new Map([
	...GOOGLE_API_SERVICES.map(service => [service.resource, service.scopes]),
	...LEGACY_GOOGLE_WORKSPACE_CONNECTORS.map(entry => [String(entry.config.url), String(entry.config.oauth.scope).split(/\s+/)]),
]);
const headers = { "Cache-Control": "no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };
const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
const redirect = (url, cookie) => new Response(null, { status: 302, headers: { ...headers, Location: String(url), ...(cookie ? { "Set-Cookie": cookie } : {}) } });
class BrokerError extends Error {
	constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const invalid = (message = "Invalid OAuth request") => { throw new BrokerError("invalid_request", message); };
const invalidGrant = () => { throw new BrokerError("invalid_grant", "Authorization expired or no longer valid. Sign in again."); };
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64 = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const hash = async (text) => b64(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
function one(params, key) {
	if (params.getAll(key).length > 1) invalid(`Duplicate ${key}`);
	return params.get(key);
}
function cookieName(id) { return `__Host-pizza-google-${id}`; }
function cookie(id, value, age = 600) { return `${cookieName(id)}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`; }
function ready(env) {
	return !!env?.GOOGLE_CLIENT_ID?.endsWith(".apps.googleusercontent.com") && !!env.GOOGLE_CLIENT_SECRET && /^[a-f0-9]{64}$/i.test(env.GOOGLE_TOKEN_KEY ?? "") && !!env.GOOGLE_SESSIONS && !!env.GOOGLE_RATE_LIMITER;
}
export function googleBrokerMetadata() {
	return { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
		response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
		authorization_response_iss_parameter_supported: true };
}
function client(params) {
	if (one(params, "client_id") !== CLIENT || params.has("client_secret")) throw new BrokerError("invalid_client", "Use Pizza's public desktop client.");
}
function callbackUrl(value) {
	let url;
	try { url = new URL(value); } catch { invalid("Invalid desktop callback"); }
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash ||
		!/^\/callback(?:\/[A-Za-z0-9_-]{12})?$/.test(url.pathname)) invalid("Only Pizza's explicit-port 127.0.0.1 callback is allowed.");
	return url.href;
}
function requestedScopes(resource, scope) {
	const allowed = resources.get(resource);
	const scopes = scope?.split(/\s+/).filter(Boolean);
	if (!allowed || !scopes?.length || scopes.some(item => !allowed.includes(item))) throw new BrokerError("invalid_scope", "Select a supported Google Workspace product and its permissions.");
	return [...new Set(scopes)].join(" ");
}
async function form(request) {
	if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) invalid("Expected a form-encoded OAuth request.");
	const reader = request.body?.getReader();
	if (!reader) invalid();
	let size = 0, body = "";
	const decoder = new TextDecoder();
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 16_384) { await reader.cancel(); invalid("Request too large"); }
		body += decoder.decode(value, { stream: true });
	}
	return new URLSearchParams(body + decoder.decode());
}
function stub(env, id) { return env.GOOGLE_SESSIONS.get(env.GOOGLE_SESSIONS.idFromName(id)); }
function internal(path, value) { return new Request(`https://session.internal/${path}`, { method: "POST", body: JSON.stringify(value), redirect: "manual" }); }
function safeError(error) {
	return error instanceof BrokerError ? json({ error: error.code, error_description: error.message }, error.status) : json({ error: "server_error", error_description: "Google sign-in is temporarily unavailable. Please try again." }, 503);
}

/** Public router; only canonical HTTPS, known resources, strict callbacks and fixed upstream endpoints. */
export async function googleBrokerResponse(request, env) {
	try {
		const url = new URL(request.url);
		if (url.origin !== new URL(ISSUER).origin) return json({ error: "invalid_request" }, 400);
		if (url.search.length > 16_384) invalid("Request too large");
		if (request.method === "GET" && !url.search && url.pathname.startsWith(`${new URL(ISSUER).pathname}/resources/`)) {
			const product = url.pathname.slice(`${new URL(ISSUER).pathname}/resources/`.length);
			const service = GOOGLE_API_SERVICES.find(service => service.product === product);
			return service ? json({ resource: service.resource, authorization_servers: [ISSUER], scopes_supported: service.scopes, bearer_methods_supported: ["header"] }) : json({ error: "invalid_request" }, 404);
		}
		if (request.method === "GET" && url.href === CALLBACK) {
			return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pizza · Google 登录</title><h1>Pizza · Google 登录</h1><p>这是 Google 登录回调地址。请返回 Pizza，选择要连接的 Google 服务并点击登录。</p><p>This address receives Google sign-in results. Start sign-in from Pizza.</p></html>', { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
		}
		if (request.method === "GET" && url.pathname === `${new URL(ISSUER).pathname}/.well-known/oauth-authorization-server` && !url.search) return json(googleBrokerMetadata());
		if (request.method === "GET" && url.pathname === `${new URL(ISSUER).pathname}/health` && !url.search) return json({ configured: ready(env), callback: CALLBACK }, ready(env) ? 200 : 503);
		const route = url.pathname.slice(new URL(ISSUER).pathname.length);
		if (![["/authorize", "GET"], ["/callback", "GET"], ["/token", "POST"]].some(([path, method]) => route === path && request.method === method)) return json({ error: "invalid_request" }, 404);
		if (!ready(env)) throw new BrokerError("temporarily_unavailable", "Pizza's Google connection is awaiting publisher setup. No client secret is needed on your device.", 503);
		const limited = await env.GOOGLE_RATE_LIMITER.limit({ key: `google:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
		if (!limited.success) return json({ error: "temporarily_unavailable", error_description: "Too many sign-in requests. Try again shortly." }, 429, { "Retry-After": "60" });
		if (route === "/authorize") {
			const p = url.searchParams;
			if ([...p.keys()].some(key => !["client_id", "redirect_uri", "response_type", "state", "scope", "resource", "code_challenge", "code_challenge_method"].includes(key))) invalid();
			client(p);
			const state = one(p, "state"), challenge = one(p, "code_challenge");
			if (one(p, "response_type") !== "code" || one(p, "code_challenge_method") !== "S256" || !ID.test(challenge ?? "") || !state || state.length < 16 || state.length > 512) invalid("PKCE S256 and a random state are required.");
			const resource = one(p, "resource"), scope = requestedScopes(resource, one(p, "scope"));
			const target = callbackUrl(one(p, "redirect_uri"));
			const id = random(), browser = random();
			return await stub(env, id).fetch(internal("start", { id, browser, target, state, challenge, resource, scope }));
		}
		if (route === "/callback") {
			const id = one(url.searchParams, "state");
			if (!ID.test(id ?? "")) invalidGrant();
			const pairs = (request.headers.get("Cookie") ?? "").split(";").map(item => item.trim().split("="));
			const browser = pairs.filter(([key]) => key === cookieName(id));
			if (browser.length !== 1 || !ID.test(browser[0][1] ?? "")) invalidGrant();
			return await stub(env, id).fetch(internal("callback", { id, browser: browser[0][1], code: one(url.searchParams, "code"), error: one(url.searchParams, "error"), issuer: one(url.searchParams, "iss") }));
		}
		if (url.search || request.headers.has("Authorization")) invalid();
		const p = await form(request);
		client(p);
		const grant = one(p, "grant_type");
		if (!["authorization_code", "refresh_token"].includes(grant)) throw new BrokerError("unsupported_grant_type", "Unsupported grant type.");
		const handle = one(p, grant === "authorization_code" ? "code" : "refresh_token");
		if (!HANDLE.test(handle ?? "")) invalidGrant();
		const id = handle.split(".")[0];
		return await stub(env, id).fetch(internal("token", { id, handle, grant, resource: one(p, "resource"), scope: one(p, "scope"),
			target: one(p, "redirect_uri"), verifier: one(p, "code_verifier") }));
	} catch (error) { return safeError(error); }
}

/** One isolated, expiring grant per login. Raw Google tokens are encrypted at rest and never returned in redirects. */
export class GoogleOAuthSession {
	constructor(ctx, env) { this.ctx = ctx; this.env = env; }
	async alarm() { await this.ctx.storage.deleteAll(); }
	async key() {
		return crypto.subtle.importKey("raw", Uint8Array.from(this.env.GOOGLE_TOKEN_KEY.match(/../g), part => parseInt(part, 16)), "AES-GCM", false, ["encrypt", "decrypt"]);
	}
	async save(data) {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(data.id) }, await this.key(), encoder.encode(JSON.stringify(data)));
		await this.ctx.storage.put("session", { iv: b64(iv), ciphertext: b64(ciphertext) });
		await this.ctx.storage.setAlarm(data.expires);
	}
	async load(id) {
		const saved = await this.ctx.storage.get("session");
		if (!saved) invalidGrant();
		let data;
		try { data = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(saved.iv), additionalData: encoder.encode(id) }, await this.key(), unb64(saved.ciphertext)))); }
		catch { invalidGrant(); }
		if (data.id !== id || data.expires <= Date.now() || data.upstreamClient !== this.env.GOOGLE_CLIENT_ID) invalidGrant();
		return data;
	}
	async google(params) {
		params.set("client_id", this.env.GOOGLE_CLIENT_ID);
		params.set("client_secret", this.env.GOOGLE_CLIENT_SECRET);
		const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params, redirect: "manual", signal: AbortSignal.timeout(10_000) });
		if (response.status >= 300 && response.status < 400) throw new Error("Unexpected upstream redirect");
		const value = await response.json();
		if (!response.ok || value.error) {
			if (value.error === "invalid_grant") invalidGrant();
			throw new BrokerError("temporarily_unavailable", "Google could not complete sign-in. Try again or contact the Pizza publisher.", 503);
		}
		if (typeof value.access_token !== "string" || !value.access_token || value.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
			(value.refresh_token !== undefined && (typeof value.refresh_token !== "string" || !value.refresh_token))) throw new Error("Invalid upstream token response");
		return value;
	}
	checkScopes(tokens, scope) {
		if (tokens.scope !== undefined && (typeof tokens.scope !== "string" || scope.split(" ").some(item => !tokens.scope.split(/\s+/).includes(item)))) {
			throw new BrokerError("invalid_scope", "The selected product permissions were not granted. Sign in and allow the requested permissions.");
		}
	}
	fetch(request) {
		// Google network calls yield: serialize callback/redeem/refresh across instances and consume each credential once.
		return this.ctx.blockConcurrencyWhile(async () => {
			try { return await this.handle(request); } catch (error) { return safeError(error); }
		});
	}
	async handle(request) {
		const path = new URL(request.url).pathname;
		const input = await request.json();
		if (path === "/start") {
			if (await this.ctx.storage.get("session")) invalidGrant();
			const verifier = random();
			const data = { ...input, browser: await hash(input.browser), upstreamVerifier: verifier, upstreamClient: this.env.GOOGLE_CLIENT_ID,
				phase: "pending", expires: Date.now() + TEN_MINUTES };
			await this.save(data);
			const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
			for (const [key, value] of Object.entries({ client_id: this.env.GOOGLE_CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", scope: data.scope,
				state: data.id, access_type: "offline", prompt: "consent", code_challenge: await hash(verifier), code_challenge_method: "S256" })) auth.searchParams.set(key, value);
			return redirect(auth, cookie(input.id, input.browser));
		}
		const data = await this.load(input.id);
		if (path === "/callback") {
			if (data.phase !== "pending" || data.browser !== await hash(input.browser) || (input.issuer && input.issuer !== "https://accounts.google.com")) invalidGrant();
			// A Google callback, including a denied consent, is single-use even if token exchange fails.
			await this.ctx.storage.deleteAll();
			const target = new URL(data.target);
			target.searchParams.set("state", data.state);
			target.searchParams.set("iss", ISSUER);
			if (input.error) {
				target.searchParams.set("error", "access_denied");
				return redirect(target, cookie(data.id, "", 0));
			}
			if (typeof input.code !== "string" || !input.code || input.code.length > 4096) invalidGrant();
			const tokens = await this.google(new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: CALLBACK, code_verifier: data.upstreamVerifier }));
			this.checkScopes(tokens, data.scope);
			if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) throw new BrokerError("invalid_grant", "Google did not provide offline access. Sign in again and allow access.");
			const secret = random();
			delete data.browser; delete data.upstreamVerifier;
			Object.assign(data, { phase: "ready", codeHash: await hash(secret), tokens, tokenExpires: Date.now() + tokens.expires_in * 1000, expires: Date.now() + 60_000 });
			await this.save(data);
			target.searchParams.set("code", `${data.id}.${secret}`);
			return redirect(target, cookie(data.id, "", 0));
		}
		if (path !== "/token" || input.resource !== data.resource || (input.scope && input.scope !== data.scope)) invalidGrant();
		const secretHash = await hash(input.handle.split(".")[1]);
		let tokens;
		if (input.grant === "authorization_code") {
			if (data.phase !== "ready" || secretHash !== data.codeHash || input.target !== data.target || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier ?? "") || await hash(input.verifier) !== data.challenge) invalidGrant();
			tokens = data.tokens;
			tokens.expires_in = Math.max(1, Math.floor((data.tokenExpires - Date.now()) / 1000));
		} else {
			if (data.phase !== "grant" || secretHash !== data.refreshHash) invalidGrant();
			tokens = await this.google(new URLSearchParams({ grant_type: "refresh_token", refresh_token: data.googleRefresh }));
			this.checkScopes(tokens, data.scope);
		}
		const next = random();
		await this.save({ id: data.id, resource: data.resource, scope: data.scope, upstreamClient: data.upstreamClient, phase: "grant",
			googleRefresh: tokens.refresh_token ?? data.googleRefresh, refreshHash: await hash(next), expires: Date.now() + GRANT_IDLE });
		return json({ access_token: tokens.access_token, token_type: "Bearer", expires_in: tokens.expires_in, scope: data.scope, refresh_token: `${data.id}.${next}` });
	}
}
