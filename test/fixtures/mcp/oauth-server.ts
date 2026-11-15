import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createNativeClientMetadata } from "../../../src/core/mcp/oauth/client-metadata.js";

const metadataBase = "https://pizza.hertzbeat.com/oauth/client.json";

/** Local authorization/resource server that independently enforces PKCE, resource and refresh rotation. */
export async function startOAuthMcpServer(options: { cimd: boolean; issuerResponse: boolean }) {
	let origin = "";
	let serial = 0;
	const registrations = new Map<string, string[]>();
	const codes = new Map<string, { client: string; redirect: string; challenge: string; scope: string }>();
	const access = new Map<string, string>();
	const refresh = new Map<string, { client: string; scope: string }>();
	const requests = { registrations: 0, codeExchanges: 0, refreshes: 0, authorizations: [] as { client: string; redirect: string; scope: string }[] };
	const failures: string[] = [];
	const server = createServer(async (req, res) => {
		const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(value));
		};
		const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
		try {
			const url = new URL(req.url!, origin);
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const raw = Buffer.concat(chunks).toString();
			if (url.pathname.includes("oauth-protected-resource")) {
				json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["tools.read"] }); return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
					client_id_metadata_document_supported: options.cimd, token_endpoint_auth_methods_supported: ["none"],
					authorization_response_iss_parameter_supported: options.issuerResponse,
				}); return;
			}
			if (url.pathname === "/register") {
				const body = JSON.parse(raw);
				check(body.application_type === "native", "DCR must declare a native client");
				check(body.token_endpoint_auth_method === "none", "DCR must declare public client authentication");
				const client = `registered-${++requests.registrations}`;
				registrations.set(client, body.redirect_uris);
				json({ ...body, client_id: client }); return;
			}
			if (url.pathname === "/authorize") {
				const query = url.searchParams;
				check(query.get("response_type") === "code", "Only the authorization code grant is allowed");
				check(query.get("code_challenge_method") === "S256", "PKCE S256 is required");
				check(query.get("resource") === `${origin}/mcp`, "Authorization must identify the MCP resource");
				const client = query.get("client_id")!, redirect = query.get("redirect_uri")!, scope = query.get("scope")!;
				if (options.cimd) {
					const id = /\/([A-Za-z0-9_-]{12})\/client\.json$/.exec(client)?.[1];
					const metadata = createNativeClientMetadata(metadataBase, id);
					check(client === metadata.client_id, "CIMD client identity must belong to Pizza");
					const registeredRedirect = new URL(redirect); registeredRedirect.port = "";
					check(metadata.redirect_uris.includes(registeredRedirect.href), "CIMD redirect host/path must match its document");
				} else check(registrations.get(client)?.includes(redirect), "DCR redirect must match the registration");
				requests.authorizations.push({ client, redirect, scope });
				const code = randomUUID();
				codes.set(code, { client, redirect, challenge: query.get("code_challenge")!, scope });
				const callback = new URL(redirect);
				callback.searchParams.set("code", code); callback.searchParams.set("state", query.get("state")!);
				if (options.issuerResponse) callback.searchParams.set("iss", origin);
				res.writeHead(302, { Location: callback.href }).end(); return;
			}
			if (url.pathname === "/token") {
				const body = new URLSearchParams(raw);
				check(body.get("resource") === `${origin}/mcp`, "Token request must identify the MCP resource");
				check(!body.has("client_secret"), "Public client must not send a secret");
				const client = body.get("client_id")!;
				let scope: string;
				if (body.get("grant_type") === "authorization_code") {
					const code = body.get("code")!, grant = codes.get(code);
					check(grant, "Authorization code must exist and be used only once");
					check(grant!.client === client && grant!.redirect === body.get("redirect_uri"), "Code exchange must preserve client and redirect");
					check(createHash("sha256").update(body.get("code_verifier")!).digest("base64url") === grant!.challenge, "PKCE verifier must match the original challenge");
					scope = grant!.scope; codes.delete(code); requests.codeExchanges++;
				} else {
					check(body.get("grant_type") === "refresh_token", "Only known grants are accepted");
					const token = body.get("refresh_token")!, grant = refresh.get(token);
					check(grant?.client === client, "Refresh token must belong to this client and not have been rotated");
					scope = grant!.scope; refresh.delete(token); requests.refreshes++;
				}
				const accessToken = `access-${++serial}`, refreshToken = `refresh-${serial}`;
				access.set(accessToken, scope); refresh.set(refreshToken, { client, scope });
				json({ access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope }); return;
			}
			if (url.pathname !== "/mcp") { json({}, 404); return; }
			const token = req.headers.authorization?.replace(/^Bearer /, "");
			const scope = token && access.get(token);
			const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="tools.read"`;
			if (!scope) { json({}, 401, { "WWW-Authenticate": challenge }); return; }
			if (req.method === "GET") { res.writeHead(405).end(); return; }
			if (req.method === "DELETE") { res.writeHead(204).end(); return; }
			const message = JSON.parse(raw);
			if (!("id" in message)) { res.writeHead(202).end(); return; }
			if (message.method === "tools/call" && message.params.name === "write_fixture" && !scope.split(" ").includes("tools.write")) {
				json({}, 403, { "WWW-Authenticate": `Basic realm="other", Bearer error="insufficient_scope", scope="tools.write", resource_metadata="${origin}/.well-known/oauth-protected-resource"` }); return;
			}
			const result = message.method === "initialize"
				? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1" } }
				: message.method === "tools/list" ? { tools: ["get_fixture", "write_fixture"].map((name) => ({ name, inputSchema: { type: "object" } })) }
				: { content: [{ type: "text", text: message.params.name === "write_fixture" ? "fixture-write-ok" : "fixture-read-ok" }] };
			json({ jsonrpc: "2.0", id: message.id, result });
		} catch (error) {
			failures.push(String(error)); json({ error: "invalid_request", error_description: String(error) }, 400);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	return { url: `${origin}/mcp`, requests, failures, close: async () => {
		server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
	} };
}
