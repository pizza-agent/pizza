import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildFlagPlan,
	createAgentCliBuiltinCommand,
	parseToolArgs,
	renderToolHelp,
	validateRequired,
} from "../src/builtin-extensions/mcp/agentcli.js";
import { runMcpCommand } from "../src/builtin-extensions/mcp/cli.js";
import {
	loadMcpConfig,
	type McpServerEntry,
	updateMcpServerConfig,
} from "../src/builtin-extensions/mcp/config.js";
import { createMcpExtension, renderServersSection } from "../src/builtin-extensions/mcp/index.js";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
} from "../src/builtin-extensions/mcp/runtime.js";
import { InMemoryAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import type { BuiltinCommandDefinition, RegisteredBuiltinCommand } from "../src/core/extensions/types.js";
import {
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpClient,
	McpError,
	StreamableHttpTransport,
} from "../src/core/mcp/index.js";
import { createInMemoryTransportPair } from "../src/core/mcp/testing/index.js";
import { createSyntheticSourceInfo } from "../src/core/skills/source-info.js";
import { createBashTool } from "../src/core/tools/bash.js";
import { getTextOutput } from "../src/core/tools/render-utils.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures/mcp/stdio-server.mjs");

describe("McpClient protocol (in-memory & HTTP)", () => {
	it("initializes, lists tools, calls tools, and reads resources", async () => {
		const pair = createInMemoryTransportPair();
		pair.server.onMessage((msg: JsonRpcMessage) => {
			if (!("id" in msg) || !("method" in msg)) return;
			const req = msg as JsonRpcRequest;
			queueMicrotask(async () => {
				if (req.method === "initialize") {
					await pair.server.send({
						jsonrpc: "2.0",
						id: req.id,
						result: {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: { listChanged: true }, resources: {} },
							serverInfo: { name: "mem-server", version: "1.0.0" },
							instructions: "Memory MCP server.",
						},
					});
				} else if (req.method === "tools/list") {
					await pair.server.send({
						jsonrpc: "2.0",
						id: req.id,
						result: {
							tools: [{ name: "ping", description: "Ping tool", inputSchema: { type: "object" } }],
						},
					});
				} else if (req.method === "tools/call") {
					await pair.server.send({
						jsonrpc: "2.0",
						id: req.id,
						result: {
							content: [{ type: "text", text: "pong" }],
							structuredContent: { pong: true },
						},
					});
				} else {
					await pair.server.send({
						jsonrpc: "2.0",
						id: req.id,
						error: { code: -32601, message: "not found" },
					});
				}
			});
		});
		await pair.server.start();

		const client = new McpClient({ name: "pizza-test", version: "1.0.0" });
		await client.connect(pair.client);
		expect(client.connectionState).toBe("connected");
		expect(client.instructions).toBe("Memory MCP server.");

		const tools = await client.listTools();
		expect(tools).toEqual([{ name: "ping", description: "Ping tool", inputSchema: { type: "object" } }]);

		const callRes = await client.callTool("ping", {});
		expect(callRes.structuredContent).toEqual({ pong: true });

		await client.close();
	});

	it("supports StreamableHttpTransport over HTTP JSON responses", async () => {
		const httpServer = createServer(async (req, res) => {
			if (req.method === "DELETE") {
				res.writeHead(204).end();
				return;
			}
			if (req.method === "GET") {
				res.writeHead(405).end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!("id" in body)) {
				res.writeHead(202).end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.setHeader("mcp-session-id", "sess-123");
			if (body.method === "initialize") {
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "http-mcp", version: "1.0.0" },
						},
					}),
				);
			} else if (body.method === "tools/list") {
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							tools: [{ name: "add", inputSchema: { type: "object", properties: { a: { type: "number" } } } }],
						},
					}),
				);
			} else if (body.method === "tools/call") {
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [{ type: "text", text: JSON.stringify({ sum: (body.params.arguments?.a ?? 0) + 1 }) }],
						},
					}),
				);
			}
		});

		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		const port = (httpServer.address() as AddressInfo).port;
		try {
			const transport = new StreamableHttpTransport({ url: `http://127.0.0.1:${port}/mcp` });
			const client = new McpClient({ name: "pizza", version: "1.0.0" });
			await client.connect(transport);
			expect(transport.sessionId).toBe("sess-123");
			const tools = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["add"]);
			const res = await client.callTool("add", { a: 41 });
			expect(res.content).toEqual([{ type: "text", text: '{"sum":42}' }]);
			await client.close();
		} finally {
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
	});
});

