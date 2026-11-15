import type { AuthProvider, McpFetch, UnauthorizedContext } from "../auth-provider.js";
import { validateAuthorizationParams } from "./authorization-params.js";
import { isObject } from "../protocol/jsonrpc.js";
import {
	discoverOAuthServerInfo,
	parseWwwAuthenticate,
	resourceUrlFromServerUrl,
	secureOAuthEndpoint,
	selectResource,
} from "./discovery.js";
import {
	McpOAuthAuthorizationRequiredError,
	OAuthError,
	OAuthRegistrationError,
	validateOAuthResponseIssuer,
} from "./errors.js";
import {
	type AuthorizationServerMetadata,
	type OAuthClientInformation,
	type OAuthClientInformationFull,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthAuthorizationContext,
	type OAuthCredentialBinding,
	type OAuthDiscoveryState,
	type OAuthTokens,
	type OAuthTokenSaveContext,
	parseClientInformation,
	parseOAuthTokens,
} from "./types.js";

export type AddClientAuthentication = (
	headers: Headers,
	params: URLSearchParams,
	url: string | URL,
	metadata?: AuthorizationServerMetadata,
) => void | Promise<void>;

/** A Client ID Metadata Document: an https URL used as `client_id`, and a redirect URI it lists. */
export interface OAuthClientMetadataDocument {
	url: string;
	redirectUrl: string;
}

export interface OAuthClientProvider {
	readonly redirectUrl: string | URL;
	readonly clientMetadata: OAuthClientMetadata;
	clientMetadataDocument?(metadata: AuthorizationServerMetadata | undefined): OAuthClientMetadataDocument | undefined | Promise<OAuthClientMetadataDocument | undefined>;
	authorizationRedirectUrl?(metadata: AuthorizationServerMetadata): string;
	state?(): string | Promise<string>;
	clientInformation(): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
	saveClientInformation?(information: OAuthClientInformationMixed): void | Promise<void>;
	tokens(): OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
	saveTokens(tokens: OAuthTokens, context?: OAuthTokenSaveContext): void | Promise<void>;
	redirectToAuthorization(url: URL): void | Promise<void>;
	saveCodeVerifier(verifier: string): void | Promise<void>;
	codeVerifier(): string | Promise<string>;
	addClientAuthentication?: AddClientAuthentication;
	invalidateCredentials?(kind: "all" | "client" | "tokens" | "verifier" | "discovery", context?: OAuthTokenSaveContext): void | Promise<void>;
	saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
	discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
	credentialBinding(): OAuthCredentialBinding | undefined | Promise<OAuthCredentialBinding | undefined>;
	saveCredentialBinding(binding: OAuthCredentialBinding): void | Promise<void>;
	authorizationContext(): OAuthAuthorizationContext | undefined | Promise<OAuthAuthorizationContext | undefined>;
	saveAuthorizationContext(context: OAuthAuthorizationContext): void | Promise<void>;
}

export interface OAuthFlowOptions {
	/** Disable for legacy OAuth providers that do not implement RFC 8707 (Google); resource binding remains enforced. */
	resourceIndicator?: boolean;
	/** Compatibility option for providers that reject resource on their authorization endpoint. Tokens and resource discovery remain bound. */
	authorizationResourceIndicator?: boolean;
	authorizationParams?: Record<string, string>;
	serverUrl: string | URL;
	authorizationCode?: string;
	/** State echoed by the response; must match the pending authorization attempt. */
	authorizationState?: string;
	/** `iss` parameter of the authorization response that delivered `authorizationCode` (RFC 9207). */
	iss?: string;
	scope?: string;
	resourceMetadataUrl?: URL;
	authorizationServerMetadataUrl?: URL;
	/** Inline AS metadata; trusted as configured and preferred over discovery / URL fetch. */
	authorizationServerMetadata?: AuthorizationServerMetadata;
	fetch?: McpFetch;
	signal?: AbortSignal;
	skipIssuerValidation?: boolean;
	skipRefresh?: boolean;
	/** Background refresh must never register a client or start browser authorization. */
	allowInteraction?: boolean;
}

