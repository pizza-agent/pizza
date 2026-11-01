import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../packages/rpc/rpc-client.js";
import { MCP_LOGIN_RPC_TIMEOUT_MS } from "../packages/protocol/index.js";

function clientWithPipe() {
	const client = new RpcClient();
	const internals = client as unknown as {
		process: { stdin: { write: ReturnType<typeof vi.fn> } };
		handleLine(line: string): void;
	};
	internals.process = { stdin: { write: vi.fn() } };
	return { client, respond: (id: string) => internals.handleLine(JSON.stringify({ type: "response", command: "mcp_command", id, success: true, data: { text: '{"ok":true}' } })) };
}

afterEach(() => vi.useRealTimers());

describe("RPC timeouts during MCP login", () => {
	it("accepts successful authorization after the ordinary 30-second deadline", async () => {
		vi.useFakeTimers();
		const { client, respond } = clientWithPipe();
		let settled = false;
		const login = client.sendCommand({ type: "mcp_command", id: "login", args: ["server", "login", "github"] });
		void login.then(() => { settled = true; }, () => { settled = true; });
		await vi.advanceTimersByTimeAsync(31_000);
		expect(settled).toBe(false);
		respond("login");
		await expect(login).resolves.toMatchObject({ success: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("still bounds a login that never finishes", async () => {
		vi.useFakeTimers();
		const { client } = clientWithPipe();
		const result = client.sendCommand({ type: "mcp_command", args: ["server", "login", "github"] }).catch((error) => error);
		await vi.advanceTimersByTimeAsync(MCP_LOGIN_RPC_TIMEOUT_MS);
		expect(await result).toBeInstanceOf(Error);
		expect((await result).message).toContain("Timeout waiting for response to mcp_command");
	});

	it.each([["server", "list"], ["server", "login-cancel"], ["github", "get_me"]])("keeps ordinary MCP commands bounded by 30 seconds: %j", async (...args) => {
		vi.useFakeTimers();
		const { client } = clientWithPipe();
		const result = client.sendCommand({ type: "mcp_command", args }).catch((error) => error);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await result).toBeInstanceOf(Error);
	});

	it("preserves an explicit caller timeout for login", async () => {
		vi.useFakeTimers();
		const { client } = clientWithPipe();
		const result = client.sendCommand({ type: "mcp_command", args: ["server", "login", "github"] }, 5000).catch((error) => error);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await result).toBeInstanceOf(Error);
	});
});
