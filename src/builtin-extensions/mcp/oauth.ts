import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { APP_NAME, getAgentDir } from "../../config.js";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../../core/auth/auth-storage.js";
import type { AuthProvider, McpFetch } from "../../core/mcp/index.js";
import {
	type AuthorizationServerMetadata,
	authorizeDevice,
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthState,
	type McpOAuthStateStore,
	type OAuthCallback,
	type OAuthCallbackPage,
	type OAuthCallbackIssuer,
	OAuthCallbackServer,
	clientMetadataBaseUrl,
	clientMetadataDocumentUrl,
	oauthCallbackId,
	type OAuthChallenge,
	type OAuthDevicePrompt,
	type OAuthClientInformationMixed,
	type OAuthClientMetadataDocument,
	parseWwwAuthenticate,
	validateOAuthResponseIssuer,
	stepUpScope,
} from "../../core/mcp/oauth/index.js";
import { mcpNamespace } from "../../core/mcp/servers.js";
import { registeredOAuthConnector, googleWorkspaceConnector } from "../connectors/catalog.js";
import { PIZZA_OAUTH_LOGO } from "./oauth-logo.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
export const PIZZA_MCP_OAUTH_CLIENT_METADATA_URL = "https://pizza.hertzbeat.com/oauth/client.json";
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
const REFRESH_SKEW_MS = 30_000;
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_LOCK_STALE_MS = 20_000;
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderOAuthPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pizza · ${title}</title>
  <link rel="icon" type="image/png" href="${PIZZA_OAUTH_LOGO}" />
  <style>
    :root { --text: #fafafa; --text-dim: #a1a1aa; --page-bg: #09090b; }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--page-bg); color: var(--text); font-family: system-ui, sans-serif; text-align: center; }
    main { width: 100%; max-width: 560px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .logo { width: 72px; height: 72px; display: block; margin-bottom: 24px; }
    .brand { margin-bottom: 24px; font-size: 14px; font-weight: 600; letter-spacing: .12em; color: #f6c65b; }
    h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; font-weight: 650; }
    p { margin: 0; line-height: 1.7; color: var(--text-dim); font-size: 15px; }
    .details { margin-top: 16px; font-family: monospace; font-size: 13px; color: var(--text-dim); white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <main>
    <img class="logo" src="${PIZZA_OAUTH_LOGO}" alt="Pizza" aria-label="Pizza" width="72" height="72" />
    <div class="brand">PIZZA</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

function oauthSuccessHtml(message: string): string {
	return renderOAuthPage({ title: "Authentication successful", heading: "Authentication successful", message });
}

function oauthErrorHtml(message: string, details?: string): string {
	return renderOAuthPage({ title: "Authentication failed", heading: "Authentication failed", message, details });
}

export interface McpOAuthSettings {
	resourceIndicator?: boolean;
	authorizationResourceIndicator?: boolean;
	authorizationParams?: Record<string, string>;
	deviceAuthorizationUrl?: string;
	clientId?: string;
	/** Already resolved. */
	clientSecret?: string;
	callbackPort?: number;
	callbackUrl?: string;
	scope?: string;
	clientName?: string;
	clientRegistration?: "auto" | "dcr" | "cimd";
	clientMetadataUrl?: string;
	authServerMetadataUrl?: URL;
	/** Inline AS metadata (e.g. GitHub); preferred over discovery. */
	authorizationServerMetadata?: AuthorizationServerMetadata;
}

interface CallbackSettings {
	host: string;
	redirectHost: string;
	port: number | undefined;
	path: string;
	fixedRedirectUrl: string | undefined;
}

function callbackSettings(settings: McpOAuthSettings): CallbackSettings {
	const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
	const address = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : settings.callbackPort;
	let fixedRedirectUrl: string | undefined;
	if (url.port) fixedRedirectUrl = settings.callbackUrl;
	else if (port !== undefined) {
		url.port = String(port);
		fixedRedirectUrl = url.href;
	}
	return {
		host: address === "localhost" ? CALLBACK_HOST : address,
		redirectHost: address,
		port,
		path: url.pathname,
		fixedRedirectUrl,
	};
}

function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
	const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
	return merged.length > 0 ? merged.join(" ") : undefined;
}

type StoredStates = Record<string, McpOAuthState>;

function parseStates(content: string | undefined): StoredStates {
	if (!content?.trim()) return {};
	const parsed: unknown = JSON.parse(content);
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as StoredStates) : {};
}

function serializeStates(states: StoredStates): string {
	return `${JSON.stringify(states, null, 2)}\n`;
}

function storeKeys(name: string, serverUrl: string): { key: string; legacyKey: string } {
	const legacyKey = String(new URL(serverUrl));
	return { key: `${mcpNamespace(name)}|${legacyKey}`, legacyKey };
}

export interface McpOAuthServerStore extends McpOAuthStateStore {
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

async function updateState(store: McpOAuthStateStore, update: (state: McpOAuthState | undefined) => McpOAuthState): Promise<void> {
	if (store.update) await store.update(update);
	else await store.save(update(await store.load()));
}

/** A sign-out or a new sign-in invalidates every outstanding operation on this view. */
function signInStore(store: McpOAuthStateStore, signInId: string | undefined): McpOAuthStateStore {
	const current = (state: McpOAuthState | undefined): McpOAuthState => {
		if (!state || state.signInId !== signInId) throw new McpOAuthAuthorizationRequiredError();
		return state;
	};
	return {
		load: async () => current(await store.load()),
		save: (state) => updateState(store, (value) => { current(value); return state; }),
		update: (update) => updateState(store, (value) => update(current(value)) ?? { serverUrl: current(value).serverUrl, signInId }),
	};
}

async function beginSignIn(store: McpOAuthStateStore, serverUrl: string): Promise<McpOAuthStateStore> {
	const signInId = randomUUID();
	await updateState(store, (previous) => {
		const next: McpOAuthState = { ...previous, serverUrl: new URL(serverUrl).href, signInId };
		delete next.oauthState;
		delete next.codeVerifier;
		delete next.authorizationContext;
		return next;
	});
	return signInStore(store, signInId);
}

/** Per-server OAuth state (client registration, tokens, pending PKCE verifier) in `mcp-auth.json`. */
export class McpOAuthCredentialStore {
	private readonly backend: AuthStorageBackend;
	private readonly lockDir: string | undefined;

	constructor(backend?: AuthStorageBackend, lockDir?: string) {
		this.backend = backend ?? new FileAuthStorageBackend(join(getAgentDir(), "mcp-auth.json"));
		this.lockDir = backend ? lockDir : getAgentDir();
	}

	forServer(name: string, serverUrl: string): McpOAuthServerStore {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		return {
			load: () =>
				this.backend.withLock((current) => {
					const states = parseStates(current);
					if (states[key] || !states[legacyKey]) return { result: states[key] };
					states[key] = states[legacyKey];
					delete states[legacyKey];
					return { result: states[key], next: serializeStates(states) };
				}),
			save: (state) =>
				this.write((states) => {
					states[key] = state;
				}),
			update: (update) => this.backend.withLock((content) => {
				const states = parseStates(content);
				const state = update(states[key] ?? states[legacyKey]);
				delete states[legacyKey];
				if (state) states[key] = state;
				else delete states[key];
				return { result: undefined, next: serializeStates(states) };
			}),
			withRefreshLock: (fn) => this.withRefreshLock(key, fn),
		};
	}

	private async withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		if (!this.lockDir) return fn();
		mkdirSync(this.lockDir, { recursive: true, mode: 0o700 });
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		const release = await lockfile.lock(join(this.lockDir, `mcp-auth-refresh-${hash}`), {
			realpath: false,
			stale: REFRESH_LOCK_STALE_MS,
			retries: {
				retries: REFRESH_LOCK_WAIT_MS / REFRESH_LOCK_RETRY_MS,
				factor: 1,
				minTimeout: REFRESH_LOCK_RETRY_MS,
				maxTimeout: REFRESH_LOCK_RETRY_MS,
			},
			onCompromised: () => {},
		});
		try {
			return await fn();
		} finally {
			await release().catch(() => undefined);
		}
	}

	tokens(name: string, serverUrl: string): McpOAuthState["tokens"] {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		const states = this.backend.withLock((current) => ({ result: parseStates(current) }));
		return (states[key] ?? states[legacyKey])?.tokens;
	}

	remove(name: string, serverUrl: string): boolean {
		const { key, legacyKey } = storeKeys(name, serverUrl);
		return this.backend.withLock((current) => {
			const states = parseStates(current);
			const stored = key in states ? key : legacyKey in states ? legacyKey : undefined;
			if (!stored) return { result: false };
			delete states[stored];
			return { result: true, next: serializeStates(states) };
		});
	}

	private write(update: (states: StoredStates) => void): void {
		this.backend.withLock((current) => {
			const states = parseStates(current);
			update(states);
			return { result: undefined, next: serializeStates(states) };
		});
	}
}

function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

async function clientMetadataDocument(
	serverUrl: string,
	redirectUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
	settings: McpOAuthSettings,
	signal?: AbortSignal,
): Promise<OAuthClientMetadataDocument | undefined> {
	if (settings.clientRegistration === "dcr") return undefined;
	const base = settings.clientMetadataUrl ?? process.env.PIZZA_MCP_OAUTH_CLIENT_METADATA_URL ?? PIZZA_MCP_OAUTH_CLIENT_METADATA_URL;
	// Never advertise another product's identity or an undeployed placeholder.
	if (base) clientMetadataBaseUrl(base);
	const redirect = new URL(redirectUrl);
	const supported = base && metadata?.client_id_metadata_document_supported &&
		metadata.token_endpoint_auth_methods_supported?.includes("none") && redirect.protocol === "http:" &&
		["127.0.0.1", "localhost"].includes(redirect.hostname) && redirect.pathname === CALLBACK_PATH &&
		!redirect.username && !redirect.password && !redirect.search && !redirect.hash;
	if (!supported) {
		if (settings.clientRegistration === "cimd") {
			throw new Error(base
				? "CIMD requires authorization-server support for public clients and a localhost or 127.0.0.1 /callback redirect; use auto or dcr instead"
				: "CIMD requires Pizza's published metadata URL; set oauth.clientMetadataUrl or PIZZA_MCP_OAUTH_CLIENT_METADATA_URL");
		}
		return undefined;
	}
	const id = metadata.authorization_response_iss_parameter_supported ? undefined : oauthCallbackId(serverUrl);
	if (id) redirect.pathname = `${CALLBACK_PATH}/${id}`;
	const url = clientMetadataDocumentUrl(base!, id);
	// Until the publisher deploys this document, auto can still use the provider's DCR.
	let response: Response;
	try {
		response = await timedFetch()(url, { headers: { Accept: "application/json" }, redirect: "error", signal });
	} catch (error) {
		if (signal?.aborted) throw error;
		if (settings.clientRegistration === "cimd") throw new Error(`Could not load Pizza's CIMD document at ${url}`, { cause: error });
		return undefined;
	}
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		if (settings.clientRegistration === "cimd") throw new Error(`Could not load Pizza's CIMD document at ${url}: HTTP ${response.status}`);
		return undefined;
	}
	const document = await response.json() as Record<string, unknown>;
	const registered = new URL(redirect);
	registered.port = "";
	if (document.client_id !== url || document.client_name !== "Pizza" || document.token_endpoint_auth_method !== "none" ||
		!Array.isArray(document.redirect_uris) || !document.redirect_uris.includes(registered.href)) {
		throw new Error(`Invalid Pizza CIMD document at ${url}: client identity or redirect URI does not match`);
	}
	return { url, redirectUrl: redirect.href };
}