export type OAuthFlowResult = "AUTHORIZED" | "REDIRECT";
type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

export interface TokenRequestOptions {
	metadata?: AuthorizationServerMetadata;
	clientInformation: OAuthClientInformationMixed;
	resource?: string;
	addClientAuthentication?: AddClientAuthentication;
	fetch?: McpFetch;
	signal?: AbortSignal;
}

function loopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function applicationType(redirectUris: readonly string[]): "native" | "web" {
	const native = redirectUris.some((uri) => {
		if (!URL.canParse(uri)) return false;
		const url = new URL(uri);
		return (url.protocol !== "http:" && url.protocol !== "https:") || loopback(url.hostname);
	});
	return native ? "native" : "web";
}

function selectClientAuthMethod(information: OAuthClientInformationMixed, supported: string[]): ClientAuthMethod {
	const hinted = "token_endpoint_auth_method" in information ? information.token_endpoint_auth_method : undefined;
	if (hinted) {
		if (!["client_secret_basic", "client_secret_post", "none"].includes(hinted)) {
			throw new Error(`Unsupported registered OAuth client authentication method: ${hinted}`);
		}
		// RFC 7591 §3.2.1: the registration response assigns this client's method.
		// GitLab registers public clients as "none" while global discovery lists only secret methods.
		return hinted as ClientAuthMethod;
	}
	if (supported.length === 0) return information.client_secret ? "client_secret_basic" : "none";
	if (information.client_secret && supported.includes("client_secret_basic")) return "client_secret_basic";
	if (information.client_secret && supported.includes("client_secret_post")) return "client_secret_post";
	if (supported.includes("none")) return "none";
	throw new Error("Authorization server does not support an available OAuth client authentication method");
}

function applyClientAuthentication(
	method: ClientAuthMethod,
	information: OAuthClientInformation,
	headers: Headers,
	params: URLSearchParams,
): void {
	if (method === "client_secret_basic") {
		if (!information.client_secret) throw new Error("client_secret_basic requires a client secret");
		const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
		headers.set(
			"Authorization",
			`Basic ${Buffer.from(`${encode(information.client_id)}:${encode(information.client_secret)}`).toString("base64")}`,
		);
	} else {
		params.set("client_id", information.client_id);
		if (method === "client_secret_post" && information.client_secret)
			params.set("client_secret", information.client_secret);
	}
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = Buffer.from(bytes).toString("base64url");
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

export async function startAuthorization(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientInformation: OAuthClientInformationMixed;
		redirectUrl: string | URL;
		scope?: string;
		state?: string;
		resource?: string;
		authorizationParams?: Record<string, string>;
	},
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
	const metadata = options.metadata;
	const paramsError = validateAuthorizationParams(options.authorizationParams);
	if (paramsError) throw new Error(paramsError);
	if (metadata && !metadata.response_types_supported.includes("code")) {
		throw new Error("Authorization server does not support authorization codes");
	}
	if (!metadata?.code_challenge_methods_supported?.includes("S256")) {
		throw new Error("Authorization server must advertise PKCE S256 support");
	}
	const url = secureOAuthEndpoint(metadata.authorization_endpoint);
	const { verifier, challenge } = await pkce();
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", options.clientInformation.client_id);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("redirect_uri", String(options.redirectUrl));
	if (options.state) url.searchParams.set("state", options.state);
	if (options.scope) url.searchParams.set("scope", options.scope);
	if (options.scope?.split(/\s+/).includes("offline_access")) url.searchParams.set("prompt", "consent");
	if (options.resource) url.searchParams.set("resource", options.resource);
	for (const [name, value] of Object.entries(options.authorizationParams ?? {})) url.searchParams.set(name, value);
	return { authorizationUrl: url, codeVerifier: verifier };
}

