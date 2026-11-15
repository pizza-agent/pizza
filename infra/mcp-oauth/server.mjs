/** Public CIMD metadata only. Put behind HTTPS at pizza.hertzbeat.com; no dependencies or secrets. */
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultMetadataUrl, metadataBase, metadataResponse } from "./metadata.mjs";

export function createMetadataServer(baseUrl = defaultMetadataUrl) {
	const base = metadataBase(baseUrl);
	return createServer(async (req, res) => {
		const response = metadataResponse(new Request(new URL(req.url ?? "/", base), { method: req.method }), baseUrl);
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(Buffer.from(await response.arrayBuffer()));
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const base = process.env.PIZZA_MCP_OAUTH_CLIENT_METADATA_URL ?? defaultMetadataUrl;
	const server = createMetadataServer(base);
	server.listen(Number(process.env.PORT ?? 8788), process.env.MCP_OAUTH_METADATA_HOST ?? "127.0.0.1", () => {
		console.log(`Pizza CIMD metadata: ${base} (local port ${server.address().port})`);
	});
}
