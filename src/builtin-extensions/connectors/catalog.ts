/**
 * Official MCP marketplace catalog (Notion, GitHub, Gmail, X).
 *
 * Single source of truth for installable connectors. Entries are NOT auto-registered
 * into a session — they appear under Plugins → MCPs → Marketplace until the user
 * installs one (`_agentcli server add` / UI Install), which writes mcp.json and
 * makes Remove available like any other user-managed server.
 *
 * Skipped (no third-party public MCP for Pizza):
 * - Cursor Origin (`api.origin.cursor.com`) — Cursor-hosted only
 * - Finance / Plaid Cursor plugin — Cursor-hosted only
 */

export interface McpConnectorCatalogEntry {
	name: string;
	/** Short card blurb for the marketplace UI. */
	description: string;
	/** Transport hint for the card badge. */
	type: "http" | "stdio";
	/** Config payload for `server add <name> --config …`. */
	config: Record<string, unknown>;
	/** Optional docs / homepage. */
	docsUrl?: string;
	/** Providers whose OAuth client must be configured before first sign-in. */
	oauthSetup?: "google" | "x";
}

/**
 * Pizza product GitHub OAuth App client id (public native client via Device Flow).
 * Baked into the app so end users never configure clientId/secret.
 * Do not ship a clientSecret. GitHub authorization-code + PKCE still requires one;
 * the native client uses RFC 8628 instead. Enable Device Flow in the OAuth App settings.
 */
export const PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID = "Ov23liOMOJRUwOb2ulTH";
export const PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL = "https://github.com/login/device/code";

/** Loopback callback registered on the Pizza GitHub OAuth App (any port allowed by GitHub). */
export const PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL = "http://127.0.0.1/callback";
export const PIZZA_GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
export const PIZZA_GMAIL_API_MCP_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Public desktop client identifier; no Web client secret is shipped. */
export const PIZZA_GMAIL_DESKTOP_CLIENT_ID = "509874026147-a4b12qhk6rsqma5vqo96qk8b5f7vgr51.apps.googleusercontent.com";
export const PIZZA_GMAIL_MCP_OAUTH_CALLBACK_URL = "http://127.0.0.1:8765/callback";
export const PIZZA_GMAIL_MCP_SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
export const PIZZA_X_MCP_URL = "https://api.x.com/mcp";
/** Pizza's Native/Public X application. This identifier is public; no client secret is distributed. */
export const PIZZA_X_MCP_OAUTH_CLIENT_ID = "SkkxeTJzMUZYcmhLd2daa201Y3E6MTpjaQ";
export const PIZZA_X_MCP_OAUTH_CALLBACK_URL = "http://127.0.0.1:8766/callback";
export const PIZZA_X_MCP_SCOPE = "tweet.read users.read offline.access";

/**
 * GitHub does not publish RFC 8414 AS metadata at well-known URLs. Bake the known
 * endpoints so login works without DCR / discovery. Authorization code + PKCE
 * requires a secret; the public native client uses the device grant instead.
 */
export const PIZZA_GITHUB_OAUTH_AS_METADATA = {
	issuer: "https://github.com/login/oauth",
	authorization_endpoint: "https://github.com/login/oauth/authorize",
	token_endpoint: "https://github.com/login/oauth/access_token",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
	token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
	code_challenge_methods_supported: ["S256"],
};

/** Official connectors shown in the MCP marketplace (not pre-installed). */
export const MCP_CONNECTOR_CATALOG: readonly McpConnectorCatalogEntry[] = [
	{
		name: "notion",
		type: "http",
		docsUrl: "https://developers.notion.com/docs/mcp",
		description: "Search your workspace, read pages, and create or update Notion content.",
		config: {
			url: "https://mcp.notion.com/mcp",
			oauth: { clientName: "Pizza", scope: "default" },
			description: "Search your workspace, read pages, and create or update Notion content.",
		},
	},
	{
		name: "github",
		type: "http",
		docsUrl: "https://github.com/github/github-mcp-server",
		description:
			"Explore repositories, manage issues, and work with pull requests and code reviews.",
		config: {
			url: "https://api.githubcopilot.com/mcp/",
			oauth: {
				clientId: PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID,
				deviceAuthorizationUrl: PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL,
				scope: "repo read:user",
				callbackUrl: PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL,
				authorizationServerMetadata: PIZZA_GITHUB_OAUTH_AS_METADATA,
			},
			description:
				"Explore repositories, manage issues, and work with pull requests and code reviews.",
		},
	},
	{
		name: "gmail",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/gmail/api/guides",
		description: "Search emails, read conversations, and prepare drafts and replies.",
		config: {
			url: PIZZA_GMAIL_API_MCP_URL,
			adapter: "gmail",
			oauth: {
				clientId: PIZZA_GMAIL_DESKTOP_CLIENT_ID,
				callbackUrl: "http://127.0.0.1/callback",
				scope: PIZZA_GMAIL_MCP_SCOPE,
				authServerMetadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
				authorizationParams: { access_type: "offline", prompt: "consent" },
				authCheck: { tool: "list_labels" },
			},
			description:
				"Search emails, read conversations, and prepare drafts and replies.",
		},
	},
	{
		name: "x",
		type: "http",
		docsUrl: "https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code",
		description: "Search posts and explore profiles on X.",
		config: {
			url: PIZZA_X_MCP_URL,
			oauth: {
				clientId: PIZZA_X_MCP_OAUTH_CLIENT_ID,
				// X rejects RFC 8707 on the browser endpoint; keep it on token requests.
				authorizationResourceIndicator: false,
				callbackUrl: PIZZA_X_MCP_OAUTH_CALLBACK_URL,
				scope: PIZZA_X_MCP_SCOPE,
				authServerMetadataUrl: "https://api.x.com/.well-known/oauth-authorization-server",
			},
			description: "Search posts and explore profiles on X.",
		},
	},
];
