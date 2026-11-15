import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { FileAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import { McpOAuthCredentialStore, McpServerConnection, createDefaultTransport } from "../src/builtin-extensions/mcp/runtime.js";
import { PIZZA_MCP_OAUTH_CLIENT_METADATA_URL, signInMcpServer } from "../src/builtin-extensions/mcp/oauth.js";
import { metadataResponse } from "../infra/mcp-oauth/metadata.mjs";
import { startOAuthMcpServer } from "./fixtures/mcp/oauth-server.js";

let previousDispatcher: Dispatcher;
let direct: Agent;
let liveMetadata: Agent | undefined;
beforeEach(() => {
	previousDispatcher = getGlobalDispatcher(); direct = new Agent(); setGlobalDispatcher(direct);
});
afterEach(async () => {
	vi.unstubAllGlobals(); setGlobalDispatcher(previousDispatcher);
	await direct.destroy(); await liveMetadata?.destroy(); liveMetadata = undefined;
});

async function verifyLifecycle(cimd: boolean, issuerResponse: boolean, live = false) {
	const realFetch = globalThis.fetch;
	const browserResults: Promise<{ status: number; body: string }>[] = [];
	const origin = new URL(PIZZA_MCP_OAUTH_CLIENT_METADATA_URL).origin;
	let metadataLookups = 0;
	if (live && process.env.PIZZA_MCP_METADATA_IP) {
		const address = process.env.PIZZA_MCP_METADATA_IP;
		// An opt-in test-only DNS override retains hostname/certificate verification.
		liveMetadata = new Agent({ connect: { lookup: (_hostname, options, callback) => {
			if (options.all) callback(null, [{ address, family: 4 }]);
			else callback(null, address, 4);
		} } });
	}
	vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
		if (new URL(String(input)).origin !== origin) return realFetch(input, init);
		metadataLookups++;
		if (!live) return Promise.resolve(metadataResponse(new Request(input)));
		return realFetch(input, { ...init, ...(liveMetadata ? { dispatcher: liveMetadata } : {}) } as RequestInit);
	});
	const server = await startOAuthMcpServer({ cimd, issuerResponse });
	const dir = mkdtempSync(join(tmpdir(), "pizza-oauth-http-"));
	const path = join(dir, "mcp-auth.json");
	let credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(path), dir);
	const connection = () => new McpServerConnection({ entry: { name: "fixture", source: "global", config: { url: server.url } },
		cwd: dir, credentials, createTransport: createDefaultTransport, onTools: () => {},
	});
	let current = connection();
	const login = async () => {
		await signInMcpServer({ serverUrl: server.url, store: credentials.forServer("fixture", server.url),
			signal: AbortSignal.timeout(10_000),
			settings: current.oauthSettings(), challenge: current.challenge,
			prompt: {
				showAuthorizationUrl: (url) => {
					const request = realFetch(url).then(async (response) => ({ status: response.status, body: await response.text() }));
					void request.catch(() => {}); browserResults.push(request);
				},
				promptForRedirectUrl: () => new Promise(() => {}),
			},
		});
		current.challenge = undefined;
		await current.reconnect();
	};
	try {
		await expect(current.getClient()).rejects.toThrow("requires sign-in");
		expect(current.state).toBe("needs-auth");
		expect(server.requests.registrations).toBe(0);
		await login();
		expect(current.state).toBe("connected");
		expect(await current.callTool("get_fixture", {})).toMatchObject({ content: [{ text: "fixture-read-ok" }] });
		expect(server.requests.codeExchanges).toBe(1);
		expect(server.requests.registrations).toBe(cimd ? 0 : 1);
		expect(metadataLookups).toBe(cimd ? 1 : 0);

		const store = credentials.forServer("fixture", server.url);
		await store.update!((state) => ({ ...state!, tokensExpireAt: Date.now() - 1 }));
		await current.callTool("get_fixture", {});
		expect(server.requests.refreshes).toBe(1);
		expect((await store.load())?.tokens?.refresh_token).toBe("refresh-2");

		await current.close();
		credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(path), dir);
		current = connection(); await current.getClient();
		expect(await current.callTool("get_fixture", {})).toMatchObject({ content: [{ text: "fixture-read-ok" }] });
		expect(server.requests.codeExchanges).toBe(1);

		await expect(current.callTool("write_fixture", {})).rejects.toThrow("requires sign-in");
		expect(current.challenge).toMatchObject({ error: "insufficient_scope", scope: "tools.write" });
		await login();
		expect(new Set(server.requests.authorizations[1].scope.split(" "))).toEqual(new Set(["tools.read", "tools.write"]));
		expect(await current.callTool("write_fixture", {})).toMatchObject({ content: [{ text: "fixture-write-ok" }] });
		expect(server.requests.codeExchanges).toBe(2);
		expect(server.requests.refreshes).toBe(1);
		expect(server.requests.registrations).toBe(cimd ? 0 : 1);
		for (const result of await Promise.all(browserResults)) {
			expect(result.status).toBe(200); expect(result.body).toContain("credentials have been saved");
		}

		expect(credentials.remove("fixture", server.url)).toBe(true);
		await current.signOut();
		await expect(current.getClient()).rejects.toThrow("requires sign-in");
		expect(readFileSync(path, "utf8")).not.toContain("access-");
		expect(server.failures).toEqual([]);
	} finally {
		await current.close(); await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("MCP OAuth over real HTTP", () => {
	it.each([[true, true], [true, false], [false, true], [false, false]])(
		"signs in, persists, rotates, restarts, steps up scopes and signs out (CIMD=%s, issuer=%s)",
		(cimd, issuerResponse) => verifyLifecycle(cimd, issuerResponse),
	);
	it.skipIf(process.env.PIZZA_MCP_LIVE_METADATA !== "1")("uses the deployed Cloudflare CIMD document through the complete OAuth lifecycle", () => verifyLifecycle(true, false, true));
});
