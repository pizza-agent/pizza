import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { InMemoryAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import { createDefaultTransport, McpOAuthCredentialStore, McpServerConnection } from "../src/builtin-extensions/mcp/runtime.js";
import { signInMcpServer } from "../src/builtin-extensions/mcp/oauth.js";
import { addMcpServerConfig } from "../src/builtin-extensions/mcp/config.js";
import { MemoryOAuthStateStore, startAuthorization } from "../src/core/mcp/oauth/index.js";
import { validateMcpServerConfig } from "../src/core/mcp/servers.js";
import { MCP_CONNECTOR_CATALOG, PIZZA_GMAIL_API_MCP_URL, PIZZA_GMAIL_MCP_URL } from "../src/builtin-extensions/connectors/catalog.js";

const gmail = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "gmail")!.config;
// Callback fixtures must stay local even when another suite configures a system proxy.
let previousDispatcher: Dispatcher;
let directDispatcher: Agent;
beforeEach(() => {
	previousDispatcher = getGlobalDispatcher();
	directDispatcher = new Agent();
	setGlobalDispatcher(directDispatcher);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	setGlobalDispatcher(previousDispatcher);
	await directDispatcher.close();
});

describe("Gmail MCP authorization", () => {
	it("restricts a Google client secret to the owner's configuration file, including existing files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pizza-google-client-"));
		const path = join(dir, "mcp.json");
		try {
			writeFileSync(path, "{}", { mode: 0o644 });
			addMcpServerConfig(path, "gmail", { url: PIZZA_GMAIL_MCP_URL, oauth: { clientId: "test.apps.googleusercontent.com", clientSecret: "fixture-secret" } });
			if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it("does not mistake public initialize/tools-list endpoints for an authorized mailbox", async () => {
		let currentToken = "token-one";
		let refreshes = 0;
		let rejection: string | undefined;
		const server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = Buffer.concat(chunks).toString();
			const reply = (value: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
			if (req.url === "/token") {
				const params = new URLSearchParams(body);
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("refresh_token")).toBe("google-refresh-token");
				expect(params.get("client_secret")).toBe("fixture-secret");
				refreshes++;
				reply({ access_token: currentToken, token_type: "bearer", expires_in: 3600 });
				return;
			}
			if (req.url !== "/mcp/v1") { reply({}, 404); return; }
			if (req.method === "GET") { res.writeHead(405).end(); return; }
			if (req.method === "DELETE") { res.writeHead(204).end(); return; }
			const message = JSON.parse(body);
			if (!("id" in message)) { res.writeHead(202).end(); return; }
			if (message.method === "tools/call" && req.headers.authorization !== `Bearer ${currentToken}`) { reply({}, 401); return; }
			const result = message.method === "initialize"
				? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "gmail-fixture", version: "1" } }
				: message.method === "tools/list" ? { tools: [{ name: "list_labels", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] }
				: { content: [{ type: "text", text: rejection ?? '{"labels":[]}' }], ...(rejection ? { isError: true } : {}) };
			reply({ jsonrpc: "2.0", id: message.id, result });
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		const url = `${origin}/mcp/v1`;
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const metadata = { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["client_secret_post"] };
		const connection = new McpServerConnection({ entry: { name: "gmail", source: "global", config: { url, oauth: { clientId: "fixture-client", clientSecret: "fixture-secret", authCheck: { tool: "list_labels" }, authorizationServerMetadata: metadata } } }, cwd: process.cwd(), credentials, createTransport: createDefaultTransport, onTools: () => {} });
		try {
			await expect(connection.getClient()).rejects.toThrow("requires sign-in");
			expect(connection.state).toBe("needs-auth");
			await credentials.forServer("gmail", url).save({ serverUrl: url, tokens: { access_token: currentToken, token_type: "bearer", refresh_token: "google-refresh-token" } });
			await connection.reconnect();
			expect(connection.state).toBe("connected");
			currentToken = "token-two";
			expect(await connection.callTool("list_labels", {})).toMatchObject({ content: [{ text: '{"labels":[]}' }] });
			expect(refreshes).toBe(1);
			expect(credentials.tokens("gmail", url)?.refresh_token).toBe("google-refresh-token");
			await credentials.forServer("gmail", url).save({ ...await credentials.forServer("gmail", url).load()!, serverUrl: url, tokensExpireAt: Date.now() - 1 });
			await connection.callTool("list_labels", {});
			expect(refreshes).toBe(2);
			rejection = "Your Google Cloud project must be enrolled in the Google Workspace Developer Preview Program.";
			await expect(connection.reconnect()).rejects.toThrow(rejection);
			expect(connection.state).toBe("failed");
			expect(credentials.tokens("gmail", url)?.refresh_token).toBe("google-refresh-token");
		} finally {
			await connection.close(); server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it.each([PIZZA_GMAIL_MCP_URL, PIZZA_GMAIL_API_MCP_URL])("uses Google offline consent, registration parameters and PKCE, receives the callback, and saves the refresh token for %s", async (serverUrl) => {
		const realFetch = globalThis.fetch;
		const store = new MemoryOAuthStateStore();
		let auth!: URL;
		let show!: () => void;
		const shown = new Promise<void>((resolve) => { show = resolve; });
		const metadata = { issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token", response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"] };
		vi.stubGlobal("fetch", vi.fn(async (input, init) => {
			if (String(input) !== metadata.token_endpoint) return new Response("", { status: 404 });
			const body = init.body as URLSearchParams;
			expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(auth.searchParams.get("code_challenge"));
			expect(body.get("client_secret")).toBe("fixture-secret");
			return Response.json({ access_token: "google-access-token", token_type: "Bearer", refresh_token: "google-refresh-token", expires_in: 3600 });
		}));
		const login = signInMcpServer({ serverUrl, store, settings: { clientId: "pizza.apps.googleusercontent.com", clientSecret: "fixture-secret", scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose", authorizationParams: { access_type: "offline", prompt: "consent" }, authorizationServerMetadata: metadata }, prompt: { showAuthorizationUrl: (url) => { auth = url; show(); }, promptForRedirectUrl: () => new Promise(() => {}) } });
		await shown;
		expect(auth.searchParams.get("access_type")).toBe("offline");
		expect(auth.searchParams.get("prompt")).toBe("consent");
		expect(auth.searchParams.get("scope")).not.toContain("offline_access");
		const callback = new URL(auth.searchParams.get("redirect_uri")!);
		callback.searchParams.set("code", "google-code");
		callback.searchParams.set("state", auth.searchParams.get("state")!);
		expect((await realFetch(callback)).status).toBe(200);
		await login;
		expect(store.load()?.tokens?.refresh_token).toBe("google-refresh-token");
	});

	it("fails before opening a browser if a Gmail OAuth client is missing", async () => {
		const show = vi.fn();
		await expect(signInMcpServer({ serverUrl: PIZZA_GMAIL_MCP_URL, store: new MemoryOAuthStateStore(), settings: {}, prompt: { showAuthorizationUrl: show, promptForRedirectUrl: vi.fn() } })).rejects.toThrow("Set up a Google OAuth client");
		expect(show).not.toHaveBeenCalled();
	});

	it.each(["state", "client_id", "redirect_uri", "scope", "code_challenge", "resource"])("does not let provider options override %s", async (name) => {
		const authorizationParams = { [name]: "attacker-value" };
		expect(validateMcpServerConfig("gmail", { ...gmail, oauth: { authorizationParams } })).toContain("cannot override");
		await expect(startAuthorization("https://accounts.google.com", { clientInformation: { client_id: "fixture-client" }, redirectUrl: "http://127.0.0.1:8765/callback", authorizationParams })).rejects.toThrow("cannot override");
	});
});
