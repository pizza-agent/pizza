/** Backend connector policies. Generic MCP runtime has no provider-specific branches. */
import type { McpServerEntry } from "../mcp/config.js";
import type { McpOAuthConfig } from "../../core/mcp/servers.js";
import type { AuthProvider, McpTransport } from "../../core/mcp/index.js";
import { resolveHeadersOrThrow } from "../../core/config/resolve-config-value.js";
import {
	MCP_CONNECTOR_CATALOG,
	PIZZA_GMAIL_MCP_URL,
	PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID,
	PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL,
	PIZZA_GITHUB_OAUTH_AS_METADATA,
} from "./catalog.js";
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
		// A custom confidential app retains its own identity and chosen OAuth flow.
		if (def.name === "github") {
			if (configured?.clientId !== PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID) return configured;
			return {
				...configured,
				deviceAuthorizationUrl: configured.deviceAuthorizationUrl ?? PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL,
				scope: configured.scope ?? "repo read:user",
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
	...(def.config.adapter === "gmail"
		? {
				clientSecret: packagedGoogleDesktopClientSecret,
				transport(entry: McpServerEntry, auth?: AuthProvider) {
					const config = entry.config;
					if (!("url" in config)) throw Error("Adapter requires a resource URL");
					const headers = resolveHeadersOrThrow(config.headers, `MCP server "${entry.name}"`);
					const bearer = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
					return new GmailApiTransport(
						auth ?? (bearer?.startsWith("Bearer ") ? { token: async () => bearer.slice(7) } : undefined),
					);
				},
			}
		: {}),
}));
// Explicit compatibility entry; new connectors do not extend the MCP runtime.
policies.push({
	matches: (entry) => "url" in entry.config && entry.config.url === PIZZA_GMAIL_MCP_URL,
	oauth: (entry) => ({
		authServerMetadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
		authorizationParams: { access_type: "offline", prompt: "consent" },
		authCheck: { tool: "list_labels" },
		...("url" in entry.config ? entry.config.oauth : undefined),
	}),
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
