/**
 * MCP marketplace / directory catalog shown under Plugins → MCPs.
 *
 * Sourced from `src/builtin-extensions/connectors/catalog.ts` (single source of
 * truth). Official connectors are marketplace-only until the user installs one
 * via `_agentcli server add --config` / the Install button — nothing is
 * pre-registered by a built-in extension.
 */

import {
	MCP_CONNECTOR_CATALOG,
	type McpConnectorCatalogEntry,
} from "@pizza/mcp-connector-catalog";

export type McpCatalogEntry = McpConnectorCatalogEntry & { builtin: true };

export const MCP_MARKETPLACE_CATALOG: readonly McpCatalogEntry[] = MCP_CONNECTOR_CATALOG.map(
	(entry) => ({ ...entry, builtin: true as const }),
);
