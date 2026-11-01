import { PIZZA_GMAIL_MCP_URL } from "@pizza/mcp-connector-catalog";

// Advanced setup for manually added Google-hosted preview MCPs. Marketplace Gmail uses the bundled desktop adapter.
const gmail = { config: { url: PIZZA_GMAIL_MCP_URL, oauth: {
 callbackUrl: "http://127.0.0.1:8765/callback",
 scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
 authServerMetadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
 authorizationParams: { access_type: "offline", prompt: "consent" }, authCheck: { tool: "list_labels" },
} } };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function loopbackCallback(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
			!!url.port && !url.search && !url.hash && !url.username && !url.password;
	} catch { return false; }
}

export function googleMcpNeedsSetup(config: Record<string, unknown>): boolean {
	if (config.url !== PIZZA_GMAIL_MCP_URL) return false;
	if (record(config.headers) && Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization")) return false;
	const oauth = record(config.oauth) ? config.oauth : {};
	return typeof oauth.clientId !== "string" || !oauth.clientId.trim() || typeof oauth.clientSecret !== "string" || !oauth.clientSecret.trim();
}

export function parseGoogleOAuthClient(text: string): { clientId: string; clientSecret: string; callbackUrl?: string } {
	const value: unknown = JSON.parse(text);
	if (!record(value) || !record(value.web)) throw new Error("Import a Google OAuth Web application client JSON file with the AI-agent option enabled.");
	const web = value.web;
	if (typeof web.client_id !== "string" || typeof web.client_secret !== "string" || !web.client_id || !web.client_secret) throw new Error("The client JSON is missing client_id or client_secret.");
	const redirects = Array.isArray(web.redirect_uris) ? web.redirect_uris : [];
	return { clientId: web.client_id, clientSecret: web.client_secret, callbackUrl: redirects.find((url): url is string => typeof url === "string" && loopbackCallback(url)) };
}

export function buildGoogleMcpConfig(config: Record<string, unknown>, client: { clientId: string; clientSecret: string; callbackUrl: string }): Record<string, unknown> {
	const clientId = client.clientId.trim();
	const clientSecret = client.clientSecret.trim();
	if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) throw new Error("Enter the Google OAuth client ID and client secret.");
	if (!loopbackCallback(client.callbackUrl)) throw new Error("Use an HTTP callback on localhost or 127.0.0.1 with an explicit port, without query or fragment.");
	const oauth = { ...(gmail.config.oauth as Record<string, unknown>), ...(record(config.oauth) ? config.oauth : {}), clientId, clientSecret, callbackUrl: client.callbackUrl };
	// The callback URL is the source of truth when editing an existing fixed-port client.
	delete (oauth as Record<string, unknown>).callbackPort;
	return { ...gmail.config, ...config, oauth };
}
