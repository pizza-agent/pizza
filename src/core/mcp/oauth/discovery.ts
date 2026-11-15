import type { McpFetch } from "../auth-provider.js";
import { LATEST_PROTOCOL_VERSION } from "../protocol/types.js";
import { OAuthInsecureEndpointError, OAuthIssuerMismatchError } from "./errors.js";
import {
	type AuthorizationServerMetadata,
	type OAuthChallenge,
	type OAuthProtectedResourceMetadata,
	type OAuthServerInfo,
	parseAuthorizationServerMetadata,
	parseProtectedResourceMetadata,
} from "./types.js";

function discard(response: Response | undefined): void {
	void response?.body?.cancel().catch(() => {});
}

/** Only a missing document permits legacy discovery. Outages and invalid documents must fail closed. */
function isDiscoveryMiss(status: number): boolean {
	return status === 404;
}

class MetadataNotFoundError extends Error {}

export function secureOAuthEndpoint(value: string | URL): URL {
	const url = new URL(value);
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.hash) {
		throw new OAuthInsecureEndpointError(url.href);
	}
	return url;
}

/** Path suffix for `/.well-known/<kind><path>`; empty for the root path. */
function pathSuffix(pathname: string): string {
	return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** Commas separate challenges/parameters only outside quoted strings (RFC 9110). */
function challengeParts(header: string): string[] {
	const parts: string[] = [];
	let start = 0, quoted = false, escaped = false;
	for (let index = 0; index < header.length; index++) {
		const character = header[index];
		if (escaped) { escaped = false; continue; }
		if (quoted && character === "\\") { escaped = true; continue; }
		if (character === '"') quoted = !quoted;
		if (!quoted && character === ",") { parts.push(header.slice(start, index).trim()); start = index + 1; }
	}
	if (quoted || escaped || /[\r\n\0]/.test(header)) throw new Error("Invalid WWW-Authenticate header");
	parts.push(header.slice(start).trim());
	return parts;
}

export function parseWwwAuthenticate(header: string | null): OAuthChallenge {
	if (!header) return {};
	const fields = new Map<string, string>();
	let bearer = false, found = false;
	for (const part of challengeParts(header)) {
		let parameter = part;
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=/.test(part)) {
			const challenge = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:\s+(.*))?$/.exec(part);
			if (!challenge) continue;
			if (found) break;
			bearer = challenge[1].toLowerCase() === "bearer";
			if (!bearer) continue;
			found = true;
			parameter = challenge[2] ?? "";
		}
		if (!bearer || !parameter) continue;
		const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))$/.exec(parameter);
		if (!match) throw new Error("Invalid OAuth bearer challenge parameter");
		const name = match[1].toLowerCase();
		if (fields.has(name)) throw new Error(`Duplicate OAuth bearer challenge parameter: ${name}`);
		fields.set(name, match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : match[3]);
	}
	if (!found) return {};
	const resourceMetadata = fields.get("resource_metadata");
	let resourceMetadataUrl: URL | undefined;
	if (resourceMetadata !== undefined) {
		resourceMetadataUrl = secureOAuthEndpoint(resourceMetadata);
	}
	return {
		resourceMetadataUrl,
		scope: fields.get("scope"),
		error: fields.get("error"),
		errorDescription: fields.get("error_description"),
	};
}

async function fetchMetadata(
	url: URL,
	fetch: McpFetch,
	protocolVersion: string,
	signal: AbortSignal | undefined,
): Promise<Response> {
	return fetch(secureOAuthEndpoint(url), {
		headers: { Accept: "application/json", "MCP-Protocol-Version": protocolVersion },
		redirect: "error",
		signal,
	});
}

export async function discoverProtectedResourceMetadata(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: string | URL;
		protocolVersion?: string;
		fetch?: McpFetch;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthProtectedResourceMetadata> {
	const server = new URL(serverUrl);
	const fetch = options.fetch ?? globalThis.fetch;
	const version = options.protocolVersion ?? LATEST_PROTOCOL_VERSION;
	let response = await fetchMetadata(
		options.resourceMetadataUrl
			? new URL(options.resourceMetadataUrl)
			: new URL(`/.well-known/oauth-protected-resource${pathSuffix(server.pathname)}`, server.origin),
		fetch,
		version,
		options.signal,
	);
	if (!options.resourceMetadataUrl && server.pathname !== "/" && isDiscoveryMiss(response.status)) {
		discard(response);
		response = await fetchMetadata(
			new URL("/.well-known/oauth-protected-resource", server.origin),
			fetch,
			version,
			options.signal,
		);
	}
	if (!response.ok) {
		discard(response);
		if (response.status === 404 && !options.resourceMetadataUrl) throw new MetadataNotFoundError("OAuth protected resource metadata not found");
		throw new Error(`HTTP ${response.status} loading OAuth protected resource metadata`);
	}
	return parseProtectedResourceMetadata(await response.json());
}

export function buildAuthorizationServerDiscoveryUrls(
	authorizationServerUrl: string | URL,
): { url: URL; type: "oauth" | "oidc" }[] {
	const issuer = new URL(authorizationServerUrl);
	const path = pathSuffix(issuer.pathname);
	const urls: { url: URL; type: "oauth" | "oidc" }[] = [
		{ url: new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin), type: "oauth" },
		{ url: new URL(`/.well-known/openid-configuration${path}`, issuer.origin), type: "oidc" },
	];
	if (path) urls.push({ url: new URL(`${path}/.well-known/openid-configuration`, issuer.origin), type: "oidc" });
	return urls;
}

