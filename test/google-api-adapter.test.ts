import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleApiTransport, googleApiTools } from "../src/builtin-extensions/connectors/google-api.js";
import { GOOGLE_API_SERVICES, googleApiService } from "../src/builtin-extensions/connectors/google-services.js";
import { createConnectorTransport, resolveConnectorOAuth } from "../src/builtin-extensions/connectors/registry.js";
import { MCP_CONNECTOR_CATALOG } from "../src/builtin-extensions/connectors/catalog.js";
import { McpClient, type AuthProvider } from "../src/core/mcp/index.js";
import { McpOAuthCredentialStore, McpServerConnection, createDefaultTransport } from "../src/builtin-extensions/mcp/runtime.js";
import { InMemoryAuthStorageBackend } from "../src/core/auth/auth-storage.js";
import { validateMcpServerConfig } from "../src/core/mcp/servers.js";
type Product = Exclude<(typeof GOOGLE_API_SERVICES)[number]["product"], "gmail">;
const clients: McpClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); vi.unstubAllGlobals(); });
async function client(product: Product, fetch: typeof globalThis.fetch, auth: AuthProvider = { token: async () => "fixture-token" }) {
 const c = new McpClient({ name: "test", version: "1" }); clients.push(c); await c.connect(new GoogleApiTransport(product, auth, fetch)); return c;
}
const cases: Array<[Product, string, Record<string, unknown>, string, string]> = [
 ["drive", "get_profile", {}, "GET", "/drive/v3/about"],
 ["drive", "search_files", { query: "name contains 'Budget'", page_size: 2, page_token: "next&token" }, "GET", "/drive/v3/files"],
 ["drive", "list_recent_files", {}, "GET", "/drive/v3/files"],
 ["drive", "get_file_metadata", { file_id: "file-1" }, "GET", "/drive/v3/files/file-1"],
 ["drive", "get_file_permissions", { file_id: "file-1" }, "GET", "/drive/v3/files/file-1/permissions"],
 ["drive", "read_file_content", { file_id: "file-1" }, "GET", "/drive/v3/files/file-1"],
 ["drive", "download_file_content", { file_id: "file-1" }, "GET", "/drive/v3/files/file-1"],
 ["drive", "export_file", { file_id: "file-1", mime_type: "application/pdf" }, "GET", "/drive/v3/files/file-1/export"],
 ["drive", "create_file", { name: "Fixture" }, "POST", "/drive/v3/files"],
 ["drive", "copy_file", { file_id: "file-1" }, "POST", "/drive/v3/files/file-1/copy"],
 ["drive", "update_file", { file_id: "file-1", name: "Renamed" }, "PATCH", "/drive/v3/files/file-1"],
 ["docs", "list_documents", {}, "GET", "/drive/v3/files"],
 ["docs", "read_document", { document_id: "doc-1" }, "GET", "/v1/documents/doc-1"],
 ["docs", "create_document", { title: "Fixture" }, "POST", "/v1/documents"],
 ["docs", "batch_update", { document_id: "doc-1", requests: [{ insertText: { text: "hello", endOfSegmentLocation: {} } }], required_revision_id: "r1" }, "POST", "/v1/documents/doc-1:batchUpdate"],
 ["sheets", "list_spreadsheets", {}, "GET", "/drive/v3/files"],
 ["sheets", "get_spreadsheet", { spreadsheet_id: "s1" }, "GET", "/v4/spreadsheets/s1"],
 ["sheets", "get_values", { spreadsheet_id: "s1", range: "Budget!A1:D20" }, "GET", "/v4/spreadsheets/s1/values/Budget!A1%3AD20"],
 ["sheets", "create_spreadsheet", { title: "Fixture", sheet_titles: ["Budget"] }, "POST", "/v4/spreadsheets"],
 ["sheets", "update_values", { spreadsheet_id: "s1", range: "A1", values: [["=SUM(B1:B2)", 42, true, null]] }, "PUT", "/v4/spreadsheets/s1/values/A1"],
 ["sheets", "append_values", { spreadsheet_id: "s1", range: "A1", values: [["literal"]] }, "POST", "/v4/spreadsheets/s1/values/A1:append"],
 ["sheets", "clear_values", { spreadsheet_id: "s1", range: "A1" }, "POST", "/v4/spreadsheets/s1/values/A1:clear"],
 ["sheets", "batch_update", { spreadsheet_id: "s1", requests: [{ addSheet: { properties: { title: "Fixture" } } }] }, "POST", "/v4/spreadsheets/s1:batchUpdate"],
 ["slides", "list_presentations", {}, "GET", "/drive/v3/files"],
 ["slides", "read_presentation", { presentation_id: "p1" }, "GET", "/v1/presentations/p1"],
 ["slides", "get_page", { presentation_id: "p1", page_id: "page1" }, "GET", "/v1/presentations/p1/pages/page1"],
 ["slides", "create_presentation", { title: "Fixture" }, "POST", "/v1/presentations"],
 ["slides", "batch_update", { presentation_id: "p1", requests: [{ createSlide: {} }], required_revision_id: "r1" }, "POST", "/v1/presentations/p1:batchUpdate"],
 ["calendar", "list_calendars", {}, "GET", "/calendar/v3/users/me/calendarList"],
 ["calendar", "get_calendar", {}, "GET", "/calendar/v3/users/me/calendarList/primary"],
 ["calendar", "list_events", {}, "GET", "/calendar/v3/calendars/primary/events"],
 ["calendar", "get_event", { event_id: "e1" }, "GET", "/calendar/v3/calendars/primary/events/e1"],
 ["calendar", "query_freebusy", { calendar_ids: ["primary"], time_min: "2026-11-01T00:00:00Z", time_max: "2026-11-02T00:00:00Z" }, "POST", "/calendar/v3/freeBusy"],
 ["calendar", "create_event", { summary: "Fixture", start: { date: "2026-11-01" }, end: { date: "2026-11-02" } }, "POST", "/calendar/v3/calendars/primary/events"],
 ["calendar", "update_event", { event_id: "e1", summary: "Updated" }, "PATCH", "/calendar/v3/calendars/primary/events/e1"],
 ["chat", "list_spaces", {}, "GET", "/v1/spaces"],
 ["chat", "get_space", { name: "spaces/s1" }, "GET", "/v1/spaces/s1"],
 ["chat", "list_messages", { space: "spaces/s1" }, "GET", "/v1/spaces/s1/messages"],
 ["chat", "get_message", { name: "spaces/s1/messages/m1.m1" }, "GET", "/v1/spaces/s1/messages/m1.m1"],
 ["chat", "create_message", { space: "spaces/s1", text: "Fixture", request_id: "b3cc4bbe-3806-4117-b071-09b520075196" }, "POST", "/v1/spaces/s1/messages"],
 ["people", "get_profile", {}, "GET", "/v1/people/me"],
 ["people", "get_person", { resource_name: "people/c1", person_fields: ["names"] }, "GET", "/v1/people/c1"],
 ["people", "list_contacts", {}, "GET", "/v1/people/me/connections"],
 ["people", "search_contacts", { query: "Alice" }, "GET", "/v1/people:searchContacts"],
];
describe("stable Google API MCP adapters", () => {
 it.each(cases)("maps %s/%s to the documented method and endpoint", async (product, tool, args, method, path) => {
  const fetch = vi.fn(async (input, init) => {
   const url = new URL(String(input)); expect(url.pathname).toBe(path); expect(init?.method).toBe(method); expect(init?.redirect).toBe("error");
   expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
   const body = init?.body ? JSON.parse(String(init.body)) : undefined;
   if (tool === "search_files") { expect(url.searchParams.get("pageToken")).toBe("next&token"); expect(url.searchParams.get("pageSize")).toBe("2"); }
   if (tool.startsWith("list_") && ["docs", "sheets", "slides"].includes(product)) expect(url.searchParams.get("q")).toContain("mimeType = '");
   if (["update_values", "append_values"].includes(tool)) expect(url.searchParams.get("valueInputOption")).toBe("RAW");
   if (tool === "batch_update" && product !== "sheets") expect(body.writeControl).toEqual({ requiredRevisionId: "r1" });
   if (["create_event", "update_event"].includes(tool)) expect(url.searchParams.get("sendUpdates")).toBe("none");
   if (tool === "list_events") expect(url.searchParams.get("singleEvents")).toBe("true");
   if (tool === "list_messages") expect(url.searchParams.get("orderBy")).toBe("createTime DESC");
   if (tool === "create_message") expect(url.searchParams.get("requestId")).toBe(args.request_id);
   if (tool === "search_contacts") expect(url.searchParams.get("readMask")).toBe("names,emailAddresses");
   if (tool === "read_file_content" && url.searchParams.get("fields")) return Response.json({ mimeType: "text/plain" });
   if (["read_file_content", "download_file_content", "export_file"].includes(tool)) return new Response("fixture content", { headers: { "Content-Type": "text/plain" } });
   return Response.json({ fixture: true, nextPageToken: "next-page" });
  });
  const c = await client(product, fetch); const result = await c.callTool(tool, args);
  expect(result.isError).not.toBe(true); expect(result.structuredContent).toBeDefined(); expect(fetch).toHaveBeenCalledTimes(tool === "read_file_content" ? 2 : 1);
 });
 it("exposes every implemented tool and marks writes accurately", () => {
  for (const product of new Set(cases.map(c => c[0]))) {
   const tools = googleApiTools(product); expect(tools.map(t => t.name).sort()).toEqual(cases.filter(c => c[0] === product).map(c => c[1]).sort());
   expect(tools.every(t => t.outputSchema?.type === "object")).toBe(true);
   expect(tools.filter(t => t.annotations?.readOnlyHint).every(t => !t.annotations?.destructiveHint)).toBe(true);
   expect(tools.filter(t => !t.annotations?.readOnlyHint).every(t => !t.annotations?.idempotentHint)).toBe(true);
  }
 });
 it.each([403, 429, 500, 503])("never replays a write after HTTP %s", async status => {
  const fetch = vi.fn(async () => Response.json({ error: { message: "provider failure" } }, { status }));
  const c = await client("docs", fetch); expect((await c.callTool("create_document", { title: "Test" })).isError).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
 });
 it("refreshes exactly once on 401 using the bound resource", async () => {
  let token = "old"; const auth = { token: async () => token, onUnauthorized: vi.fn(async context => { expect(context.serverUrl.href).toBe("https://www.googleapis.com/drive/v3"); token = "new"; }) };
  const fetch = vi.fn(async (_url, init) => new Headers(init?.headers).get("Authorization") === "Bearer old" ? new Response(null, { status: 401 }) : Response.json({ files: [] }));
  const c = await client("drive", fetch, auth); expect((await c.callTool("list_recent_files", {})).isError).not.toBe(true); expect(fetch).toHaveBeenCalledTimes(2); expect(auth.onUnauthorized).toHaveBeenCalledTimes(1);
 });
 it("rejects traversal, foreign URLs, unknown tools and unbounded pagination before fetching", async () => {
  const fetch = vi.fn(); const c = await client("drive", fetch);
  for (const [name, args] of [["get_file_metadata", { file_id: "../token" }], ["get_file_metadata", { file_id: "https://evil.example" }], ["search_files", { page_size: 101 }], ["__proto__", {}], ["get_profile", { url: "https://evil.example" }]] as const) expect((await c.callTool(name, args)).isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
 });
 it("bounds downloads and streaming bodies without trusting content-length", async () => {
  const c = await client("drive", vi.fn(async () => new Response("12345")));
  expect((await c.callTool("download_file_content", { file_id: "f1", max_bytes: 4 })).isError).toBe(true);
 });
 it("exports native document content through the fixed Drive endpoint", async () => {
  const fetch = vi.fn(async input => String(input).includes("fields=mimeType") ? Response.json({ mimeType: "application/vnd.google-apps.document" }) : new Response("Hello"));
  const c = await client("drive", fetch); expect((await c.callTool("read_file_content", { file_id: "doc1" })).structuredContent).toMatchObject({ encoding: "utf8", content: "Hello" });
  expect(String(fetch.mock.calls[1][0])).toBe("https://www.googleapis.com/drive/v3/files/doc1/export?mimeType=text%2Fplain");
 });
 it("does not dispatch a cancelled write after waiting for its token", async () => {
  let resolve!: (token: string) => void; const token = new Promise<string>(r => { resolve = r; }); const fetch = vi.fn(); const c = await client("docs", fetch, { token: () => token });
  const controller = new AbortController(); const pending = c.callTool("create_document", { title: "Test" }, { signal: controller.signal }).catch(e => e); controller.abort(); resolve("late"); await pending; await new Promise(r => setTimeout(r, 0)); expect(fetch).not.toHaveBeenCalled();
 });
 it.each(GOOGLE_API_SERVICES.filter(service => service.product !== "gmail"))("checks real API access before reporting $name connected", async service => {
  const config = MCP_CONNECTOR_CATALOG.find(entry => entry.name === service.name)!.config;
  const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
  const c = new McpServerConnection({ entry: { name: service.name, source: "global", config }, cwd: process.cwd(), credentials, createTransport: createDefaultTransport, onTools: () => {} });
  try {
   await expect(c.getClient()).rejects.toThrow("requires sign-in");
   await credentials.forServer(service.name, service.resource).save({ serverUrl: service.resource, credentialBinding: { issuer: "https://pizza.hertzbeat.com/oauth/google", clientId: "pizza-desktop-google", resource: service.resource }, tokens: { access_token: "fixture-authorized", token_type: "Bearer" } });
   vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "API disabled or account unavailable" } }, { status: 403 })));
   await expect(c.getClient()).rejects.toThrow("API disabled or account unavailable");
   expect(c.state).toBe("failed"); expect(c.tools).toEqual([]);
  } finally { await c.close(); }
 });
 it("keeps schema defaults optional for command-line discovery", () => {
  expect(googleApiTools("drive").find(t => t.name === "list_recent_files")?.inputSchema.required ?? []).not.toContain("page_size");
  expect(googleApiTools("calendar").find(t => t.name === "get_calendar")?.inputSchema.required ?? []).not.toContain("calendar_id");
 });
 it("only installs adapters for their canonical product resource", () => {
  for (const service of GOOGLE_API_SERVICES) {
   const config = MCP_CONNECTOR_CATALOG.find(e => e.name === service.name)!.config;
   expect(googleApiService(config)).toBe(service); expect(validateMcpServerConfig(service.name, config)).toMatchObject(config);
   expect(() => createConnectorTransport({ name: service.name, source: "global", config: { ...config, url: "https://evil.example" } })).toThrow("Invalid adapter");
   const oauth = resolveConnectorOAuth({ name: "renamed", source: "global", config }); expect(oauth?.resourceMetadataUrl).toBe(`https://pizza.hertzbeat.com/oauth/google/resources/${service.product}`);
  }
 });
 it.each(["http://evil.example/resource", "https://user:secret@example.com/metadata", "https://example.com/meta#fragment"])("rejects unsafe resource metadata configuration: %s", resourceMetadataUrl => {
  expect(validateMcpServerConfig("fixture", { url: "https://example.com/mcp", oauth: { resourceMetadataUrl } })).toContain("resourceMetadataUrl");
 });
});