function createProvider(
	serverUrl: string,
	store: McpOAuthStateStore,
	settings: McpOAuthSettings,
	redirectUrl: string,
	onRedirect: (url: URL) => void,
	signal?: AbortSignal,
): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? APP_NAME },
		clientMetadataDocument: (metadata) => clientMetadataDocument(serverUrl, redirectUrl, metadata, settings, signal),
		authorizationRedirectUrl: (metadata) => {
			if (settings.clientId || metadata.authorization_response_iss_parameter_supported) return redirectUrl;
			const url = new URL(redirectUrl);
			url.pathname = `${url.pathname.replace(/\/$/, "")}/${oauthCallbackId(serverUrl)}`;
			return url.href;
		},
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		clientAuthenticationMethod: settings.deviceAuthorizationUrl && !settings.clientSecret ? "none" : undefined,
		store,
		onRedirect,
	});
}

export interface McpAuthProvider extends AuthProvider {
	settled(): Promise<void>;
}

export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: () => McpOAuthSettings;
	onChallenge: (challenge: OAuthChallenge) => void;
}): McpAuthProvider {
	const { serverUrl, store } = options;
	let refreshing: Promise<void> | undefined;

	const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
		refreshing ??= store
			.withRefreshLock(async () => {
				const state = await store.load();
				if (state?.tokens?.access_token !== staleToken) return;
				if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const settings = options.settings();
				const redirectUrl =
					callbackSettings(settings).fixedRedirectUrl ??
					registeredRedirectUrls(state.clientInformation)[0] ??
					FALLBACK_REDIRECT_URL;
				const provider = createProvider(serverUrl, signInStore(store, state.signInId), settings, redirectUrl, () => {});
				const result = await authorizeMcp(provider, {
					resourceIndicator: settings.resourceIndicator,
					serverUrl,
					// Providers such as Zoom publish PRM on a different host; keep the learned URL across restart.
					// Fetch it afresh and let authorizeMcp validate the persisted issuer/resource binding.
					resourceMetadataUrl: challenge?.resourceMetadataUrl ?? (state.discovery?.resourceMetadataUrl ? new URL(state.discovery.resourceMetadataUrl) : undefined),
					authorizationServerMetadataUrl: settings.authServerMetadataUrl,
					authorizationServerMetadata: settings.authorizationServerMetadata,
					scope: challenge?.scope,
					fetch: timedFetch(fetch),
					allowInteraction: false,
				});
				if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
			})
			.finally(() => {
				refreshing = undefined;
			});
		return refreshing;
	};

	return {
		token: async () => {
			await refreshing?.catch(() => undefined);
			const state = await store.load();
			const provider = createProvider(serverUrl, store, options.settings(), FALLBACK_REDIRECT_URL, () => {});
			const token = (await provider.tokens())?.access_token;
			if (!token) return undefined;
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			await refresh(token);
			return (await provider.tokens())?.access_token;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			await refresh(context.token, context.fetch, challenge);
		},
		settled: async () => {
			await refreshing?.catch(() => undefined);
		},
	};
}

