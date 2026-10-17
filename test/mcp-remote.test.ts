import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
} from "../src/builtin-extensions/mcp/runtime.js";
import { createSessionFacade } from "../src/core/session/session-facade-factory.js";
import { getTextOutput } from "../src/core/tools/render-utils.js";

async function startServer(
	mode: string,
	initDelayMs = 0,
): Promise<{ child: ChildProcess; url: string; stop: () => Promise<void> }> {
	const child = spawn(
		process.execPath,
		[resolve(import.meta.dirname, "fixtures/mcp/http-server.mjs")],
		{
			env: {
				...process.env,
				MCP_TEST_RESPONSE: mode,
				MCP_TEST_INIT_DELAY_MS: String(initDelayMs),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const url = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("HTTP fixture startup timed out")),
			5000,
		);
		child.once("error", reject);
		child.stdout!.once("data", (data) => {
			clearTimeout(timer);
			resolve(JSON.parse(data.toString()).url);
		});
	});
	return {
		child,
		url,
		stop: () =>
			new Promise<void>((resolve) => {
				child.once("exit", () => resolve());
				child.kill();
			}),
	};
}

describe("Remote MCP through _agentcli", () => {
	let isolatedAgentDir: string;
	beforeEach(() => {
		isolatedAgentDir = mkdtempSync(join(tmpdir(), "pizza-remote-agent-"));
		vi.stubEnv("PIZZA_CODING_AGENT_DIR", isolatedAgentDir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(isolatedAgentDir, { recursive: true, force: true });
	});
	it.each(["json", "sse"])(
		"loads authenticated %s HTTP servers, calls tools and recovers expired sessions",
		async (mode) => {
			const server = await startServer(mode);
			const dir = mkdtempSync(join(tmpdir(), "pizza-remote-test-"));
			mkdirSync(join(dir, ".pizza"));
			writeFileSync(
				join(dir, ".pizza/mcp.json"),
				JSON.stringify({
					mcpServers: {
						remote: {
							url: server.url,
							headers: { Authorization: "Bearer fixture-token" },
						},
					},
				}),
			);
			const created = await createSessionFacade({
				cwd: dir,
				agentDir: dir,
				storagePath: ":memory:",
			});
			try {
				expect(created.runtime.getTools().map((tool) => tool.name)).toEqual([
					"cli",
				]);
				const runner = created.facade.extensionRunner;
				const builtin = runner
					.getAllRegisteredBuiltinCommands()
					.find((command) => command.name === "_agentcli")!;
				const call = async (args: string[]) =>
					JSON.parse(
						getTextOutput(
							await builtin.execute(
								"remote-test",
								builtin.parseArguments(args),
								undefined,
								undefined,
								runner.createContext(),
							),
						),
					);
				expect(
					(await call(["server", "list", "--wait"])).data[0],
				).toMatchObject({
					type: "http",
					state: "connected",
					tools: 2,
				});
				expect(
					await call(["remote", "echo", "--message", "over-http"]),
				).toMatchObject({
					ok: true,
					data: { message: "over-http", responseMode: mode, session: 1 },
				});
				expect(
					await call(["remote", "expire_once", "--message", "recovered"]),
				).toMatchObject({
					ok: true,
					data: { message: "recovered", session: 2 },
				});
				expect((await call(["remote", "resources"])).ok).toBe(true);
				expect(
					getTextOutput(
						await builtin.execute(
							"read-resource",
							builtin.parseArguments(["remote", "resource", "remote://status"]),
							undefined,
							undefined,
							runner.createContext(),
						),
					),
				).toContain("remote-ready");
				expect(created.runtime.getTools().map((tool) => tool.name)).toEqual([
					"cli",
				]);
			} finally {
				await created.facade.extensionRunner.emit({
					type: "session_shutdown",
					reason: "quit",
				});
				created.facade.dispose();
				await server.stop();
				rmSync(dir, { recursive: true, force: true });
			}
		},
		15000,
	);

	it("does not block discovery or a healthy server behind a slow server", async () => {
		const slow = await startServer("json", 5000);
		const fast = await startServer("json");
		const dir = mkdtempSync(join(tmpdir(), "pizza-remote-slow-"));
		mkdirSync(join(dir, ".pizza"));
		const config = (url: string) => ({
			url,
			headers: { Authorization: "Bearer fixture-token" },
		});
		writeFileSync(
			join(dir, ".pizza/mcp.json"),
			JSON.stringify({
				mcpServers: { slow: config(slow.url), fast: config(fast.url) },
			}),
		);
		const created = await createSessionFacade({
			cwd: dir,
			agentDir: dir,
			storagePath: ":memory:",
		});
		try {
			const runner = created.facade.extensionRunner;
			const builtin = runner
				.getAllRegisteredBuiltinCommands()
				.find((command) => command.name === "_agentcli")!;
			const call = async (args: string[]) =>
				getTextOutput(
					await builtin.execute(
						"slow-test",
						builtin.parseArguments(args),
						undefined,
						undefined,
						runner.createContext(),
					),
				);
			const start = performance.now();
			const listed = JSON.parse(await call(["server", "list"]));
			expect(listed.data.map((row: { name: string }) => row.name)).toEqual([
				"slow",
				"fast",
			]);
			expect(performance.now() - start).toBeLessThan(1500);
			expect(await call(["-h"])).toContain("slow");
			expect(
				JSON.parse(await call(["fast", "echo", "--message", "healthy"])),
			).toMatchObject({ ok: true, data: { message: "healthy" } });
			expect(performance.now() - start).toBeLessThan(1500);
		} finally {
			await created.facade.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			created.facade.dispose();
			await slow.stop();
			await fast.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15000);

	it("rejects invalid bearer credentials without exposing a connected server", async () => {
		const server = await startServer("sse");
		const connection = new McpServerConnection({
			entry: {
				name: "unauthorized",
				source: "test",
				config: {
					url: server.url,
					headers: { Authorization: "Bearer wrong" },
					timeout: 2,
				},
			},
			cwd: tmpdir(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(
				new InMemoryAuthStorageBackend(),
			),
			onTools: () => {},
		});
		try {
			await expect(connection.getClient()).rejects.toThrow(
				/authentication|401|Unauthorized/,
			);
			expect(connection.state).toBe("failed");
		} finally {
			await connection.close();
			await server.stop();
		}
	});
});