describe("MCP config & `pizza mcp` CLI", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("loads global and project mcp.json and supports project overrides", () => {
		const root = mkdtempSync(join(tmpdir(), "pizza-mcp-cfg-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "proj");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pizza"), { recursive: true });

		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: { command: process.execPath, args: [FIXTURE], description: "Demo server" },
					disabledOne: { command: "x", enabled: false },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".pizza", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: { enabled: false },
				},
			}),
		);

		const loaded = loadMcpConfig({ agentDir, cwd, projectTrusted: true });
		expect(loaded.errors).toEqual([]);
		const demo = loaded.servers.find((s) => s.name === "demo");
		expect(demo?.config.enabled).toBe(false);
		expect(demo?.override).toBe(join(cwd, ".pizza", "mcp.json"));

		updateMcpServerConfig(demo!.override!, "demo", { enabled: true }, { override: true });
		const reloaded = loadMcpConfig({ agentDir, cwd, projectTrusted: true });
		expect(reloaded.servers.find((s) => s.name === "demo")?.config.enabled).toBe(true);
	});

	it("runs `pizza mcp add`, `list`, and `remove` against stdio fixture", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pizza-mcp-cli-"));
		dirs.push(dir);
		const logs: string[] = [];
		const run = (args: string[]) =>
			runMcpCommand(args, {
				cwd: dir,
				agentDir: dir,
				log: (l) => logs.push(l),
				error: (l) => logs.push(l),
			});

		logs.length = 0;
		expect(await run(["add", "demo", "--", process.execPath, FIXTURE])).toBe(0);
		expect(logs.join("\n")).toContain('Added global MCP server "demo"');

		logs.length = 0;
		expect(await run(["list"])).toBe(0);
		expect(logs.join("\n")).toContain("demo: connected, 3 tools");
		expect(logs.join("\n")).toContain("tools: echo, complex, fail");

		logs.length = 0;
		expect(await run(["list", "--json"])).toBe(0);
		const parsed = JSON.parse(logs.join("\n"));
		expect(parsed.servers[0]).toMatchObject({
			name: "demo",
			state: "connected",
			tools: ["echo", "complex", "fail"],
			resources: true,
		});

		logs.length = 0;
		expect(await run(["remove", "demo"])).toBe(0);
		expect(logs.join("\n")).toContain('Removed global MCP server "demo"');
	});
});

