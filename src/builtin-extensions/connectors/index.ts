/**
 * Official MCP connector catalog (Notion, GitHub, Gmail, X).
 *
 * Connectors are marketplace-only: nothing is auto-registered via
 * `pizza.registerMcpServer()`. Users install from Plugins → MCPs → Marketplace
 * (`_agentcli server add`), which writes mcp.json so Installed entries get full
 * Remove / edit actions like any other user-managed server.
 *
 * The former `connectors` built-in extension no longer loads; catalog data lives
 * in `./catalog.ts` (shared with the web marketplace UI).
 */

import type { ExtensionFactory } from "../../core/extensions/types.js";
import type { McpServerConfig } from "../../core/mcp/servers.js";
import { MCP_CONNECTOR_CATALOG } from "./catalog.js";

export {
	MCP_CONNECTOR_CATALOG,
	PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL,
	PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID,
	PIZZA_GITHUB_OAUTH_AS_METADATA,
	type McpConnectorCatalogEntry,
} from "./catalog.js";

/** @deprecated Kept for tests / callers; the connectors extension is no longer registered. */
export const CONNECTORS_EXTENSION_ID = "connectors";

/** Catalog entries shaped for MCP server validation / install payloads. */
export const BUILTIN_MCP_CONNECTORS: ReadonlyArray<{ name: string; config: McpServerConfig }> =
	MCP_CONNECTOR_CATALOG.map((entry) => ({
		name: entry.name,
		config: entry.config as unknown as McpServerConfig,
	}));

/**
 * No-op factory kept so older imports / disabled-id lists do not break.
 * Official connectors are installed from the marketplace into mcp.json instead.
 */
export const createConnectorsExtension: ExtensionFactory = () => {
	// Intentionally empty — do not call pizza.registerMcpServer().
};
