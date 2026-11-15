import { googleApiCatalogEntries, LEGACY_GOOGLE_WORKSPACE_RESOURCES } from "./google-services.js";
export { GOOGLE_API_SERVICES, PIZZA_GOOGLE_BROKER_ISSUER, PIZZA_GOOGLE_BROKER_CLIENT_ID, googleApiService, googleApiServiceForResource } from "./google-services.js";

/**
 * Official OAuth MCP marketplace catalog.
 *
 * Single source of truth for installable connectors. Entries are NOT auto-registered
 * into a session. They appear under Apps → App directory until the user connects
 * one (`_agentcli server add` / UI Connect), which writes mcp.json and
 * makes Remove available like any other user-managed connection.
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
	/** Account, plan, region, or app-registration requirements shown before connecting. */
	connectionNote?: string;
	/** Providers whose OAuth client must be configured before first sign-in. */
	oauthSetup?: string;
}

/**
 * Pizza product GitHub OAuth App client id (public native client via Device Flow).
 * Baked into the app so end users never configure clientId/secret.
 * Do not ship a clientSecret. GitHub authorization-code + PKCE still requires one;
 * the native client uses RFC 8628 instead. Enable Device Flow in the OAuth App settings.
 */
export const PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID = "Ov23liOMOJRUwOb2ulTH";
export const PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL = "https://github.com/login/device/code";
/** Device-issued expiring tokens refresh without distributing a confidential client secret. */
export const PIZZA_GITHUB_MCP_SCOPE = "repo read:user offline_access";

/** Loopback callback registered on the Pizza GitHub OAuth App (any port allowed by GitHub). */
export const PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL = "http://127.0.0.1/callback";
export const PIZZA_GMAIL_MCP_URL = "https://gmailmcp.googleapis.com/mcp/v1";
export const PIZZA_GMAIL_API_MCP_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Public desktop client identifier; no Web client secret is shipped. */
export const PIZZA_GMAIL_DESKTOP_CLIENT_ID = "509874026147-a4b12qhk6rsqma5vqo96qk8b5f7vgr51.apps.googleusercontent.com";
export const PIZZA_GMAIL_MCP_OAUTH_CALLBACK_URL = "http://127.0.0.1:8765/callback";
export const PIZZA_GMAIL_MCP_SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
export const PIZZA_X_MCP_URL = "https://api.x.com/mcp";
/** Retired public X client id: X now rejects it as a confidential app. Kept to route stale installs into setup. */
export const PIZZA_X_MCP_OAUTH_CLIENT_ID = "SkkxeTJzMUZYcmhLd2daa201Y3E6MTpjaQ";
export const PIZZA_X_MCP_OAUTH_CALLBACK_URL = "http://127.0.0.1:8766/callback";
export const PIZZA_X_MCP_SCOPE = "tweet.read users.read offline.access";

