/** Provider configuration UI descriptors; rendering does not branch on provider names. */
import { MCP_CONNECTOR_CATALOG } from "@pizza/mcp-connector-catalog";
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
export function oauthSetupDefinition(id: string): SetupDefinition {
	const def = entries[id];
	if (!def) throw Error(`Unknown OAuth setup provider: ${id}`);
	return def;
}
export function requiredOAuthSetup(config: Record<string, unknown>): string | undefined {
	return Object.keys(entries).find((id) => entries[id].needsSetup(config));
}
