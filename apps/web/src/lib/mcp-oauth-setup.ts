/** Provider configuration UI descriptors; rendering does not branch on provider names. */
import { MCP_CONNECTOR_CATALOG, registeredOAuthConnector } from "@pizza/mcp-connector-catalog";
import { buildGoogleMcpConfig, googleMcpNeedsSetup, parseGoogleOAuthClient } from "./mcp-google-setup";
import { buildXMcpConfig, xMcpNeedsSetup } from "./mcp-x-setup";
interface ClientFields {
	clientId: string;
	clientSecret: string;
	callbackUrl: string;
}
interface SetupDefinition {
	needsSetup(config: Record<string, unknown>): boolean;
	build(config: Record<string, unknown>, client: ClientFields): Record<string, unknown>;
	defaults: Record<string, unknown>;
	docsUrl?: string;
	secretRequired: boolean;
	importClient?: (text: string) => { clientId: string; clientSecret: string; callbackUrl?: string };
	text: (name: string) => string;
	secretLabel?: string;
}
const entries: Record<string, SetupDefinition> = {
	registered: {
		needsSetup: (config) => {
			if (!registeredOAuthConnector(config)) return false;
			if (record(config.headers) && Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization")) return false;
			const oauth = record(config.oauth) ? config.oauth : {};
			return !nonempty(oauth.clientId) || !nonempty(oauth.clientSecret) || !nonempty(oauth.callbackUrl);
		},
		build: (config, client) => {
			const entry = registeredOAuthConnector(config);
			if (!entry) throw new Error("This server does not use registered OAuth setup.");
			if (!client.clientId.trim() || !client.clientSecret.trim()) throw new Error("Enter the OAuth client ID and client secret from your service provider.");
			const callback = new URL(client.callbackUrl.trim());
			if (callback.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) ||
				!callback.port || callback.username || callback.password || callback.search || callback.hash) {
				throw new Error("Register an HTTP loopback callback with an explicit port and no query or fragment.");
			}
			const oauth = { ...(entry.config.oauth as Record<string, unknown>), ...(record(config.oauth) ? config.oauth : {}),
				clientId: client.clientId.trim(), clientSecret: client.clientSecret.trim(), callbackUrl: callback.href };
			delete (oauth as Record<string, unknown>).callbackPort;
			return { ...config, enabled: true, oauth };
		},
		defaults: { callbackUrl: "http://127.0.0.1:8767/callback" },
		secretRequired: true,
		text: (name) => `plugins.mcp.registered${name}`,
	},
	google: {
		needsSetup: googleMcpNeedsSetup,
		build: buildGoogleMcpConfig,
		defaults: { callbackUrl: "http://127.0.0.1:8765/callback" },
		docsUrl: MCP_CONNECTOR_CATALOG.find((e) => e.name === "gmail")?.docsUrl,
		secretRequired: true,
		importClient: parseGoogleOAuthClient,
		text: (name) =>
			`plugins.mcp.google${({ SetupApp: "SetupApis", SetupAccess: "SetupTestUsers" } as Record<string, string>)[name] ?? name}`,
	},
	x: {
		needsSetup: xMcpNeedsSetup,
		build: buildXMcpConfig,
		defaults: MCP_CONNECTOR_CATALOG.find((e) => e.name === "x")!.config.oauth as Record<string, unknown>,
		docsUrl: MCP_CONNECTOR_CATALOG.find((e) => e.name === "x")?.docsUrl,
		secretRequired: false,
		text: (name) => `plugins.mcp.x${name}`,
		secretLabel: "plugins.mcp.xClientSecret",
	},
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): boolean => typeof value === "string" && !!value.trim();
export function oauthSetupDefinition(id: string): SetupDefinition {
	const def = entries[id];
	if (!def) throw Error(`Unknown OAuth setup provider: ${id}`);
	return def;
}
export function requiredOAuthSetup(config: Record<string, unknown>): string | undefined {
	return Object.keys(entries).find((id) => entries[id].needsSetup(config));
}
