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


export {
	MCP_CONNECTOR_CATALOG,
	PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL,
	PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID,
	PIZZA_GITHUB_OAUTH_AS_METADATA,
	type McpConnectorCatalogEntry,
} from "./catalog.js";

/** @deprecated Compatibility exports; use the marketplace catalog for new code. */
export {CONNECTORS_EXTENSION_ID,BUILTIN_MCP_CONNECTORS,createConnectorsExtension} from "./compat.js";
