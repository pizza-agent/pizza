import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { FileAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import { MemoryOAuthStateStore } from "../src/core/mcp/oauth/index.js";
import { signInMcpServer, McpSignInCancelledError } from "../src/builtin-extensions/mcp/oauth.js";
import { McpServerConnection, McpOAuthCredentialStore, createDefaultTransport } from "../src/builtin-extensions/mcp/runtime.js";
import { PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID, PIZZA_GITHUB_OAUTH_AS_METADATA } from "../src/builtin-extensions/connectors/catalog.js";
import { PIZZA_OAUTH_LOGO } from "../src/builtin-extensions/mcp/oauth-logo.js";

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

describe("MCP OAuth client workflow", () => {
	it("upgrades existing Pizza GitHub installs while leaving custom clients on their configured flow", async () => {
		const credentials = new McpOAuthCredentialStore();
		const make = (clientId: string) => new McpServerConnection({
			entry: { name: "github", source: "global", config: { url: "https://api.githubcopilot.com/mcp/", oauth: { clientId } } },
			cwd: process.cwd(), credentials, createTransport: createDefaultTransport, onTools: () => {},
		});
		const product = make(PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID);
		const custom = make("custom-client");
		expect(product.oauthSettings()).toMatchObject({ deviceAuthorizationUrl: "https://github.com/login/device/code", scope: "repo read:user", authorizationServerMetadata: PIZZA_GITHUB_OAUTH_AS_METADATA });
		expect(custom.oauthSettings().deviceAuthorizationUrl).toBeUndefined();
		await product.close();
		await custom.close();
	});
	it("moves needs-auth → device sign-in → saved credentials → connected tools, survives restart, and signs out", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pizza-oauth-client-"));
		const path = join(dir, "mcp-auth.json");
		let polls = 0;
		const server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const raw = Buffer.concat(chunks).toString();
			const reply = (value: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
			if (req.url === "/device") {
				expect(new URLSearchParams(raw).get("client_id")).toBe("pizza-test");
				reply({ device_code: "device-secret", user_code: "PZZA-TEST", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 0.001 });
			} else if (req.url === "/token") {
				expect(new URLSearchParams(raw).get("client_secret")).toBeNull();
				reply(++polls === 1 ? { error: "authorization_pending" } : { access_token: "local-test-token", token_type: "bearer" });
			} else if (req.url !== "/mcp") reply({}, 404);
			else if (req.headers.authorization !== "Bearer local-test-token") reply({}, 401);
			else if (req.method === "DELETE") res.writeHead(204).end();
			else if (req.method === "GET") res.writeHead(405).end();
			else {
				const message = JSON.parse(raw);
				if (!("id" in message)) { res.writeHead(202).end(); return; }
				const result = message.method === "initialize"
					? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "github-fixture", version: "1" } }
					: message.method === "tools/list" ? { tools: [{ name: "get_me", inputSchema: { type: "object" } }] }
					: { content: [{ type: "text", text: "pizza-test-user" }] };
				reply({ jsonrpc: "2.0", id: message.id, result });
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(path), dir);
		const makeConnection = () => new McpServerConnection({
			entry: { name: "github", source: "global", config: { url: `${origin}/mcp`, oauth: { clientId: "pizza-test", deviceAuthorizationUrl: `${origin}/device`, authorizationServerMetadata: { ...PIZZA_GITHUB_OAUTH_AS_METADATA, token_endpoint: `${origin}/token` } } } },
			cwd: dir, credentials, createTransport: createDefaultTransport, onTools: () => {},
		});
		const connection = makeConnection();
		let restarted: McpServerConnection | undefined;
		try {
			await expect(connection.getClient()).rejects.toThrow();
			expect(connection.state).toBe("needs-auth");
			const showDeviceCode = vi.fn();
			const promptForRedirectUrl = vi.fn();
			await signInMcpServer({ serverUrl: `${origin}/mcp`, store: credentials.forServer("github", `${origin}/mcp`), settings: connection.oauthSettings(), prompt: { showAuthorizationUrl: vi.fn(), showDeviceCode, promptForRedirectUrl } });
			expect(showDeviceCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: "PZZA-TEST" }));
			expect(promptForRedirectUrl).not.toHaveBeenCalled();
			expect(readFileSync(path, "utf8")).toContain("local-test-token");
			if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
			await connection.reconnect();
			expect(connection.state).toBe("connected");
			expect(connection.tools.map((tool) => tool.name)).toEqual(["get_me"]);
			expect(await connection.callTool("get_me", {})).toMatchObject({ content: [{ text: "pizza-test-user" }] });
			await connection.close();
			restarted = makeConnection();
			await restarted.getClient();
			expect(restarted.state).toBe("connected");
			credentials.remove("github", `${origin}/mcp`);
			await restarted.signOut();
			expect(restarted.state).toBe("needs-auth");
			expect(credentials.tokens("github", `${origin}/mcp`)).toBeUndefined();
		} finally {
			await connection.close();
			await restarted?.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([true, false])("shows a Pizza success page only after exchange, or a failure page on token rejection (success=%s)", async (success) => {
		const realFetch = globalThis.fetch;
		const store = new MemoryOAuthStateStore();
		let authorization!: URL;
		let resolveUrl!: () => void;
		const urlReady = new Promise<void>((resolve) => { resolveUrl = resolve; });
		let releaseToken!: () => void;
		const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve; });
		let tokenRequest!: () => void;
		const tokenRequested = new Promise<void>((resolve) => { tokenRequest = resolve; });
		vi.stubGlobal("fetch", vi.fn(async (input, init) => {
			if (String(input) !== PIZZA_GITHUB_OAUTH_AS_METADATA.token_endpoint) return new Response("", { status: 404 });
			const body = init.body as URLSearchParams;
			expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${Buffer.from("pizza-test:fixture-secret").toString("base64")}`);
			expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge"));
			expect(body.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
			tokenRequest();
			await tokenGate;
			return Response.json(success ? { access_token: "test-token", token_type: "bearer" } : { error: "bad_verification_code", error_description: "<script>bad</script>" });
		}));
		const login = signInMcpServer({ serverUrl: "https://api.githubcopilot.com/mcp/", store,
			settings: { clientId: "pizza-test", clientSecret: "fixture-secret", deviceAuthorizationUrl: "https://github.com/login/device/code", authorizationServerMetadata: { ...PIZZA_GITHUB_OAUTH_AS_METADATA } },
			prompt: { showAuthorizationUrl: (url) => { authorization = url; resolveUrl(); }, promptForRedirectUrl: () => new Promise(() => {}) },
		});
		const outcome = login.then(() => undefined, (error) => error as Error);
		await urlReady;
		const callback = new URL(authorization.searchParams.get("redirect_uri")!);
		callback.searchParams.set("state", "wrong-state");
		callback.searchParams.set("code", "fixture-code");
		expect((await realFetch(callback)).status).toBe(400);
		callback.searchParams.set("state", authorization.searchParams.get("state")!);
		let callbackReturned = false;
		const response = realFetch(callback).then((value) => { callbackReturned = true; return value; });
		await tokenRequested;
		expect(callbackReturned).toBe(false);
		releaseToken();
		const html = await (await response).text();
		expect(html).toContain("Pizza · Authentication");
		expect(html).toContain('aria-label="Pizza"');
		expect(html).toContain(`src="${PIZZA_OAUTH_LOGO}"`);
		expect(html).toContain(`href="${PIZZA_OAUTH_LOGO}"`);
		expect(html).not.toContain("#F09082");
		const error = await outcome;
		if (success) {
			expect(error).toBeUndefined();
			expect(html).toContain("credentials have been saved");
			expect(store.load()?.tokens?.access_token).toBe("test-token");
			expect(store.load()?.codeVerifier).toBeUndefined();
			expect(store.load()?.oauthState).toBeUndefined();
		} else {
			expect(error?.message).toContain("<script>bad</script>");
			expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
			expect(html).not.toContain("<script>bad</script>");
			expect(store.load()?.tokens).toBeUndefined();
		}
	});

	it("cancels a callback wait even when the manual-input client ignores the signal", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
		const abort = new AbortController();
		const login = signInMcpServer({ serverUrl: "https://api.githubcopilot.com/mcp/", store: new MemoryOAuthStateStore(), signal: abort.signal,
			settings: { clientId: "pizza-test", clientSecret: "fixture-secret", authorizationServerMetadata: { ...PIZZA_GITHUB_OAUTH_AS_METADATA } },
			prompt: { showAuthorizationUrl: () => abort.abort(), promptForRedirectUrl: () => new Promise(() => {}) },
		});
		await expect(login).rejects.toBeInstanceOf(McpSignInCancelledError);
	});
});