export interface McpSignInPrompt {
	showAuthorizationUrl(url: URL): void;
	showDeviceCode?(prompt: OAuthDevicePrompt): void;
	promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export class McpSignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "McpSignInCancelledError";
	}
}

type AuthorizationResponse = Pick<OAuthCallback, "code" | "iss">;

function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL, issuer: OAuthCallbackIssuer): AuthorizationResponse {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Expected the full redirect URL from the browser address bar");
	}
	if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
		throw new Error("The redirect URL does not match this sign-in's redirect URI");
	}
	if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
	validateOAuthResponseIssuer(issuer.expected, url.searchParams.get("iss") ?? undefined, issuer.required);
	const error = url.searchParams.get("error");
	if (error) throw new Error(url.searchParams.get("error_description") ?? error);
	const code = url.searchParams.get("code");
	if (!code) throw new Error("The redirect URL does not contain an authorization code");
	return { code, iss: url.searchParams.get("iss") ?? undefined };
}

async function waitForAuthorizationResponse(
	callback: OAuthCallbackServer,
	state: string,
	redirectUrl: URL,
	issuer: OAuthCallbackIssuer,
	prompt: McpSignInPrompt,
	signal: AbortSignal | undefined,
): Promise<AuthorizationResponse> {
	const controller = new AbortController();
	const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
	const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname, issuer);
	const fromUser = Promise.resolve().then(() => prompt.promptForRedirectUrl(promptSignal)).then((input) => {
		if (!input?.trim()) throw new McpSignInCancelledError();
		return responseFromRedirectUrl(input, state, redirectUrl, issuer);
	});
	let onAbort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new McpSignInCancelledError());
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([fromBrowser, fromUser, cancelled]);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		controller.abort();
		fromBrowser.catch(() => undefined);
		fromUser.catch(() => undefined);
	}
}

