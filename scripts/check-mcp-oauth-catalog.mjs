// Read-only live compatibility check. Does not register clients, open browsers, or read local credentials.
// Run `npm run build` first. Optionally record public discovery responses for offline regression tests:
// node scripts/check-mcp-oauth-catalog.mjs --record test/fixtures/mcp/official-oauth-discovery.json
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MCP_CONNECTOR_CATALOG } from "../dist/src/builtin-extensions/connectors/catalog.js";
import { discoverOAuthServerInfo, parseWwwAuthenticate, selectResource } from "../dist/src/core/mcp/oauth/discovery.js";

const entries = MCP_CONNECTOR_CATALOG.filter((entry) => !entry.config.adapter && !entry.config.oauth?.clientId);
const records = [];
for (let offset = 0; offset < entries.length; offset += 4) {
	await Promise.all(entries.slice(offset, offset + 4).map(async (entry) => {
		const responses = [];
		const result = { name: entry.name, url: entry.config.url, setup: entry.oauthSetup ?? "automatic" };
		try {
			const signal = AbortSignal.timeout(30_000);
			const response = await fetch(entry.config.url, {
				method: "POST", redirect: "error", signal,
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
					protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Pizza", version: "0.5.5" },
				} }),
			});
			result.status = response.status;
			result.challenge = response.headers.get("www-authenticate");
			await response.body?.cancel();
			if (response.status !== 401 || !result.challenge) throw new Error(`Expected an OAuth challenge; received HTTP ${response.status}`);
			const challenge = parseWwwAuthenticate(result.challenge);
			const settings = entry.config.oauth ?? {};
			const discoveryOptions = {
				authorizationServerMetadataUrl: settings.authServerMetadataUrl ? new URL(settings.authServerMetadataUrl) : undefined,
				signal,
				fetch: async (url, init) => {
					const metadata = await fetch(url, init);
					const body = await metadata.text();
					let recordedBody = metadata.ok ? body : "";
					// Keep the fields consumed by authorization; omit large provider-specific AS catalogs.
					try {
						const value = JSON.parse(recordedBody);
						if (value.authorization_endpoint) recordedBody = JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => [
							"issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint", "response_types_supported",
							"grant_types_supported", "token_endpoint_auth_methods_supported", "code_challenge_methods_supported",
							"authorization_response_iss_parameter_supported", "client_id_metadata_document_supported",
						].includes(key))));
					} catch {}
					if (!responses.some((response) => response.url === String(url))) responses.push({ url: String(url), status: metadata.status, body: recordedBody });
					return new Response(body, { status: metadata.status, headers: metadata.headers });
				},
			};
			const info = await discoverOAuthServerInfo(entry.config.url, { ...discoveryOptions, resourceMetadataUrl: challenge.resourceMetadataUrl });
			result.resource = selectResource(entry.config.url, info.resourceMetadata);
			const metadata = info.authorizationServerMetadata;
			if (!metadata?.code_challenge_methods_supported?.includes("S256")) throw new Error("Missing PKCE S256 support");
			result.issuer = metadata.issuer;
			result.cimd = metadata.client_id_metadata_document_supported === true;
			result.dcr = Boolean(metadata.registration_endpoint);
			if (!entry.oauthSetup && !result.cimd && !result.dcr) throw new Error("Requires a pre-registered OAuth app");
			result.ok = true;
		} catch (error) {
			result.ok = false;
			result.error = error.message;
		}
		records.push({ ...result, responses });
		console.log(JSON.stringify(result));
	}));
}
const failures = records.filter((record) => !record.ok);
console.log(JSON.stringify({ checked: records.length, passed: records.length - failures.length, failed: failures.length }));
if (failures.length) process.exitCode = 1;
else if (process.argv.includes("--record")) {
	const destination = process.argv[process.argv.indexOf("--record") + 1];
	if (!destination) throw new Error("--record needs an output path");
	const order = new Map(entries.map((entry, index) => [entry.name, index]));
	records.sort((a, b) => order.get(a.name) - order.get(b.name));
	await writeFile(resolve(destination), JSON.stringify({ recordedAt: new Date().toISOString(), records }, null, 2) + "\n");
}