export async function discoverAuthorizationServerMetadata(
	authorizationServerUrl: string | URL,
	options: { fetch?: McpFetch; protocolVersion?: string; skipIssuerValidation?: boolean; signal?: AbortSignal } = {},
): Promise<AuthorizationServerMetadata | undefined> {
	const fetch = options.fetch ?? globalThis.fetch;
	for (const { url } of buildAuthorizationServerDiscoveryUrls(authorizationServerUrl)) {
		const response = await fetchMetadata(
			url,
			fetch,
			options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
			options.signal,
		);
		if (!response.ok) {
			discard(response);
			if (isDiscoveryMiss(response.status)) continue;
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		if (!options.skipIssuerValidation) {
			const expected = String(authorizationServerUrl);
			// Tolerate a trailing slash: several real issuers advertise one. The
			// RFC 9207 authorization-response iss check stays exact elsewhere.
			const trim = (value: string) => (value.endsWith("/") ? value.slice(0, -1) : value);
			if (trim(metadata.issuer) !== trim(expected)) throw new OAuthIssuerMismatchError(expected, metadata.issuer);
		}
		return metadata;
	}
	return undefined;
}
export async function discoverOAuthServerInfo(
	serverUrl: string | URL,
	options: {
		resourceMetadataUrl?: URL;
		/** Metadata document to use instead of discovery. It is trusted as configured, so its issuer is not checked. */
		authorizationServerMetadataUrl?: URL;
		/** Inline metadata; trusted as configured (takes precedence over URL fetch / discovery). */
		authorizationServerMetadata?: AuthorizationServerMetadata;
		fetch?: McpFetch;
		skipIssuerValidation?: boolean;
		signal?: AbortSignal;
	} = {},
): Promise<OAuthServerInfo> {
	let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
	try {
		resourceMetadata = await discoverProtectedResourceMetadata(serverUrl, {
			resourceMetadataUrl: options.resourceMetadataUrl,
			fetch: options.fetch,
			signal: options.signal,
		});
	} catch (error) {
		if (!(error instanceof MetadataNotFoundError)) throw error;
	}
	if (options.authorizationServerMetadata) {
		const metadata = options.authorizationServerMetadata;
		return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata };
	}
	if (options.authorizationServerMetadataUrl) {
		const url = options.authorizationServerMetadataUrl;
		const response = await fetchMetadata(
			url,
			options.fetch ?? globalThis.fetch,
			LATEST_PROTOCOL_VERSION,
			options.signal,
		);
		if (!response.ok) {
			discard(response);
			throw new Error(`HTTP ${response.status} loading authorization server metadata from ${url}`);
		}
		const metadata = parseAuthorizationServerMetadata(await response.json());
		return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata, resourceMetadata };
	}
	if (resourceMetadata && !resourceMetadata.authorization_servers?.length) {
		throw new Error("OAuth protected resource metadata does not name an authorization server");
	}
	const authorizationServerUrl = resourceMetadata?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
	return {
		authorizationServerUrl,
		authorizationServerMetadata: await discoverAuthorizationServerMetadata(authorizationServerUrl, {
			fetch: options.fetch,
			skipIssuerValidation: options.skipIssuerValidation,
			signal: options.signal,
		}),
		resourceMetadata,
	};
}

export function resourceUrlFromServerUrl(value: string | URL): URL {
	const url = new URL(value);
	url.hash = "";
	return url;
}

export function selectResource(serverUrl: string | URL, metadata?: OAuthProtectedResourceMetadata): string | undefined {
	if (!metadata) return undefined;
	const requested = resourceUrlFromServerUrl(serverUrl);
	const configured = new URL(metadata.resource);
	if (requested.origin !== configured.origin) {
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`;
	const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;
	if (!requestedPath.startsWith(configuredPath)) {
		throw new Error(`Protected resource ${metadata.resource} does not match MCP server ${requested}`);
	}
	return metadata.resource;
}
