import { describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import { McpOAuthCredentialStore, McpServerConnection } from "../src/builtin-extensions/mcp/runtime.js";
import { createInMemoryTransportPair } from "../src/core/mcp/testing/index.js";
import { validateMcpServerConfig } from "../src/core/mcp/servers.js";

describe("Authenticated services with public tool discovery", () => {
	it.each([true, false])("requires a token only when configured (requireSignIn=%s)", async (requireSignIn) => {
		const pair = createInMemoryTransportPair();
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			const result = message.method === "initialize"
				? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "public-schema", version: "1" } }
				: { tools: [{ name: "read_doc", inputSchema: { type: "object" } }] };
			void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
		});
		await pair.server.start();
		const url = "https://docs.example/mcp";
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const createTransport = vi.fn(() => pair.client);
		const connection = new McpServerConnection({ entry: { name: "docs", source: "global", config: { url, oauth: { requireSignIn } } },
			cwd: process.cwd(), credentials, createTransport, onTools: () => {},
		});
		try {
			if (requireSignIn) {
				await expect(connection.getClient()).rejects.toThrow("requires sign-in");
				expect(connection.state).toBe("needs-auth");
				expect(createTransport).not.toHaveBeenCalled();
				await credentials.forServer("docs", url).save({ serverUrl: url,
					clientInformation: { client_id: "fixture-client" },
					credentialBinding: { issuer: "https://issuer.example", clientId: "fixture-client", resource: url },
					tokens: { access_token: "fixture-authorized", token_type: "Bearer" },
				});
			}
			await connection.getClient();
			expect(connection.state).toBe("connected");
			expect(connection.tools.map((tool) => tool.name)).toEqual(["read_doc"]);
		} finally { await connection.close(); await pair.server.close(); }
	});
	it("rejects a non-boolean authentication requirement", () => {
		expect(validateMcpServerConfig("docs", { url: "https://docs.example/mcp", oauth: { requireSignIn: "true" } })).toContain("must be a boolean");
	});
	it("does not report a schema-only connection as usable when the authenticated read check is denied", async () => {
		const pair = createInMemoryTransportPair();
		pair.server.onMessage(message => {
			if (!("id" in message) || !("method" in message)) return;
			const result = message.method === "initialize"
				? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "preview", version: "1" } }
				: message.method === "tools/list" ? { tools: [{ name: "list_recent_files", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }] }
				: { isError: true, content: [{ type: "text", text: "The caller does not have permission" }] };
			void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
		});
		await pair.server.start();
		const url = "https://drivemcp.googleapis.com/mcp/v1";
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await credentials.forServer("drive", url).save({ serverUrl: url,
			credentialBinding: { issuer: "https://pizza.hertzbeat.com/oauth/google", clientId: "pizza-desktop-google", resource: url },
			tokens: { access_token: "fixture-authorized", token_type: "Bearer" },
		});
		const connection = new McpServerConnection({ entry: { name: "drive", source: "global", config: { url } }, cwd: process.cwd(), credentials,
			createTransport: () => pair.client, onTools: () => {} });
		try {
			await expect(connection.getClient()).rejects.toThrow("The caller does not have permission");
			expect(connection.state).toBe("failed");
			expect(connection.tools).toEqual([]);
		} finally { await connection.close(); await pair.server.close(); }
	});
});
