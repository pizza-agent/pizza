import { describe, expect, it } from "vitest";
import worker from "../examples/mcp-oauth/worker.mjs";
import { createNativeClientMetadata, oauthCallbackId } from "../src/core/mcp/oauth/client-metadata.js";

const base = "https://pizza.hertzbeat.com/oauth/client.json";

describe("Cloudflare OAuth metadata Worker", () => {
	it.each([undefined, oauthCallbackId("https://mcp.notion.com/mcp")])("publishes a canonical client identity with its allowed callbacks: %s", async (id) => {
		const document = createNativeClientMetadata(base, id);
		const response = worker.fetch(new Request(document.client_id));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
		expect(await response.json()).toEqual(document);
	});

	it("returns headers without a response body for HEAD requests", async () => {
		const response = worker.fetch(new Request(base, { method: "HEAD" }));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.text()).toBe("");
	});

	it.each(["/", "/callback", "/oauth/wrong/client.json", "/oauth/client.json?token=unexpected", "/other/abcdefghijkl/client.json"])("does not serve user input or unrelated paths: %s", (path) => {
		expect(worker.fetch(new Request(new URL(path, base))).status).toBe(404);
	});

	it.each(["POST", "PUT", "DELETE"])("rejects %s rather than accepting account data", async (method) => {
		const response = worker.fetch(new Request(base, { method }));
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, HEAD");
		expect(await response.text()).toBe("");
	});

	it("does not construct the client ID from an untrusted request host", async () => {
		const response = worker.fetch(new Request("https://other.example/oauth/client.json"));
		expect(await response.json()).toEqual(createNativeClientMetadata(base));
	});
});
