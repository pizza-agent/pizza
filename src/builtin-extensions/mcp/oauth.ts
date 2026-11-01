import { createHash } from "node:crypto";
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
	OAuthCallbackServer,
	type OAuthChallenge,
	type OAuthDevicePrompt,
	type OAuthClientInformationMixed,
	type OAuthClientMetadataDocument,
	parseWwwAuthenticate,
	stepUpScope,
} from "../../core/mcp/oauth/index.js";
import { mcpNamespace } from "../../core/mcp/servers.js";
import { PIZZA_OAUTH_LOGO } from "./oauth-logo.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const CLIENT_METADATA_BASE_URL = "https://pi.dev/oauth";
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
	clientRegistration?: "dcr" | "cimd";
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

function callbackId(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

function clientMetadataDocument(
	serverUrl: string,
	redirectUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
): OAuthClientMetadataDocument {
	if (
		!metadata?.client_id_metadata_document_supported ||
		!metadata.token_endpoint_auth_methods_supported?.includes("none")
	) {
		throw new Error(
			'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
		);
	}
	if (metadata.authorization_response_iss_parameter_supported) {
		return { url: `${CLIENT_METADATA_BASE_URL}/client.json`, redirectUrl };
	}
	const id = callbackId(serverUrl);
	const redirect = new URL(redirectUrl);
	redirect.pathname = `${CALLBACK_PATH}/${id}`;
	return { url: `${CLIENT_METADATA_BASE_URL}/${id}/client.json`, redirectUrl: redirect.href };
}

function createProvider(
	serverUrl: string,
	store: McpOAuthStateStore,
	settings: McpOAuthSettings,
	redirectUrl: string,
	onRedirect: (url: URL) => void,
): McpOAuthProvider {
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? APP_NAME },
		clientMetadataDocument:
			settings.clientRegistration === "cimd"
				? (metadata) => clientMetadataDocument(serverUrl, redirectUrl, metadata)
				: undefined,
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
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
				const provider = createProvider(serverUrl, store, settings, redirectUrl, () => {});
				const result = await authorizeMcp(provider, {
					serverUrl,
					resourceMetadataUrl: challenge?.resourceMetadataUrl,
					authorizationServerMetadataUrl: settings.authServerMetadataUrl,
					authorizationServerMetadata: settings.authorizationServerMetadata,
					scope: challenge?.scope,
					fetch: timedFetch(fetch),
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
			const token = state?.tokens?.access_token;
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			await refresh(token).catch(() => undefined);
			return (await store.load())?.tokens?.access_token;
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

function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL): AuthorizationResponse {
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
	prompt: McpSignInPrompt,
	signal: AbortSignal | undefined,
): Promise<AuthorizationResponse> {
	const controller = new AbortController();
	const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
	const fromBrowser = callback.waitForCallback(state, redirectUrl.pathname);
	const fromUser = Promise.resolve().then(() => prompt.promptForRedirectUrl(promptSignal)).then((input) => {
		if (!input?.trim()) throw new McpSignInCancelledError();
		return responseFromRedirectUrl(input, state, redirectUrl);
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
	const { serverUrl, store, settings, signal } = options;
	if (signal?.aborted) throw new McpSignInCancelledError();
	if (serverUrl === "https://gmail.googleapis.com/gmail/v1/users/me" && (!settings.clientId || !settings.clientSecret)) {
		throw new Error("This Pizza build is missing its Google Desktop OAuth registration. The publisher must build with PIZZA_GOOGLE_DESKTOP_CLIENT_FILE pointing to the Desktop client JSON.");
	}
	if (new URL(serverUrl).hostname === "gmailmcp.googleapis.com" && (!settings.clientId || !settings.clientSecret)) {
		throw new Error("Set up a Google OAuth client for Gmail in Pizza before signing in (oauth.clientId and oauth.clientSecret are required).");
	}
	if (new URL(serverUrl).origin === "https://api.x.com" && !settings.clientId) {
		throw new Error("Set up your X app's OAuth 2.0 Client ID in Pizza before signing in. A Native app uses PKCE without a client secret; Web and Automated apps also require their client secret.");
	}
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
			await provider.saveTokens(tokens);
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
	const cimd = settings.clientRegistration === "cimd";
	const callback = await listenForCallback(
		callbackOptions,
		cimd ? [`${CALLBACK_PATH}/${callbackId(serverUrl)}`] : [],
		preferredPort,
		callbackOptions.port !== undefined,
	);
	const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
	try {
		if (stored) {
			const next: McpOAuthState = { ...stored };
			delete next.oauthState;
			const keepClient =
				settings.clientId ||
				(cimd ? !stored.clientInformation : registeredRedirectUrls(stored.clientInformation).includes(redirectUrl));
			if (!keepClient) {
				delete next.clientInformation;
				delete next.tokens;
				delete next.tokensExpireAt;
			}
			await store.save(next);
		}

		let authorizationUrl: URL | undefined;
		const provider = createProvider(serverUrl, store, settings, redirectUrl, (url) => {
			authorizationUrl = url;
		});
		const flow = {
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
		const skipRefresh = stepUp;
		if ((await authorizeMcp(provider, { ...flow, skipRefresh })) === "AUTHORIZED") return;
		if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");

		const state = await provider.state();
		const authorizationRedirectUrl = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
		const response = waitForAuthorizationResponse(
			callback,
			state,
			authorizationRedirectUrl,
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
		await authorizeMcp(provider, { ...flow, authorizationCode: code, iss });
		callback.complete({ ok: true });
	} catch (error) {
		callback.complete({ ok: false, message: "Sign-in failed. Return to Pizza to try again.", details: error instanceof Error ? error.message : String(error) });
		if (signal?.aborted) throw new McpSignInCancelledError();
		throw error;
	} finally {
		await callback.close();
	}
}