async function tokenRequest(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions,
	params: URLSearchParams,
): Promise<OAuthTokens> {
	const url = secureOAuthEndpoint(options.metadata?.token_endpoint ?? new URL("/token", authorizationServerUrl));
	const headers = new Headers({ Accept: "application/json", "content-type": "application/x-www-form-urlencoded" });
	if (options.resource) params.set("resource", options.resource);
	if (options.addClientAuthentication) {
		await options.addClientAuthentication(headers, params, url, options.metadata);
	} else {
		applyClientAuthentication(
			selectClientAuthMethod(
				options.clientInformation,
				options.metadata?.token_endpoint_auth_methods_supported ?? [],
			),
			options.clientInformation,
			headers,
			params,
		);
	}
	const response = await (options.fetch ?? globalThis.fetch)(url, {
		method: "POST",
		redirect: "error",
		headers,
		body: params,
		signal: options.signal,
	});
	const text = await response.text();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {}
	if (isObject(value) && typeof value.error === "string") {
		throw new OAuthError(
			value.error,
			typeof value.error_description === "string" ? value.error_description : value.error,
			typeof value.error_uri === "string" ? value.error_uri : undefined,
		);
	}
	if (!response.ok) throw new OAuthError("server_error", `HTTP ${response.status}: ${text}`);
	return parseOAuthTokens(value);
}

export async function registerClient(
	authorizationServerUrl: string | URL,
	options: {
		metadata?: AuthorizationServerMetadata;
		clientMetadata: OAuthClientMetadata;
		scope?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	},
): Promise<OAuthClientInformationFull> {
	const endpoint = options.metadata?.registration_endpoint;
	if (options.metadata && !endpoint)
		throw new Error(
			"Authorization server does not support dynamic client registration. " +
			"Set oauth.clientId (and optional oauth.clientSecret) for this MCP server, " +
			"or configure a static token / PAT instead."
		);
	const response = await (options.fetch ?? globalThis.fetch)(
		secureOAuthEndpoint(endpoint ?? new URL("/register", authorizationServerUrl)),
		{
			method: "POST",
			redirect: "error",
			headers: { Accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({
				...options.clientMetadata,
				application_type:
					options.clientMetadata.application_type ?? applicationType(options.clientMetadata.redirect_uris),
				...(options.scope ? { scope: options.scope } : {}),
			}),
			signal: options.signal,
		},
	);
	if (!response.ok) throw new OAuthRegistrationError(response.status, await response.text());
	return parseClientInformation(await response.json());
}

export async function exchangeAuthorizationCode(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { code: string; codeVerifier: string; redirectUrl: string | URL },
): Promise<OAuthTokens> {
	return tokenRequest(
		authorizationServerUrl,
		options,
		new URLSearchParams({
			grant_type: "authorization_code",
			code: options.code,
			code_verifier: options.codeVerifier,
			redirect_uri: String(options.redirectUrl),
		}),
	);
}

export async function refreshAuthorization(
	authorizationServerUrl: string | URL,
	options: TokenRequestOptions & { refreshToken: string },
): Promise<OAuthTokens> {
	const tokens = await tokenRequest(
		authorizationServerUrl,
		options,
		new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken }),
	);
	return { refresh_token: options.refreshToken, ...tokens };
}

function withScope(tokens: OAuthTokens, scope: string | undefined): OAuthTokens {
	return tokens.scope === undefined && scope ? { ...tokens, scope } : tokens;
}

export function stepUpScope(granted: string | undefined, challenged: string | undefined): string | undefined {
	if (!challenged) return undefined;
	const scopes = [granted, challenged].flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []);
	return [...new Set(scopes)].join(" ");
}

function sameBinding(left: OAuthCredentialBinding | undefined, right: OAuthCredentialBinding): boolean {
	return left?.issuer === right.issuer && left.clientId === right.clientId && left.resource === right.resource;
}

