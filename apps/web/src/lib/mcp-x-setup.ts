import { MCP_CONNECTOR_CATALOG, PIZZA_X_MCP_URL } from "@pizza/mcp-connector-catalog";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const x = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "x")!;

export function isLegacyXConnector(config: Record<string, unknown>): boolean {
	return config.command === "npx" && Array.isArray(config.args) && config.args.includes("@xdevplatform/xurl") &&
		config.args.includes("mcp") && config.args.includes(PIZZA_X_MCP_URL);
}

export function xMcpNeedsSetup(config: Record<string, unknown>): boolean {
	if (isLegacyXConnector(config)) return true;
	if (config.url !== PIZZA_X_MCP_URL) return false;
	if (record(config.headers) && Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization")) return false;
	const oauth = record(config.oauth) ? config.oauth : {};
	// Older public HTTP installs inherit Pizza's client ID from the runtime defaults.
	// An incomplete custom confidential client must not borrow the product ID.
	return (typeof oauth.clientId !== "string" || !oauth.clientId.trim()) &&
		typeof oauth.clientSecret === "string" && !!oauth.clientSecret.trim();
}

export function buildXMcpConfig(config: Record<string, unknown>, client: { clientId: string; clientSecret: string; callbackUrl: string }): Record<string, unknown> {
	const clientId = client.clientId.trim();
	if (!clientId) throw new Error("Enter the OAuth 2.0 Client ID from your X app's User authentication settings.");
	const callback = new URL(client.callbackUrl);
	if (callback.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) ||
		!callback.port || callback.search || callback.hash || callback.username || callback.password) {
		throw new Error("Use a registered HTTP loopback callback with an explicit port, without query or fragment.");
	}
	// Converting the former marketplace xurl entry is an explicit setup action.
	const { command: _command, args: _args, env: _env, cwd: _cwd, ...httpConfig } = config;
	const oauth: Record<string, unknown> = { ...(x.config.oauth as Record<string, unknown>), ...(record(config.oauth) ? config.oauth : {}), clientId, callbackUrl: callback.href };
	delete oauth.callbackPort;
	delete oauth.clientSecret;
	if (client.clientSecret.trim()) oauth.clientSecret = client.clientSecret.trim();
	return { ...x.config, ...httpConfig, url: PIZZA_X_MCP_URL, enabled: true, oauth };
}
