import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailApiTransport, GMAIL_API_TOOLS } from "../src/builtin-extensions/connectors/gmail.js";
import { McpClient, type AuthProvider } from "../src/core/mcp/index.js";
import { McpOAuthCredentialStore, McpServerConnection, createDefaultTransport } from "../src/builtin-extensions/mcp/runtime.js";
import { InMemoryAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import { MCP_CONNECTOR_CATALOG, PIZZA_GMAIL_API_MCP_URL } from "../src/builtin-extensions/connectors/catalog.js";
import { validateMcpServerConfig } from "../src/core/mcp/servers.js";
const clients: McpClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); vi.unstubAllGlobals(); });
async function client(fetch: typeof globalThis.fetch, auth: AuthProvider = { token: async () => "fixture-token" }) {
	const c = new McpClient({ name: "test", version: "1" });
	clients.push(c);
	await c.connect(new GmailApiTransport(auth, fetch));
	return c;
}
function output(result: any) { return result.structuredContent ?? JSON.parse(result.content[0].text); }
const msg = { id: "m1", threadId: "t1", payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "Test" }], parts: [{ mimeType: "text/plain", body: { data: Buffer.from("你好\nmail").toString("base64url") } }, { mimeType: "application/pdf", filename: "example.pdf", body: { attachmentId: "a1", size: 12 } }] } };
describe("bundled Gmail MCP adapter", () => {
	it("uses the real McpClient protocol and exposes read/draft tools without sending mail", async () => {
		const fetch = vi.fn();
		const c = await client(fetch);
		const tools = await c.listTools();
		expect(tools).toHaveLength(11);
		expect(tools.some(t => /send|delete/.test(t.name))).toBe(false);
		expect(tools.find(t => t.name === "search_messages")?.annotations?.readOnlyHint).toBe(true);
		expect(tools.find(t => t.name === "create_draft")?.annotations?.readOnlyHint).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("keeps search query/pagination on the fixed Gmail host", async () => {
		const fetch = vi.fn(async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin).toBe("https://gmail.googleapis.com");
			expect(url.pathname).toBe("/gmail/v1/users/me/messages");
			expect(url.searchParams.get("q")).toBe('from:alice@example.com subject:"你好"');
			expect(url.searchParams.get("pageToken")).toBe("next&token");
			expect(url.searchParams.get("maxResults")).toBe("15");
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
			return Response.json({ messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "p2" });
		});
		const c = await client(fetch);
		expect(output(await c.callTool("search_messages", { query: 'from:alice@example.com subject:"你好"', page_token: "next&token", max_results: 15 })).nextPageToken).toBe("p2");
	});
	it("decodes MIME bodies and preserves attachment identifiers", async () => {
		const c = await client(vi.fn(async () => Response.json(msg)));
		expect(output(await c.callTool("get_message", { message_id: "m1" }))).toMatchObject({ text: "你好\nmail", attachments: [{ attachmentId: "a1", filename: "example.pdf" }] });
	});
	it.each(["get_thread", "get_draft"])("decodes nested messages in %s", async (name) => {
		const c = await client(vi.fn(async () => Response.json(name === "get_thread" ? { id: "t1", messages: [msg] } : { id: "d1", message: msg })));
		const value = output(await c.callTool(name, name === "get_thread" ? { thread_id: "t1" } : { draft_id: "d1" }));
		expect((value.messages?.[0] ?? value.message).text).toBe("你好\nmail");
	});
	it.each(["create_draft", "update_draft"])("serializes Unicode MIME safely for %s", async (name) => {
		const fetch = vi.fn(async (input, init) => {
			expect(String(input)).toBe(`${PIZZA_GMAIL_API_MCP_URL}/drafts${name === "update_draft" ? "/d1" : ""}`);
			expect(init?.method).toBe(name === "update_draft" ? "PUT" : "POST");
			const { message } = JSON.parse(init?.body as string);
			const raw = Buffer.from(message.raw, "base64url").toString();
			expect(raw).toContain("To: alice@example.com\r\n");
			expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from("你好").toString("base64")}?=`);
			expect(Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString()).toBe("正文\r\n第二行");
			return Response.json({ id: "d1", message: { id: "m2" } });
		});
		const c = await client(fetch);
		expect(output(await c.callTool(name, { to: ["alice@example.com"], subject: "你好", body: "正文\n第二行", ...(name === "update_draft" ? { draft_id: "d1" } : {}) })).id).toBe("d1");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("creates a threaded reply draft with Reply-To and RFC reply headers", async () => {
		const fetch = vi.fn(async (input, init) => {
			if (init?.method === "GET")
				return Response.json({ threadId: "t1", payload: { headers: [{ name: "Reply-To", value: "reply@example.com" }, { name: "From", value: "sender@example.com" }, { name: "Subject", value: "Question" }, { name: "Message-ID", value: "<old@example.com>" }, { name: "References", value: "<first@example.com>" }] } });
			const { message } = JSON.parse(init?.body as string);
			expect(message.threadId).toBe("t1");
			const raw = Buffer.from(message.raw, "base64url").toString();
			expect(raw).toContain("To: reply@example.com");
			expect(raw).toContain("Subject: Re: Question");
			expect(raw).toContain("In-Reply-To: <old@example.com>");
			expect(raw).toContain("References: <first@example.com> <old@example.com>");
			return Response.json({ id: "reply-draft" });
		});
		const c = await client(fetch);
		expect(output(await c.callTool("create_reply_draft", { message_id: "m1", body: "Answer" })).id).toBe("reply-draft");
	});
	it.each([{ subject: "Hello\r\nBcc: hidden@example.com", to: ["alice@example.com"], body: "x" }, { subject: "Hello", to: ["alice@example.com\nBcc: hidden@example.com"], body: "x" }])("rejects header injection before network access", async (args) => {
		const fetch = vi.fn();
		const c = await client(fetch);
		expect((await c.callTool("create_draft", args)).isError).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("rejects path traversal, unknown tools and unbounded pagination", async () => {
		const fetch = vi.fn();
		const c = await client(fetch);
		for (const [name, args] of [["get_message", { message_id: "../profile" }], ["search_messages", { max_results: 10000 }], ["send_message", {}]] as const)
			expect((await c.callTool(name, args)).isError).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("refreshes once after a 401 and retries with the new access token", async () => {
		let token = "old";
		const auth = { token: async () => token, onUnauthorized: vi.fn(async () => { token = "new"; }) };
		const fetch = vi.fn(async (_url, init) => new Headers(init?.headers).get("Authorization") === "Bearer old" ? new Response("", { status: 401 }) : Response.json({ labels: [] }));
		const c = await client(fetch, auth);
		expect(output(await c.callTool("list_labels", {}))).toEqual({ labels: [] });
		expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("shows Gmail's exact project configuration failure without retrying a write", async () => {
		const fetch = vi.fn(async () => Response.json({ error: { message: "Gmail API is disabled for this project" } }, { status: 403 }));
		const c = await client(fetch);
		const r = await c.callTool("create_draft", { to: ["alice@example.com"], subject: "Test", body: "Test" });
		expect(r.isError).toBe(true);
		expect(r.content[0]).toMatchObject({ text: expect.stringContaining("Gmail API is disabled") });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("does not dispatch a cancelled call after awaiting its token", async () => {
		let resolve!: (token: string) => void;
		const token = new Promise<string>(r => { resolve = r; });
		const fetch = vi.fn();
		const c = await client(fetch, { token: () => token });
		const controller = new AbortController();
		const pending = c.callTool("list_labels", {}, { signal: controller.signal }).catch(e => e);
		controller.abort();
		resolve("late-token");
		await pending;
		await new Promise(r => setTimeout(r, 0));
		expect(fetch).not.toHaveBeenCalled();
	});
	it("requires real mailbox authorization before declaring the bundled adapter connected", async () => {
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const config = MCP_CONNECTOR_CATALOG.find(t => t.name === "gmail")!.config;
		const c = new McpServerConnection({ entry: { name: "gmail", source: "global", config: config as any }, cwd: process.cwd(), credentials, createTransport: createDefaultTransport, onTools: () => { } });
		try {
			await expect(c.getClient()).rejects.toThrow("requires sign-in");
			expect(c.state).toBe("needs-auth");
			expect(c.oauthSettings().clientSecret).toBeUndefined();
		}
		finally {
			await c.close();
		}
	});
	it("does not let adapter configuration redirect credentials to another host", () => {
		const auth={token:vi.fn(async()=>"fixture")};
		expect(()=>createDefaultTransport({name:"gmail",source:"global",config:{url:"https://attacker.example",adapter:"gmail"}},process.cwd(),auth)).toThrow("Invalid adapter resource URL");
		expect(auth.token).not.toHaveBeenCalled();
		expect(typeof validateMcpServerConfig("gmail", MCP_CONNECTOR_CATALOG.find(t => t.name === "gmail")!.config)).toBe("object");
	});
});