async function requestTokens(provider: OAuthClientProvider, context: OAuthTokenSaveContext, request: () => Promise<OAuthTokens>): Promise<OAuthTokens> {
	try {
		return await request();
	} catch (error) {
		if (error instanceof OAuthError && ["invalid_client", "unauthorized_client", "invalid_grant"].includes(error.code)) {
			await provider.invalidateCredentials?.(error.code === "invalid_grant" ? "tokens" : "all", context);
		}
		throw error;
	}
}

async function runFlow(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	// The authorization response belongs to the snapshot taken before opening the browser.
	// A discovery/configuration change while the user signs in must not redirect their code.
	const code = options.authorizationCode;
	if (code) {
		const context = await provider.authorizationContext();
		const client = await provider.clientInformation();
		if (!context || context.state !== options.authorizationState || !client || client.client_id !== context.binding.clientId ||
			!sameBinding(await provider.credentialBinding(), context.binding)) {
			throw new McpOAuthAuthorizationRequiredError();
		}
		const metadata = context.metadata;
		validateOAuthResponseIssuer(context.binding.issuer, options.iss, metadata.authorization_response_iss_parameter_supported === true);
		const saveContext: OAuthTokenSaveContext = { kind: "authorization_code", authorization: context };
		const tokens = await requestTokens(provider, saveContext, () => exchangeAuthorizationCode(context.binding.issuer, {
			metadata, clientInformation: client, resource: context.resource,
			addClientAuthentication: provider.addClientAuthentication, fetch: options.fetch, signal: options.signal,
			code, codeVerifier: context.codeVerifier, redirectUrl: context.redirectUrl,
		}));
		await provider.saveTokens(withScope(tokens, context.scope), saveContext);
		return "AUTHORIZED";
	}

	// Rediscover before refresh so persisted credentials are never sent to a new issuer.
	const discovered = await discoverOAuthServerInfo(options.serverUrl, {
		resourceMetadataUrl: options.resourceMetadataUrl,
		authorizationServerMetadataUrl: options.authorizationServerMetadataUrl,
		authorizationServerMetadata: options.authorizationServerMetadata,
		fetch: options.fetch, skipIssuerValidation: options.skipIssuerValidation, signal: options.signal,
	});
	const metadata = discovered.authorizationServerMetadata;
	if (!metadata) throw new Error("OAuth authorization server metadata not found; configure oauth.authServerMetadataUrl or oauth.authorizationServerMetadata");
	const bindingResource = selectResource(options.serverUrl, discovered.resourceMetadata) ?? resourceUrlFromServerUrl(options.serverUrl).href;
	const resource = options.resourceIndicator === false ? undefined : bindingResource;
	const scope = options.scope || discovered.resourceMetadata?.scopes_supported?.join(" ") || provider.clientMetadata.scope;
	let client = await provider.clientInformation();
	const previous = await provider.credentialBinding();
	let registrationMethod = previous?.registrationMethod;
	if (!previous || !client || !sameBinding(previous, { issuer: metadata.issuer, clientId: client.client_id, resource: bindingResource })) {
		if (options.allowInteraction === false) throw new McpOAuthAuthorizationRequiredError();
		// Old credentials without an issuer stamp need one fresh login; never infer their issuer from discovery.
		await provider.invalidateCredentials?.("all");
		client = await provider.clientInformation();
		registrationMethod = client ? "pre-registered" : undefined;
	}
	await provider.saveDiscoveryState?.({ ...discovered,
		...(options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl.href } : {}),
	});
	const document = client ? undefined : await provider.clientMetadataDocument?.(metadata);
	const redirectUrl = document?.redirectUrl ?? provider.authorizationRedirectUrl?.(metadata) ?? String(provider.redirectUrl);
	if (!client) {
		if (options.allowInteraction === false) throw new McpOAuthAuthorizationRequiredError();
		if (!metadata.code_challenge_methods_supported?.includes("S256")) throw new Error("Authorization server must advertise PKCE S256 support");
		if (document) {
			const url = new URL(document.url);
			if (url.protocol !== "https:" || url.pathname === "/" || url.username || url.password || url.search || url.hash) {
				throw new Error("Invalid OAuth client metadata URL");
			}
			client = { ...provider.clientMetadata, client_id: document.url, redirect_uris: [redirectUrl], token_endpoint_auth_method: "none" };
			registrationMethod = "cimd";
		} else {
			client = await registerClient(metadata.issuer, {
				metadata,
				clientMetadata: { ...provider.clientMetadata, redirect_uris: [redirectUrl] },
				scope, fetch: options.fetch, signal: options.signal,
			});
			registrationMethod = "dcr";
		}
		if (!provider.saveClientInformation) throw new Error("OAuth client information cannot be persisted");
		await provider.saveClientInformation(client);
	}
	const binding = { issuer: metadata.issuer, clientId: client.client_id, resource: bindingResource, registrationMethod };
	await provider.saveCredentialBinding(binding);
	const tokenOptions: TokenRequestOptions = {
		metadata, clientInformation: client, resource, addClientAuthentication: provider.addClientAuthentication,
		fetch: options.fetch, signal: options.signal,
	};
	const existing = options.skipRefresh ? undefined : await provider.tokens();
	if (existing?.refresh_token) {
		const saveContext: OAuthTokenSaveContext = { kind: "refresh_token", binding, refreshToken: existing.refresh_token };
		const tokens = await requestTokens(provider, saveContext, () => refreshAuthorization(metadata.issuer, { ...tokenOptions, refreshToken: existing.refresh_token! }));
		await provider.saveTokens(withScope(tokens, existing.scope), saveContext);
		return "AUTHORIZED";
	}
	if (options.allowInteraction === false) throw new McpOAuthAuthorizationRequiredError();
	const state = await provider.state?.();
	const authorization = await startAuthorization(metadata.issuer, {
		authorizationParams: options.authorizationParams, metadata, clientInformation: client, redirectUrl, scope,
		state, resource: options.authorizationResourceIndicator === false ? undefined : resource,
	});
	await provider.saveCodeVerifier(authorization.codeVerifier);
	await provider.saveAuthorizationContext({ binding, metadata, redirectUrl, resource, scope, state, codeVerifier: authorization.codeVerifier });
	await provider.redirectToAuthorization(authorization.authorizationUrl);
	return "REDIRECT";
}

