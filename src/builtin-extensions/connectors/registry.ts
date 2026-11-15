/** Backend connector policies. Generic MCP runtime has no provider-specific branches. */
import type { McpServerEntry } from "../mcp/config.js";
import type { McpOAuthConfig } from "../../core/mcp/servers.js";
import type { AuthProvider, McpTransport } from "../../core/mcp/index.js";
import { resolveHeadersOrThrow } from "../../core/config/resolve-config-value.js";
import {
	MCP_CONNECTOR_CATALOG,
	PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID,
	PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL,
	PIZZA_GITHUB_MCP_SCOPE,
	PIZZA_GITHUB_OAUTH_AS_METADATA,
	PIZZA_GOOGLE_BROKER_CLIENT_ID,
	PIZZA_GOOGLE_BROKER_ISSUER,
	PIZZA_GMAIL_DESKTOP_CLIENT_ID,
	googleWorkspaceConnector,
} from "./catalog.js";
import { googleApiService } from "./google-services.js";
import { GoogleApiTransport } from "./google-api.js";
import { GmailApiTransport } from "./gmail.js";
import { packagedGoogleDesktopClientSecret } from "./google-desktop-client.js";
interface ConnectorPolicy {
	matches(entry: McpServerEntry): boolean;
	oauth(entry: McpServerEntry): McpOAuthConfig | undefined;
	transport?(entry: McpServerEntry, auth?: AuthProvider): McpTransport;
	clientSecret?(clientId?: string): string | undefined;
}
const policies: ConnectorPolicy[] = MCP_CONNECTOR_CATALOG.map((def) => ({
	matches: (entry) =>
		"url" in entry.config &&
		entry.config.adapter === def.config.adapter &&
		(entry.config.url === def.config.url ||
			(def.name === "github" && new URL(entry.config.url).origin === new URL(String(def.config.url)).origin)),
	oauth(entry) {
		if (!("url" in entry.config)) return;
		const configured = entry.config.oauth,
			defaults = def.config.oauth as McpOAuthConfig;
		const api = googleApiService(entry.config);
		if (api) {
			const legacyGmail = api.product === "gmail" && configured?.clientId === PIZZA_GMAIL_DESKTOP_CLIENT_ID && !configured.clientSecret;
			if (configured?.clientId && configured.clientId !== PIZZA_GOOGLE_BROKER_CLIENT_ID && !legacyGmail) {
				return { ...defaults, ...configured, resourceIndicator: configured.resourceIndicator ?? false,
					resourceMetadataUrl: configured.resourceMetadataUrl?.startsWith(PIZZA_GOOGLE_BROKER_ISSUER) ? undefined : configured.resourceMetadataUrl,
					authServerMetadataUrl: configured.authServerMetadataUrl && !configured.authServerMetadataUrl.startsWith(PIZZA_GOOGLE_BROKER_ISSUER)
						? configured.authServerMetadataUrl : "https://accounts.google.com/.well-known/openid-configuration",
					authorizationParams: { access_type: "offline", prompt: "consent", ...configured.authorizationParams } };
			}
			return { ...defaults, ...configured, clientId: PIZZA_GOOGLE_BROKER_CLIENT_ID, clientSecret: undefined,
				requireSignIn: true, resourceIndicator: true, authServerMetadataUrl: defaults.authServerMetadataUrl, resourceMetadataUrl: defaults.resourceMetadataUrl,
				authorizationServerMetadata: undefined, authorizationParams: undefined };
		}
		// A custom confidential app retains its own identity and chosen OAuth flow.
		if (def.name === "github") {
			if (configured?.clientId !== PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID) return configured;
			return {
				...configured,
				deviceAuthorizationUrl: configured.deviceAuthorizationUrl ?? PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL,
				scope: configured.scope ?? PIZZA_GITHUB_MCP_SCOPE,
				authorizationServerMetadata: configured.authorizationServerMetadata ?? PIZZA_GITHUB_OAUTH_AS_METADATA,
			};
		}
		if (def.name !== "gmail" && def.name !== "x") return configured;
		const merged = {
			...defaults,
			...configured,
			authorizationParams: { ...defaults.authorizationParams, ...configured?.authorizationParams },
		};
		if (def.name === "x")
			merged.clientId = configured?.clientSecret?.trim()
				? configured.clientId
				: configured?.clientId?.trim() || defaults.clientId;
		return merged;
	},
	...(googleApiService(def.config)
		? {
				clientSecret: (clientId?: string) => clientId === PIZZA_GOOGLE_BROKER_CLIENT_ID ? undefined : packagedGoogleDesktopClientSecret(clientId),
				transport(entry: McpServerEntry, auth?: AuthProvider) {
					const config = entry.config;
					if (!("url" in config)) throw Error("Adapter requires a resource URL");
					const headers = resolveHeadersOrThrow(config.headers, `MCP server "${entry.name}"`);
					const bearer = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
					const provider = auth ?? (bearer?.startsWith("Bearer ") ? { token: async () => bearer.slice(7) } : undefined);
					const service = googleApiService(config)!;
					return service.product === "gmail" ? new GmailApiTransport(provider) : new GoogleApiTransport(service.product, provider);
				},
			}
		: {}),
}));
// Explicit compatibility entry; new connectors do not extend the MCP runtime.
policies.push({
	matches: entry => "url" in entry.config && !!googleWorkspaceConnector(entry.config),
	oauth(entry) {
		if (!("url" in entry.config)) return;
		const direct = googleWorkspaceConnector(entry.config)!.config.oauth as McpOAuthConfig;
		const configured = entry.config.oauth;
		if (configured?.clientId && configured.clientId !== PIZZA_GOOGLE_BROKER_CLIENT_ID) return { ...direct, ...configured };
		return { ...direct, ...configured, clientId: PIZZA_GOOGLE_BROKER_CLIENT_ID, resourceIndicator: true, authorizationParams: undefined,
			authServerMetadataUrl: `${PIZZA_GOOGLE_BROKER_ISSUER}/.well-known/oauth-authorization-server` };
	},
});
export function resolveConnectorOAuth(entry: McpServerEntry): McpOAuthConfig | undefined {
	return (
		policies.find((p) => p.matches(entry))?.oauth(entry) ?? ("url" in entry.config ? entry.config.oauth : undefined)
	);
}
export function connectorClientSecret(entry: McpServerEntry, clientId?: string) {
	return policies.find((p) => p.matches(entry))?.clientSecret?.(clientId);
}
export function createConnectorTransport(entry: McpServerEntry, auth?: AuthProvider): McpTransport | undefined {
	if ("url" in entry.config && entry.config.adapter && !policies.some((p) => p.matches(entry) && p.transport))
		throw Error("Invalid adapter resource URL");
	return policies.find((p) => p.matches(entry))?.transport?.(entry, auth);
}
