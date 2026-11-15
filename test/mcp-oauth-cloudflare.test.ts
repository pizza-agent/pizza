import { describe, expect, it, vi } from "vitest";
import worker from "../infra/mcp-oauth/worker.mjs";
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
	it.each(["/", "/zh/", "/media/pizza-studio.webp"])("serves website assets for %s", async path => {
		const fetch = vi.fn(async () => new Response("website asset", { headers: { "Content-Type": "text/html" } }));
		const request = new Request(new URL(path, base));
		const response = await worker.fetch(request, { ASSETS: { fetch } });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("website asset");
		expect(fetch).toHaveBeenCalledWith(request);
	});
	it.each(["/oauth/client.json", "/oauth/unknown", "/oauth/google/health", "/oauth/google/resources/drive"])("reserves %s ahead of every website fallback", async path => {
		const fetch = vi.fn(async () => new Response("must not override OAuth"));
		const response = await worker.fetch(new Request(new URL(path, base)), { ASSETS: { fetch } });
		expect(fetch).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain("must not override OAuth");
	});
	it("does not accept account data at a website route", async () => {
		const fetch = vi.fn();
		const response = await worker.fetch(new Request(new URL("/", base), { method: "POST", body: "private input" }), { ASSETS: { fetch } });
		expect(response.status).toBe(405);
		expect(fetch).not.toHaveBeenCalled();
	});

});