export async function authorizeMcp(provider: OAuthClientProvider, options: OAuthFlowOptions): Promise<OAuthFlowResult> {
	try {
		return await runFlow(provider, options);
	} catch (error) {
		if (error instanceof OAuthError && ["invalid_client", "unauthorized_client"].includes(error.code)) {
			if (options.authorizationCode) throw error;
			if (options.allowInteraction === false) throw new McpOAuthAuthorizationRequiredError();
			return runFlow(provider, options);
		}
		if (error instanceof OAuthError && error.code === "invalid_grant") {
			if (options.authorizationCode) throw error;
			if (options.allowInteraction === false) throw new McpOAuthAuthorizationRequiredError();
			return runFlow(provider, options);
		}
		throw error;
	}
}

export function adaptOAuthProvider(provider: OAuthClientProvider): AuthProvider {
	let inFlight: Promise<void> | undefined;
	return {
		token: async () => (await provider.tokens())?.access_token,
		onUnauthorized: async (context: UnauthorizedContext) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			const insufficientScope = challenge.error === "insufficient_scope";
			if (!insufficientScope && !inFlight && context.token !== undefined) {
				const current = (await provider.tokens())?.access_token;
				if (current !== undefined && current !== context.token) return;
			}
			inFlight ??= Promise.resolve(insufficientScope ? provider.tokens() : undefined)
				.then((granted) =>
					authorizeMcp(provider, {
						serverUrl: context.serverUrl,
						resourceMetadataUrl: challenge.resourceMetadataUrl,
						scope: insufficientScope ? stepUpScope(granted?.scope, challenge.scope) : challenge.scope,
						fetch: context.fetch,
						skipRefresh: insufficientScope,
					}),
				)
				.then((result) => {
					if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
				})
				.finally(() => {
					inFlight = undefined;
				});
			await inFlight;
		},
	};
}