/** Resource → config for legacy Google Workspace MCP preview entries; url/scope source of truth is google-services (broker reads it too). */
const legacyWorkspace = (url: keyof typeof LEGACY_GOOGLE_WORKSPACE_RESOURCES, extra?: Record<string, unknown>) => ({
	url,
	oauth: { clientName: "Pizza", resourceIndicator: false, requireSignIn: true,
		scope: LEGACY_GOOGLE_WORKSPACE_RESOURCES[url].join(" "),
		authServerMetadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
		authorizationParams: { access_type: "offline", prompt: "consent" }, ...extra },
});

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
const catalog: readonly McpConnectorCatalogEntry[] = [
	{
		name: "notion",
		type: "http",
		docsUrl: "https://developers.notion.com/docs/mcp",
		description: "Search your workspace, read pages, and create or update Notion content.",
		config: {
			url: "https://mcp.notion.com/mcp",
			oauth: { clientName: "Pizza", scope: "default" },
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
				scope: PIZZA_GITHUB_MCP_SCOPE,
				callbackUrl: PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL,
				authorizationServerMetadata: PIZZA_GITHUB_OAUTH_AS_METADATA,
			},
		},
	},
	{
		name: "x",
		type: "http",
		docsUrl: "https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code",
		description: "Search posts and explore profiles on X.",
		oauthSetup: "x",
		config: {
			url: PIZZA_X_MCP_URL,
			oauth: {
				// X rejects RFC 8707 on the browser endpoint; keep it on token requests.
				authorizationResourceIndicator: false,
				callbackUrl: PIZZA_X_MCP_OAUTH_CALLBACK_URL,
				scope: PIZZA_X_MCP_SCOPE,
				authServerMetadataUrl: "https://api.x.com/.well-known/oauth-authorization-server",
			},
		},
	},
	{
		name: "linear",
		type: "http",
		docsUrl: "https://linear.app/docs/mcp",
		description: "Search issues, manage projects, and track your team’s work in Linear.",
		config: { url: "https://mcp.linear.app/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "atlassian",
		type: "http",
		docsUrl: "https://github.com/atlassian/atlassian-mcp-server",
		description: "Search Jira and Confluence, manage issues, and work with team knowledge.",
		connectionNote: "Your Atlassian administrator may need to allow this connection.",
		config: { url: "https://mcp.atlassian.com/v2/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "gitlab",
		type: "http",
		docsUrl: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
		description: "Explore GitLab projects, issues, merge requests, and pipelines.",
		connectionNote: "Enable the MCP server for your GitLab group first. Edit the URL to connect a self-managed instance.",
		config: { url: "https://gitlab.com/api/v4/mcp", oauth: {"clientName": "Pizza", "scope": "mcp"} },
	},
	{
		name: "sentry",
		type: "http",
		docsUrl: "https://mcp.sentry.dev/",
		description: "Investigate errors, inspect events, and manage Sentry issues and alerts.",
		config: { url: "https://mcp.sentry.dev/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "cloudflare",
		type: "http",
		docsUrl: "https://github.com/cloudflare/mcp",
		description: "Manage Cloudflare resources, inspect configuration, and troubleshoot deployments.",
		connectionNote: "Choose accounts and permissions when signing in. Additional actions may request more permissions.",
		config: { url: "https://mcp.cloudflare.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "vercel",
		type: "http",
		docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
		description: "Explore projects, inspect deployment logs, and manage Vercel deployments.",
		config: { url: "https://mcp.vercel.com", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "netlify",
		type: "http",
		docsUrl: "https://docs.netlify.com/build/build-with-ai/agent-setup-guides/agent-setup-overview/",
		description: "Manage Netlify projects, deployments, and site configuration.",
		config: { url: "https://mcp.netlify.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "supabase",
		type: "http",
		docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
		description: "Explore Supabase projects, query databases, and manage development resources.",
		connectionNote: "Choose the organization during sign-in. You can restrict the server URL to a project or read-only access.",
		config: { url: "https://mcp.supabase.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "neon",
		type: "http",
		docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
		description: "Query Postgres, inspect schemas, and manage Neon projects and branches.",
		connectionNote: "Choose permissions when signing in. Project and read-only restrictions are available in the server URL.",
		config: { url: "https://mcp.neon.tech/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "stripe",
		type: "http",
		docsUrl: "https://docs.stripe.com/mcp",
		description: "Explore Stripe customers, payments, invoices, and billing resources.",
		config: { url: "https://mcp.stripe.com", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "todoist",
		type: "http",
		docsUrl: "https://developer.todoist.com/api/v1/#tag/Todoist-MCP",
		description: "Plan projects, find tasks, and manage your Todoist work.",
		config: { url: "https://ai.todoist.net/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "airtable",
		type: "http",
		docsUrl: "https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server",
		description: "Search bases, read and update records, and work with Airtable schemas.",
		connectionNote: "Choose which bases to share during sign-in. Your organization may require administrator approval.",
		config: { url: "https://mcp.airtable.com/mcp", oauth: {"clientName": "Pizza", "clientRegistration": "dcr"} },
	},
	{
		name: "monday",
		type: "http",
		docsUrl: "https://developer.monday.com/api-reference/docs/mcp-dynamic-client-registration",
		description: "Work with monday.com boards, items, projects, and team workflows.",
		connectionNote: "Your account administrator must approve Pizza and its callback address before the first connection.",
		config: { url: "https://mcp.monday.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "clickup",
		type: "http",
		docsUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
		description: "Search ClickUp tasks and docs, manage projects, and track time.",
		config: { url: "https://mcp.clickup.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "intercom",
		type: "http",
		docsUrl: "https://developers.intercom.com/docs/guides/mcp",
		description: "Find customer conversations, contacts, companies, and help articles in Intercom.",
		connectionNote: "For US-hosted workspaces. Use Intercom EU for an EU-hosted workspace.",
		config: { url: "https://mcp.intercom.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "intercom-eu",
		type: "http",
		docsUrl: "https://www.intercom.com/help/en/articles/11461635-add-mcp-connectors-for-popular-apps-or-custom-mcps",
		description: "Connect conversations, contacts, and help content from an Intercom EU workspace.",
		connectionNote: "For EU-hosted workspaces. AU-hosted workspaces are not supported by the official server yet.",
		config: { url: "https://mcp.eu.intercom.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "amplitude",
		type: "http",
		docsUrl: "https://amplitude.com/docs/amplitude-ai/amplitude-mcp",
		description: "Analyze product usage and work with Amplitude charts, dashboards, and experiments.",
		connectionNote: "For US-hosted organizations. Use Amplitude EU for EU data residency.",
		config: { url: "https://mcp.amplitude.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "amplitude-eu",
		type: "http",
		docsUrl: "https://www.amplitude.com/docs/amplitude-ai/amplitude-mcp/other-clients",
		description: "Analyze product usage and manage content in an Amplitude EU organization.",
		connectionNote: "For organizations using EU data residency.",
		config: { url: "https://mcp.eu.amplitude.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "posthog",
		type: "http",
		docsUrl: "https://posthog.com/docs/model-context-protocol/vscode",
		description: "Query analytics, investigate errors, and manage PostHog feature flags and experiments.",
		connectionNote: "Sign-in automatically selects your US or EU data region.",
		config: { url: "https://mcp.posthog.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "webflow",
		type: "http",
		docsUrl: "https://developers.webflow.com/mcp/reference/getting-started",
		description: "Manage Webflow sites, CMS content, and design workflows.",
		connectionNote: "Choose sites during sign-in. Designer tools also need the Webflow companion app open.",
		config: { url: "https://mcp.webflow.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "asana",
		type: "http",
		docsUrl: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
		description: "Find Asana tasks, manage projects, and coordinate team work.",
		connectionNote: "Create an MCP OAuth app in the Asana developer console and register the callback address first.",
		oauthSetup: "registered",
		config: { url: "https://mcp.asana.com/v2/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "hubspot",
		type: "http",
		docsUrl: "https://developers.hubspot.com/ai-tools/mcp",
		description: "Explore HubSpot contacts, companies, deals, and customer activity.",
		connectionNote: "Create an MCP connector in HubSpot Development and register the callback address first.",
		oauthSetup: "registered",
		config: { url: "https://mcp.hubspot.com", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "slack",
		type: "http",
		docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
		description: "Search Slack conversations, read channels, and work with messages and canvases.",
		connectionNote: "Requires your own internal or Marketplace-published Slack app and any workspace administrator approval.",
		oauthSetup: "registered",
		config: { url: "https://mcp.slack.com/mcp", oauth: { clientName: "Pizza", authServerMetadataUrl: "https://mcp.slack.com/.well-known/oauth-authorization-server" } },
	},
	{
		name: "box",
		type: "http",
		docsUrl: "https://developer.box.com/guides/box-mcp/setup",
		description: "Search Box files and folders and use your organization’s Box AI tools.",
		connectionNote: "Requires Box Business or above. Create integration credentials and enable the connection in the Box Admin Console.",
		oauthSetup: "registered",
		// Box's PRM names an issuer with a trailing slash, while its AS document omits it.
		// Pin the official document explicitly; retain exact issuer checks in generic discovery.
		config: { url: "https://mcp.box.com", oauth: { clientName: "Pizza", authServerMetadataUrl: "https://api.box.com/.well-known/oauth-authorization-server" } },
	},
	{
		name: "dropbox",
		type: "http",
		docsUrl: "https://help.dropbox.com/integrations/connect-dropbox-mcp-server",
		description: "Search and organize Dropbox files and folders.",
		connectionNote: "Pizza needs your own Dropbox app credentials. Automatic registration is limited to Dropbox-approved clients.",
		oauthSetup: "registered",
		config: { url: "https://mcp.dropbox.com/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "canva",
		type: "http",
		docsUrl: "https://www.canva.dev/docs/apps/mcp/access/",
		description: "Search, create, edit, and export Canva designs and assets.",
		connectionNote: "Create an app in the Canva Developer Portal, enable Canva MCP, and register the callback address first.",
		oauthSetup: "registered",
		config: { url: "https://api.canva.com/connect/v1/mcp", oauth: {"clientName": "Pizza"} },
	},
	{
		name: "zoom",
		type: "http",
		docsUrl: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
		description: "Search Zoom meetings, recordings, documents, and AI Companion content.",
		connectionNote: "Create a Zoom General OAuth app with this product’s scopes and registered callback. Required product licenses and administrator approval depend on your account.",
		oauthSetup: "registered",
		config: { url: "https://mcp.zoom.us/mcp/zoom/streamable", oauth: { clientName: "Pizza" } },
	},
	{
		name: "zoom-meetings",
		type: "http",
		docsUrl: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
		description: "Search meetings and retrieve meeting assets and recordings.",
		connectionNote: "Create a Zoom General OAuth app with this product’s scopes and registered callback. Required product licenses and administrator approval depend on your account.",
		oauthSetup: "registered",
		config: { url: "https://mcp.zoom.us/mcp/meeting/streamable", oauth: { clientName: "Pizza" } },
	},
	{
		name: "zoom-docs",
		type: "http",
		docsUrl: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
		description: "Read and edit Zoom Docs and manage document collaboration.",
		connectionNote: "Create a Zoom General OAuth app with this product’s scopes and registered callback. Required product licenses and administrator approval depend on your account.",
		oauthSetup: "registered",
		config: { url: "https://mcp.zoom.us/mcp/canvas/streamable", oauth: { clientName: "Pizza" } },
	},
	{
		name: "zoom-chat",
		type: "http",
		docsUrl: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
		description: "Search Zoom Team Chat, read channels, and work with messages.",
		connectionNote: "Create a Zoom General OAuth app with this product’s scopes and registered callback. Required product licenses and administrator approval depend on your account.",
		oauthSetup: "registered",
		config: { url: "https://mcp.zoom.us/mcp/chat/streamable", oauth: { clientName: "Pizza" } },
	},
	{
		name: "zoom-tasks",
		type: "http",
		docsUrl: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
		description: "Find and manage Zoom tasks, steps, comments, and collaborators.",
		connectionNote: "Create a Zoom General OAuth app with this product’s scopes and registered callback. Required product licenses and administrator approval depend on your account.",
		oauthSetup: "registered",
		config: { url: "https://mcp.zoom.us/mcp/tasks/streamable", oauth: { clientName: "Pizza" } },
	},
	{
		name: "zoom-whiteboard",
		type: "http",
		docsUrl: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
		description: "Read and manage Zoom whiteboards and collaboration.",
		connectionNote: "Create a Zoom General OAuth app with this product’s scopes and registered callback. Required product licenses and administrator approval depend on your account.",
		oauthSetup: "registered",
		config: { url: "https://mcp.zoom.us/mcp/whiteboard/streamable", oauth: { clientName: "Pizza" } },
	},
	{
		name: "zoom-revenue",
		type: "http",
		docsUrl: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
		description: "Inspect Zoom Revenue Accelerator conversations, deals, and sales insights.",
		connectionNote: "Create a Zoom General OAuth app with this product’s scopes and registered callback. Required product licenses and administrator approval depend on your account.",
		oauthSetup: "registered",
		config: { url: "https://mcp.zoom.us/mcp/revenue_accelerator/streamable", oauth: { clientName: "Pizza" } },
	},
	{
		name: "gmail-workspace",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		description: "Use the official Google Workspace Gmail MCP preview for mail and drafts.",
		connectionNote: "Developer Preview: enable the product API and MCP API in an eligible Google Cloud project. Create a Web OAuth client with the AI-powered agent option and register the callback. This differs from the regular Gmail adapter.",
		oauthSetup: "google",
		config: legacyWorkspace("https://gmailmcp.googleapis.com/mcp/v1", { authCheck: { tool: "list_labels" } }),
	},
	{
		name: "google-drive",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		description: "Search Google Drive files and work with documents through the official MCP preview.",
		connectionNote: "Developer Preview: enable the product API and MCP API in an eligible Google Cloud project. Create a Web OAuth client with the AI-powered agent option and register the callback. This differs from the regular Gmail adapter.",
		oauthSetup: "google",
		config: legacyWorkspace("https://drivemcp.googleapis.com/mcp/v1", { authCheck: { tool: "list_recent_files", arguments: { pageSize: 1, excludeContentSnippets: true } } }),
	},
	{
		name: "google-docs",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		description: "Read and edit Google Docs through the official Workspace MCP preview.",
		connectionNote: "Developer Preview: enable the product API and MCP API in an eligible Google Cloud project. Create a Web OAuth client with the AI-powered agent option and register the callback. This differs from the regular Gmail adapter.",
		oauthSetup: "google",
		config: legacyWorkspace("https://docsmcp.googleapis.com/mcp/v1"),
	},
	{
		name: "google-sheets",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		description: "Read and edit spreadsheet data through the official Google Sheets MCP preview.",
		connectionNote: "Developer Preview: enable the product API and MCP API in an eligible Google Cloud project. Create a Web OAuth client with the AI-powered agent option and register the callback. This differs from the regular Gmail adapter.",
		oauthSetup: "google",
		config: legacyWorkspace("https://sheetsmcp.googleapis.com/mcp/v1"),
	},
	{
		name: "google-slides",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		description: "Read and update presentations through the official Google Slides MCP preview.",
		connectionNote: "Developer Preview: enable the product API and MCP API in an eligible Google Cloud project. Create a Web OAuth client with the AI-powered agent option and register the callback. This differs from the regular Gmail adapter.",
		oauthSetup: "google",
		config: legacyWorkspace("https://slidesmcp.googleapis.com/mcp/v1"),
	},
	{
		name: "google-calendar",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		description: "Find calendars, inspect availability, and read events through the official MCP preview.",
		connectionNote: "Developer Preview: enable the product API and MCP API in an eligible Google Cloud project. Create a Web OAuth client with the AI-powered agent option and register the callback. This differs from the regular Gmail adapter.",
		oauthSetup: "google",
		config: legacyWorkspace("https://calendarmcp.googleapis.com/mcp/v1"),
	},
	{
		name: "google-chat",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		description: "Search Google Chat conversations and work with messages through the official MCP preview.",
		connectionNote: "Developer Preview: enable the product API and MCP API in an eligible Google Cloud project. Create a Web OAuth client with the AI-powered agent option and register the callback. This differs from the regular Gmail adapter.",
		oauthSetup: "google",
		config: legacyWorkspace("https://chatmcp.googleapis.com/mcp/v1"),
	},
	{
		name: "google-people",
		type: "http",
		docsUrl: "https://developers.google.com/workspace/guides/configure-mcp-servers",
		description: "Look up your Google profile, contacts, and directory through the official MCP preview.",
		connectionNote: "Developer Preview: enable the product API and MCP API in an eligible Google Cloud project. Create a Web OAuth client with the AI-powered agent option and register the callback. This differs from the regular Gmail adapter.",
		oauthSetup: "google",
		config: legacyWorkspace("https://people.googleapis.com/mcp/v1"),
	},
];

/** Kept only for saved remote configurations and their existing refresh bindings. Not marketplace entries. */
export const LEGACY_GOOGLE_WORKSPACE_CONNECTORS = catalog.filter(entry => entry.oauthSetup === "google");

/** Stable Google API adapters replace the preview-only marketplace entries. Legacy profiles remain available for saved configurations. */
export const MCP_CONNECTOR_CATALOG: readonly McpConnectorCatalogEntry[] = [
	...catalog.filter(entry => entry.oauthSetup !== "google").map(entry => ({ ...entry, config: { ...entry.config, description: entry.description } })),
	...googleApiCatalogEntries(),
];

/** Match the actual resource, so renamed servers keep setup and unrelated names do not inherit it. */
export function registeredOAuthConnector(config: Record<string, unknown>): McpConnectorCatalogEntry | undefined {
	if (typeof config.url !== "string" || !URL.canParse(config.url)) return undefined;
	const url = new URL(config.url).href;
	return MCP_CONNECTOR_CATALOG.find((entry) => entry.oauthSetup === "registered" &&
		new URL(String(entry.config.url)).href === url && entry.config.adapter === config.adapter);
}

/** Official Workspace preview resources require a developer-registered AI-agent client. */
export function googleWorkspaceConnector(config: { url?: unknown; adapter?: unknown }): McpConnectorCatalogEntry | undefined {
	if (typeof config.url !== "string" || !URL.canParse(config.url)) return undefined;
	const url = new URL(config.url).href;
	// Raw direct-Google defaults remain available for advanced users' existing Web registrations.
	return catalog.find((entry) => entry.oauthSetup === "google" && new URL(String(entry.config.url)).href === url && !config.adapter);
}
