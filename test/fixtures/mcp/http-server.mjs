// A stateful remote MCP fixture: JSON or SSE responses, bearer authentication,
// session expiry, tool calls and resources. No model/API credentials required.
import { createServer } from "node:http";
const token = process.env.MCP_TEST_TOKEN ?? "fixture-token";
const mode = process.env.MCP_TEST_RESPONSE ?? "sse";
let session = 0;
let expired = false;
const server = createServer(async (req, res) => {
	try {
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized");
			return;
		}
		if (req.method === "DELETE") {
			res.writeHead(204).end();
			return;
		}
		if (req.method === "GET") {
			res.writeHead(405).end();
			return;
		}
		if (req.method !== "POST" || req.url !== "/mcp") {
			res.writeHead(404).end();
			return;
		}
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const msg = JSON.parse(Buffer.concat(chunks).toString());
		if (!("id" in msg)) {
			res.writeHead(202).end();
			return;
		}
		if (
			msg.method !== "initialize" &&
			req.headers["mcp-session-id"] !== `session-${session}`
		) {
			res.writeHead(404).end("MCP session expired");
			return;
		}
		if (
			msg.method === "tools/call" &&
			msg.params?.name === "expire_once" &&
			!expired
		) {
			expired = true;
			res.writeHead(404).end("MCP session expired");
			return;
		}
		let result;
		if (msg.method === "initialize") {
			if (process.env.MCP_TEST_INIT_DELAY_MS)
				await new Promise((resolve) =>
					setTimeout(resolve, Number(process.env.MCP_TEST_INIT_DELAY_MS)),
				);
			session++;
			result = {
				protocolVersion: msg.params.protocolVersion,
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: "remote-http-fixture", version: "1.0.0" },
			};
		} else if (msg.method === "tools/list") {
			result = {
				tools: ["echo", "expire_once"].map((name) => ({
					name,
					description:
						name === "echo"
							? "Echo via authenticated remote HTTP"
							: "Expire once and recover the MCP session",
					inputSchema: {
						type: "object",
						properties: { message: { type: "string" } },
						required: ["message"],
					},
				})),
			};
		} else if (msg.method === "tools/call") {
			result = {
				content: [{ type: "text", text: msg.params.arguments.message }],
				structuredContent: {
					message: msg.params.arguments.message,
					session,
					responseMode: mode,
				},
			};
		} else if (msg.method === "resources/list")
			result = {
				resources: [{ uri: "remote://status", name: "Remote status" }],
			};
		else if (msg.method === "resources/read")
			result = {
				contents: [
					{
						uri: "remote://status",
						mimeType: "text/plain",
						text: "remote-ready",
					},
				],
			};
		else if (msg.method === "resources/templates/list")
			result = { resourceTemplates: [] };
		else {
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32601, message: "Unknown method" },
				}),
			);
			return;
		}
		const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
		res.setHeader("mcp-session-id", `session-${session}`);
		if (mode === "sse") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(": keepalive\n\nevent: message\n");
			res.end(`data: ${payload}\n\n`);
		} else
			res.writeHead(200, { "content-type": "application/json" }).end(payload);
	} catch {
		if (!res.headersSent) res.writeHead(400);
		res.end();
	}
});
server.listen(Number(process.env.MCP_TEST_PORT ?? 0), "127.0.0.1", () =>
	console.log(
		JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp` }),
	),
);
process.on("SIGTERM", () => {
	server.closeAllConnections();
	server.close(() => process.exit(0));
});
