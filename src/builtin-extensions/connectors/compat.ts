import type { ExtensionFactory } from "../../core/extensions/types.js";
import type { McpServerConfig } from "../../core/mcp/servers.js";
import { MCP_CONNECTOR_CATALOG } from "./catalog.js";

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
