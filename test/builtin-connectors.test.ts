import { describe, expect, it } from "vitest";
import {
	BUILTIN_MCP_CONNECTORS,
	CONNECTORS_EXTENSION_ID,
	createConnectorsExtension,
	MCP_CONNECTOR_CATALOG,
	PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL,
	PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID,
	PIZZA_GITHUB_OAUTH_AS_METADATA,
} from "../src/builtin-extensions/connectors/index.js";
import {
	BUILTIN_EXTENSIONS,
	getBuiltinExtensionFactories,
	getBuiltinExtensionIds,
} from "../src/builtin-extensions/index.js";
import { validateMcpServerConfig } from "../src/core/mcp/servers.js";

describe("MCP connector catalog (marketplace-only)", () => {
	it("is not registered as a built-in extension (nothing auto-installed)", () => {
		expect(getBuiltinExtensionIds()).not.toContain(CONNECTORS_EXTENSION_ID);
		expect(BUILTIN_EXTENSIONS.find((e) => e.id === CONNECTORS_EXTENSION_ID)).toBeUndefined();
		const enabled = getBuiltinExtensionFactories(new Set());
		expect(enabled.some((e) => e.id === CONNECTORS_EXTENSION_ID)).toBe(false);
	});

	it("does not auto-register MCP servers on load", () => {
		const registered: Array<{ name: string; config: unknown }> = [];
		createConnectorsExtension({
			registerMcpServer: (name, config) => registered.push({ name, config }),
		} as never);
		expect(registered).toEqual([]);
	});

	it("ships the official marketplace connector names", () => {
		expect(MCP_CONNECTOR_CATALOG.map((entry) => entry.name).sort()).toEqual([
			"github",
			"gmail",
			"notion",
			"x",
		]);
		expect(BUILTIN_MCP_CONNECTORS.map((entry) => entry.name).sort()).toEqual([
			"github",
			"gmail",
			"notion",
			"x",
		]);
	});

	it("ships valid MCP server configs for marketplace install", () => {
		for (const { name, config } of BUILTIN_MCP_CONNECTORS) {
			const validated = validateMcpServerConfig(name, config);
			expect(typeof validated).not.toBe("string");
		}
	});

	it("does not ship Cursor-only Origin or Finance endpoints", () => {
		const names = new Set(BUILTIN_MCP_CONNECTORS.map((entry) => entry.name));
		expect(names.has("origin")).toBe(false);
		expect(names.has("finance")).toBe(false);
	});

	it("connects X directly over HTTP and configures its own OAuth client before sign-in", () => {
		const x = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "x");
		expect(x).toMatchObject({ type: "http", oauthSetup: "x", config: { url: "https://api.x.com/mcp", oauth: { scope: "tweet.read users.read offline.access", callbackUrl: "http://127.0.0.1:8766/callback" } } });
		expect(x?.config.command).toBeUndefined();
		expect(x?.config.env).toBeUndefined();
	});
	it("ships GitHub as a public device client with baked-in product clientId", () => {
		const github = MCP_CONNECTOR_CATALOG.find((entry) => entry.name === "github");
		expect(github).toBeDefined();
		const oauth = github?.config.oauth as Record<string, unknown> | undefined;
		expect(oauth).toMatchObject({
			clientId: PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID,
			deviceAuthorizationUrl: "https://github.com/login/device/code",
			scope: "repo read:user",
			callbackUrl: PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL,
			authorizationServerMetadata: PIZZA_GITHUB_OAUTH_AS_METADATA,
		});
		expect(oauth?.clientSecret).toBeUndefined();
		expect(PIZZA_GITHUB_OAUTH_AS_METADATA.authorization_endpoint).toContain("/login/oauth/authorize");
		expect(PIZZA_GITHUB_OAUTH_AS_METADATA.token_endpoint_auth_methods_supported).not.toContain("none");
		expect(PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID.length).toBeGreaterThan(8);
		expect(PIZZA_GITHUB_MCP_OAUTH_CALLBACK_URL).toBe("http://127.0.0.1/callback");
	});

});