describe("_agentcli dynamic builtin command & MCP extension", () => {
	const dirs: string[] = [];
	const connections: McpServerConnection[] = [];

	afterEach(async () => {
		for (const conn of connections.splice(0)) {
			await conn.close();
		}
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function setupDemoHost() {
		const dir = mkdtempSync(join(tmpdir(), "pizza-agentcli-"));
		dirs.push(dir);
		const entry: McpServerEntry = {
			name: "demo",
			source: join(dir, "mcp.json"),
			scope: "global",
			config: {
				command: process.execPath,
				args: [FIXTURE],
				description: "Demo echo server",
			},
		};
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const conn = new McpServerConnection({
			entry,
			cwd: dir,
			createTransport: createDefaultTransport,
			credentials,
			onTools: () => {},
		});
		connections.push(conn);
		await conn.getClient();

		const servers = [{ entry, connection: conn, ready: Promise.resolve() }];
		const cmdDef = createAgentCliBuiltinCommand({
			getServers: () => servers,
			getConfigErrors: () => [],
			waitForServer: async (name) => servers.find((s) => s.entry.name === name),
			waitForAllServers: async () => {},
			addServer: async (name, config) => ({ path: join(dir, "mcp.json"), replaced: false }),
			removeServer: async () => ({ path: join(dir, "mcp.json"), removed: true }),
		});

		const registered: RegisteredBuiltinCommand = {
			...cmdDef,
			sourceInfo: createSyntheticSourceInfo("<builtin:mcp>", { source: "builtin" }),
		};
		const cliTool = createBashTool(dir, { dynamicBuiltins: () => [registered] });
		return { dir, cliTool, cmdDef };
	}

	it("returns server lists and top-level help without waiting for slow connections", async () => {
		const waitForAllServers = vi.fn(async () => {});
		const waitForServer = vi.fn(async () => undefined);
		const command = createAgentCliBuiltinCommand({
			getServers: () => [{ entry: { name: "slow", source: "mcp.json", config: { url: "http://127.0.0.1:1/mcp" } }, ready: new Promise<void>(() => {}) }],
			getConfigErrors: () => [], waitForAllServers, waitForServer,
			addServer: async () => ({ path: "mcp.json", replaced: false }),
			removeServer: async () => ({ path: "mcp.json", removed: false }),
		});
		const run = (args: string[]) => command.execute("nonblocking", command.parseArguments(args), undefined, undefined, {} as never);
		expect(JSON.parse(getTextOutput(await run(["server", "list"]))).data).toMatchObject([{ name: "slow", state: "starting" }]);
		expect(getTextOutput(await run(["-h"]))).toContain("slow");
		expect(waitForAllServers).not.toHaveBeenCalled();
		expect(waitForServer).not.toHaveBeenCalled();
		await run(["server", "list", "--wait"]);
		expect(waitForAllServers).toHaveBeenCalledOnce();
	});

	it("discovers configured servers via `_agentcli -h` and `_agentcli server list`", async () => {
		const { cliTool } = await setupDemoHost();

		const helpRes = await cliTool.execute("c1", { command: "_agentcli -h" });
		const helpText = getTextOutput(helpRes);
		expect(helpText).toContain("Configured servers (_agentcli <server> <tool> ...):");
		expect(helpText).toContain("demo");
		expect(helpText).toContain("Demo echo server");

		const listRes = await cliTool.execute("c2", { command: "_agentcli server list" });
		const listJson = JSON.parse(getTextOutput(listRes));
		expect(listJson.ok).toBe(true);
		expect(listJson.data[0]).toMatchObject({
			name: "demo",
			type: "stdio",
			state: "connected",
			tools: 3,
			resources: true,
		});
	});

	it("inspects server tools and tool help/schema via `_agentcli demo -h` and `_agentcli demo echo -h`", async () => {
		const { cliTool } = await setupDemoHost();

		const srvHelp = getTextOutput(await cliTool.execute("c1", { command: "_agentcli demo -h" }));
		expect(srvHelp).toContain("demo — MCP server (3 tools)");
		expect(srvHelp).toContain("echo");
		expect(srvHelp).toContain("complex");
		expect(srvHelp).toContain("fail");
		expect(srvHelp).toContain("_agentcli demo resources");

		const toolHelp = getTextOutput(await cliTool.execute("c2", { command: "_agentcli demo echo -h" }));
		expect(toolHelp).toContain("demo echo");
		expect(toolHelp).toContain("Required:\n  --message <string>");
		expect(toolHelp).toContain("--times <integer>");
		expect(toolHelp).toContain("--upper <boolean>");
		expect(toolHelp).toContain("--mode <string>    Output style; choices: plain|shout");

		const schemaOut = JSON.parse(
			getTextOutput(await cliTool.execute("c3", { command: "_agentcli demo echo --schema" })),
		);
		expect(schemaOut.required).toEqual(["message"]);
	});

	it("executes tools with compiled flags, boolean flags, enums, arrays, and --input JSON", async () => {
		const { cliTool, dir } = await setupDemoHost();

		// 1. Primitive flags
		const res1 = JSON.parse(
			getTextOutput(await cliTool.execute("c1", { command: '_agentcli demo echo --message "hi" --times 2' })),
		);
		expect(res1).toMatchObject({
			ok: true,
			server: "demo",
			tool: "echo",
			data: "hi hi",
		});

		// 2. --flag=value and boolean flag and enum
		const res2 = JSON.parse(
			getTextOutput(
				await cliTool.execute("c2", { command: "_agentcli demo echo --message=hey --mode shout" }),
			),
		);
		expect(res2.data).toBe("HEY!!!");

		// 3. Complex object via --input + array flag override
		const res3 = JSON.parse(
			getTextOutput(
				await cliTool.execute("c3", {
					command: `_agentcli demo complex --input '{"spec":{"a":1}}' --tags x --tags y`,
				}),
			),
		);
		expect(res3.ok).toBe(true);
		expect(res3.data).toEqual({ received: { a: 1 }, receivedTags: ["x", "y"] });

		// 4. --input @file
		const payloadFile = join(dir, "payload.json");
		writeFileSync(payloadFile, JSON.stringify({ spec: { fromFile: true } }));
		const res4 = JSON.parse(
			getTextOutput(await cliTool.execute("c4", { command: `_agentcli demo complex --input '@${payloadFile}'` })),
		);
		expect(res4.data).toEqual({ received: { fromFile: true } });

		// 5. --output text
		const res5 = getTextOutput(
			await cliTool.execute("c5", { command: '_agentcli demo echo --message "raw" --output text' }),
		);
		expect(res5.trim()).toBe("raw");
	});

	it("returns self-describing JSON error envelopes for invalid flags, missing required args, unknown server/tool, and tool errors", async () => {
		const { cliTool } = await setupDemoHost();

		// Missing required
		const errMissing = JSON.parse(getTextOutput(await cliTool.execute("e1", { command: "_agentcli demo echo" })));
		expect(errMissing.ok).toBe(false);
		expect(errMissing.error.code).toBe("INVALID_ARGUMENT");
		expect(errMissing.error.message).toContain("missing required parameter: message");
		expect(errMissing.error.hint).toContain("--message");

		// Invalid integer
		const errInt = JSON.parse(
			getTextOutput(await cliTool.execute("e2", { command: "_agentcli demo echo --message x --times bad" })),
		);
		expect(errInt.error.code).toBe("INVALID_ARGUMENT");

		// Invalid enum
		const errEnum = JSON.parse(
			getTextOutput(await cliTool.execute("e3", { command: "_agentcli demo echo --message x --mode loud" })),
		);
		expect(errEnum.error.code).toBe("INVALID_ARGUMENT");
		expect(errEnum.error.hint).toContain("Allowed values: plain, shout");

		// Unknown server with fuzzy suggestion
		const errSrv = JSON.parse(
			getTextOutput(await cliTool.execute("e4", { command: "_agentcli demoa echo --message x" })),
		);
		expect(errSrv.error.code).toBe("NOT_FOUND");
		expect(errSrv.error.hint).toContain("Did you mean: demo?");

		// Unknown tool with fuzzy suggestion
		const errTool = JSON.parse(getTextOutput(await cliTool.execute("e5", { command: "_agentcli demo ech" })));
		expect(errTool.error.code).toBe("NOT_FOUND");
		expect(errTool.error.hint).toContain("Similar tools: echo");

		// Tool execution error (isError: true)
		const errExec = JSON.parse(getTextOutput(await cliTool.execute("e6", { command: "_agentcli demo fail" })));
		expect(errExec.error.code).toBe("EXECUTION_ERROR");
		expect(errExec.error.message).toContain("boom");
	});

	it("lists and reads MCP resources via `_agentcli <server> resources` and `_agentcli <server> resource <uri>`", async () => {
		const { cliTool } = await setupDemoHost();

		const listRes = JSON.parse(
			getTextOutput(await cliTool.execute("r1", { command: "_agentcli demo resources" })),
		);
		expect(listRes.ok).toBe(true);
		expect(listRes.data.resources).toEqual([
			{ uri: "memo://greeting", name: "greeting", mimeType: "text/plain", description: "Greeting text" },
		]);

		const tplRes = JSON.parse(
			getTextOutput(await cliTool.execute("r2", { command: "_agentcli demo templates" })),
		);
		expect(tplRes.ok).toBe(true);
		expect(tplRes.data.resourceTemplates).toEqual([
			{ uriTemplate: "memo://{id}", name: "memo", description: "Memo by id" },
		]);

		const readRes = getTextOutput(
			await cliTool.execute("r3", { command: "_agentcli demo resource memo://greeting" }),
		);
		expect(readRes).toBe("Hello from memo://greeting");
	});

	it("does NOT register per-MCP-tool definitions on ExtensionAPI, only `_agentcli` and `/mcp`", () => {
		const toolsRegistered: string[] = [];
		const builtinsRegistered: BuiltinCommandDefinition[] = [];
		const commandsRegistered: string[] = [];

		const factory = createMcpExtension();
		factory({
			on: () => {},
			registerTool: (t: { name: string }) => toolsRegistered.push(t.name),
			registerBuiltinCommand: (c: BuiltinCommandDefinition) => builtinsRegistered.push(c),
			registerCommand: (name: string) => commandsRegistered.push(name),
			getMcpServers: () => [],
		} as never);

		expect(toolsRegistered).toEqual([]);
		expect(builtinsRegistered.map((b) => b.name)).toEqual(["_agentcli"]);
		expect(commandsRegistered).toEqual(["mcp"]);
	});

	it("renders the `_agentcli` system prompt section when MCP servers are configured", () => {
		const section = renderServersSection([
			{
				entry: {
					name: "github",
					source: "mcp.json",
					config: { url: "https://example.com/mcp", description: "Search issues and PRs" },
				},
			},
		]);
		expect(section).toContain("## _agentcli (MCP servers)");
		expect(section).toContain("- github: Search issues and PRs");
		expect(section).toContain("_agentcli <server> <tool> -h");
	});

	it("wires mcpServers into SessionFacade and executes _agentcli via the session cli tool without exposing MCP tools in runtime tools", async () => {
		const { createSessionFacade } = await import("../src/core/session/session-facade-factory.js");
		const dir = mkdtempSync(join(tmpdir(), "pizza-mcp-session-"));
		dirs.push(dir);
		mkdirSync(join(dir, ".pizza"), { recursive: true });
		writeFileSync(
			join(dir, ".pizza", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					demo: {
						command: process.execPath,
						args: [FIXTURE],
						description: "Demo fixture MCP server",
					},
				},
			}),
		);

		const previousAgentDir = process.env.PIZZA_CODING_AGENT_DIR;
		process.env.PIZZA_CODING_AGENT_DIR = join(dir, "global-agent");
		const created = await createSessionFacade({
			cwd: dir,
			agentDir: dir,
			storagePath: ":memory:",
		});
		try {
			// Ensure MCP tools are NOT mounted in the LLM request tool list schema
			const runtimeTools = created.runtime.getTools().map((t) => t.name);
			expect(runtimeTools).toEqual(["cli"]);

			// Execute _agentcli through the session extensionRunner
			const builtins = created.facade.extensionRunner.getAllRegisteredBuiltinCommands();
			const agentcli = builtins.find((b) => b.name === "_agentcli");
			expect(agentcli).toBeDefined();

			const parsed = agentcli!.parseArguments(["demo", "echo", "--message", "from-facade", "--upper"]);
			const res = await agentcli!.execute(
				"call-1",
				parsed,
				undefined,
				undefined,
				created.facade.extensionRunner.createContext(),
			);
			const out = JSON.parse(getTextOutput(res));
			expect(out).toMatchObject({
				ok: true,
				server: "demo",
				tool: "echo",
				data: "FROM-FACADE",
			});
			const manage = async (args: string[]) => JSON.parse(getTextOutput(await agentcli!.execute(
				"manage", agentcli!.parseArguments(args), undefined, undefined, created.facade.extensionRunner.createContext(),
			)));
			const configuration = { command: process.execPath, args: [FIXTURE], env: { TEST_VALUE: "a value with spaces" } };
			const toolDetails = await manage(["server", "tools", "demo", "--include-schema"]);
			expect(toolDetails.data.find((tool: { name: string }) => tool.name === "echo").inputSchema).toMatchObject({
				type: "object", required: ["message"], properties: { message: { type: "string" }, times: { type: "integer", default: 1 } },
			});
			expect((await manage(["server", "tools", "demo"])).data.every((tool: { inputSchema?: unknown }) => tool.inputSchema === undefined)).toBe(true);
			expect(await manage(["server", "add", "desktop-test", "--local", "--config", JSON.stringify(configuration)])).toMatchObject({ ok: true });
			const configured = await manage(["server", "list", "--include-config"]);
			expect(configured.data.find((row: { name: string }) => row.name === "desktop-test")).toMatchObject({ scope: "project", state: "connected", config: configuration });
			expect((await manage(["server", "list"])).data.every((row: { config?: unknown }) => row.config === undefined)).toBe(true);
			expect(await manage(["server", "add", "desktop-test", "--local", "--config", JSON.stringify({ ...configuration, enabled: false })])).toMatchObject({ ok: true });
			expect((await manage(["server", "list"])).data.find((row: { name: string }) => row.name === "desktop-test")).toMatchObject({ enabled: false, state: "disabled" });
			expect(await manage(["server", "add", "desktop-test", "--local", "--config", JSON.stringify(configuration)])).toMatchObject({ ok: true });
			expect(await manage(["desktop-test", "echo", "--message", "managed"])).toMatchObject({ ok: true, data: "managed" });
			expect(await manage(["server", "add", "invalid", "--local", "--config", "{}"])).toMatchObject({ ok: false });
			expect(await manage(["server", "remove", "desktop-test", "--local"])).toMatchObject({ ok: true, removed: "desktop-test" });
			expect((await manage(["server", "list"])).data.map((row: { name: string }) => row.name)).not.toContain("desktop-test");
			await manage(["server", "add", "layered", "--config", JSON.stringify({ ...configuration, description: "global" })]);
			await manage(["server", "add", "layered", "--local", "--config", JSON.stringify({ ...configuration, description: "project" })]);
			await manage(["server", "add", "layered", "--config", JSON.stringify({ ...configuration, description: "updated global" })]);
			expect((await manage(["server", "list"])).data.find((row: { name: string }) => row.name === "layered")).toMatchObject({ scope: "project", description: "project" });
			await manage(["server", "remove", "layered", "--local"]);
			expect((await manage(["server", "list"])).data.find((row: { name: string }) => row.name === "layered")).toMatchObject({ scope: "global", description: "updated global", state: "connected" });
			await manage(["server", "remove", "layered"]);

			// A second workspace (or editor) changes the global file while this
			// session is open. Discovery must reconcile it without restarting.
			const globalConfig = join(dir, "global-agent", "mcp.json");
			writeFileSync(globalConfig, JSON.stringify({ mcpServers: { shared: configuration } }));
			expect((await manage(["server", "list"])).data.map((row: { name: string }) => row.name)).toContain("shared");
			expect(await manage(["shared", "echo", "--message", "cross-workspace"])).toMatchObject({ ok: true, data: "cross-workspace" });
			writeFileSync(globalConfig, JSON.stringify({ mcpServers: { shared: { ...configuration, enabled: false } } }));
			expect((await manage(["server", "list"])).data.find((row: { name: string }) => row.name === "shared")).toMatchObject({ state: "disabled" });
			writeFileSync(globalConfig, JSON.stringify({ mcpServers: {} }));
			expect((await manage(["server", "list"])).data.map((row: { name: string }) => row.name)).not.toContain("shared");

		} finally {
			await created.facade.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			created.facade.dispose();
			if (previousAgentDir === undefined) delete process.env.PIZZA_CODING_AGENT_DIR;
			else process.env.PIZZA_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