async function listenForCallback(
	settings: CallbackSettings,
	extraPaths: string[],
	port: number | undefined,
	required: boolean,
): Promise<OAuthCallbackServer> {
	const options = {
		deferSuccess: true,
		host: settings.host,
		redirectHost: settings.redirectHost,
		path: settings.path,
		extraPaths,
		renderPage: (page: OAuthCallbackPage) =>
			page.ok
				? oauthSuccessHtml("Your credentials have been saved. Return to Pizza to use your MCP server. You may close this page.")
				: oauthErrorHtml(page.message, page.details),
	};
	try {
		return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
	} catch (error) {
		if (required || port === undefined) throw error;
		return OAuthCallbackServer.listen(options);
	}
}

export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpOAuthStateStore;
	settings: McpOAuthSettings;
	challenge?: OAuthChallenge;
	prompt: McpSignInPrompt;
	signal?: AbortSignal;
}): Promise<void> {
	const { serverUrl, settings, signal } = options;
	if (signal?.aborted) throw new McpSignInCancelledError();
	const registeredConnector = registeredOAuthConnector({ url: serverUrl }) ?? googleWorkspaceConnector({ url: serverUrl });
	if (registeredConnector && (!settings.clientId?.trim() || !settings.clientSecret?.trim())) {
		const name = registeredConnector.oauthSetup === "google" ? "a Google OAuth client" : registeredConnector.name;
		throw new Error(`Set up ${name} in Pizza with your own OAuth client ID, client secret, and registered callback URL before signing in. ${registeredConnector.docsUrl}`);
	}
	if (serverUrl === "https://gmail.googleapis.com/gmail/v1/users/me" && (!settings.clientId || !settings.clientSecret)) {
		throw new Error("This Pizza build is missing its Google Desktop OAuth registration. The publisher must build with PIZZA_GOOGLE_DESKTOP_CLIENT_FILE pointing to the Desktop client JSON.");
	}
	if (new URL(serverUrl).hostname === "gmailmcp.googleapis.com" && (!settings.clientId || !settings.clientSecret)) {
		throw new Error("Set up a Google OAuth client for Gmail in Pizza before signing in (oauth.clientId and oauth.clientSecret are required).");
	}
	if (new URL(serverUrl).origin === "https://api.x.com" && !settings.clientId) {
		throw new Error("Set up your X app's OAuth 2.0 Client ID in Pizza before signing in. A Native app uses PKCE without a client secret; Web and Automated apps also require their client secret.");
	}
	const store = await beginSignIn(options.store, serverUrl);
	const stored = await store.load();
	const stepUp = options.challenge?.error === "insufficient_scope";
	if (settings.deviceAuthorizationUrl && !settings.clientSecret) {
		if (!settings.clientId || !settings.authorizationServerMetadata?.token_endpoint) {
			throw new Error("Device sign-in requires a client ID and token endpoint");
		}
		try {
			const tokens = await authorizeDevice({
				clientId: settings.clientId,
				deviceAuthorizationUrl: settings.deviceAuthorizationUrl,
				tokenUrl: settings.authorizationServerMetadata.token_endpoint,
				scope: mergeScopes(settings.scope, stepUp ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope) : options.challenge?.scope),
				fetch: timedFetch(), signal,
				onPrompt: (prompt) => {
					if (!options.prompt.showDeviceCode) throw new Error("This client cannot display a device verification code");
					options.prompt.showDeviceCode(prompt);
					options.prompt.showAuthorizationUrl(new URL(prompt.verificationUri));
				},
			});
			const provider = createProvider(serverUrl, store, settings, FALLBACK_REDIRECT_URL, () => {});
			await provider.saveTokens(tokens, { kind: "device", binding: {
				issuer: settings.authorizationServerMetadata.issuer, clientId: settings.clientId,
				resource: new URL(serverUrl).href, registrationMethod: "pre-registered",
			} });
			return;
		} catch (error) {
			if (signal?.aborted) throw new McpSignInCancelledError();
			throw error;
		}
	}
	const callbackOptions = callbackSettings(settings);
	const registered = registeredRedirectUrls(stored?.clientInformation)[0];
	const preferredPort =
		callbackOptions.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
	const callback = await listenForCallback(
		callbackOptions,
		settings.clientId ? [] : [`${callbackOptions.path.replace(/\/$/, "")}/${oauthCallbackId(serverUrl)}`],
		preferredPort,
		callbackOptions.port !== undefined,
	);
	const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
	let provider: McpOAuthProvider | undefined;
	try {
		await updateState(store, (current) => {
			const next: McpOAuthState = { ...current! };
			delete next.oauthState;
			const registeredUrls = registeredRedirectUrls(next.clientInformation);
			const specificRedirect = new URL(redirectUrl);
			specificRedirect.pathname = `${specificRedirect.pathname.replace(/\/$/, "")}/${oauthCallbackId(serverUrl)}`;
			const switchToDcr = settings.clientRegistration === "dcr" && next.credentialBinding?.registrationMethod === "cimd";
			const keepClient = settings.clientId || (!switchToDcr && settings.clientRegistration !== "cimd" &&
				(registeredUrls.includes(redirectUrl) || registeredUrls.includes(specificRedirect.href)));
			if (!keepClient) {
				delete next.clientInformation;
				delete next.tokens;
				delete next.tokensExpireAt;
				delete next.credentialBinding;
			}
			return next;
		});

		let authorizationUrl: URL | undefined;
		provider = createProvider(serverUrl, store, settings, redirectUrl, (url) => {
			authorizationUrl = url;
		}, signal);
		const flow = {
			resourceIndicator: settings.resourceIndicator,
			authorizationResourceIndicator: settings.authorizationResourceIndicator,
			authorizationParams: settings.authorizationParams,
			serverUrl,
			fetch: timedFetch(),
			signal,
			resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
			authorizationServerMetadataUrl: settings.authServerMetadataUrl,
			authorizationServerMetadata: settings.authorizationServerMetadata,
			scope: mergeScopes(
				settings.scope,
				stepUp ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope) : options.challenge?.scope,
			),
		};
		// Explicit sign-in always opens a new authorization, including account changes.
		if ((await authorizeMcp(provider, { ...flow, skipRefresh: true })) === "AUTHORIZED") return;
		if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");

		const state = authorizationUrl.searchParams.get("state");
		if (!state) throw new Error("OAuth authorization URL did not include state");
		const authorizationRedirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
		const context = await provider.authorizationContext();
		if (!context) throw new Error("OAuth authorization context is missing");
		const response = waitForAuthorizationResponse(
			callback,
			state,
			authorizationRedirectUrl,
			{ expected: context.binding.issuer, required: context.metadata.authorization_response_iss_parameter_supported === true },
			options.prompt,
			signal,
		);
		// Register the callback before opening the browser (an existing grant can redirect immediately).
		try {
			options.prompt.showAuthorizationUrl(authorizationUrl);
		} catch (error) {
			void response.catch(() => undefined);
			throw error;
		}
		const { code, iss } = await response;
		await authorizeMcp(provider, { ...flow, authorizationCode: code, authorizationState: state, iss });
		callback.complete({ ok: true });
	} catch (error) {
		callback.complete({ ok: false, message: "Sign-in failed. Return to Pizza to try again.", details: error instanceof Error ? error.message : String(error) });
		if (signal?.aborted) throw new McpSignInCancelledError();
		throw error;
	} finally {
		await provider?.invalidateCredentials("verifier").catch(() => {});
		await callback.close();
	}
}
