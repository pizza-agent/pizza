import { createInterface } from "node:readline";

console.error("stdio fixture ready");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

const TOOLS = [
	{
		name: "echo",
		description: "Echo a message N times",
		inputSchema: {
			type: "object",
			properties: {
				message: { type: "string", description: "Message text" },
				times: { type: "integer", default: 1, description: "Repeat count" },
				upper: { type: "boolean", description: "Uppercase the output" },
				mode: { type: "string", enum: ["plain", "shout"], description: "Output style" },
				tags: { type: "array", items: { type: "string" }, description: "Tags list" },
			},
			required: ["message"],
		},
	},
	{
		name: "complex",
		description: "Takes a nested object parameter",
		inputSchema: {
			type: "object",
			properties: {
				spec: { type: "object", description: "Nested spec object" },
				tags: { type: "array", items: { type: "string" }, description: "Primitive array" },
			},
			required: ["spec"],
		},
	},
	{
		name: "fail",
		description: "Always returns an error result",
		inputSchema: { type: "object", properties: {} },
	},
];

for await (const line of lines) {
	if (!line.trim()) continue;
	const message = JSON.parse(line);
	if (!("id" in message)) continue;
	let result;
	if (message.method === "initialize") {
		result = {
			protocolVersion: "2025-11-25",
			capabilities: { tools: {}, resources: {} },
			serverInfo: { name: "stdio-fixture", version: "1.0.0" },
			instructions: "Demo echo & resource server.",
		};
	} else if (message.method === "tools/list") {
		result = { tools: TOOLS };
	} else if (message.method === "tools/call") {
		const { name, arguments: args = {} } = message.params;
		if (name === "echo") {
			const count = typeof args.times === "number" ? args.times : 1;
			let text = Array.from({ length: count }, () => String(args.message ?? "")).join(" ");
			if (args.upper || args.mode === "shout") text = text.toUpperCase();
			if (args.mode === "shout") text += "!!!";
			result = {
				content: [{ type: "text", text }],
			};
		} else if (name === "complex") {
			result = {
				content: [{ type: "text", text: JSON.stringify({ received: args.spec, receivedTags: args.tags }) }],
				structuredContent: { received: args.spec, receivedTags: args.tags },
			};
		} else if (name === "fail") {
			result = {
				content: [{ type: "text", text: "boom: something went wrong" }],
				isError: true,
			};
		} else {
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "tool not found" } })}\n`,
			);
			continue;
		}
	} else if (message.method === "resources/list") {
		result = {
			resources: [{ uri: "memo://greeting", name: "greeting", mimeType: "text/plain", description: "Greeting text" }],
		};
	} else if (message.method === "resources/templates/list") {
		result = {
			resourceTemplates: [{ uriTemplate: "memo://{id}", name: "memo", description: "Memo by id" }],
		};
	} else if (message.method === "resources/read") {
		result = {
			contents: [{ uri: message.params.uri, mimeType: "text/plain", text: `Hello from ${message.params.uri}` }],
		};
	} else if (message.method === "ping") {
		result = {};
	} else {
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`,
		);
		continue;
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
}