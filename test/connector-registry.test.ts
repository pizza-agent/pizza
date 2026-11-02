import { describe, it, expect } from "vitest";
import { resolveConnectorOAuth } from "../src/builtin-extensions/connectors/registry.js";
import {
	PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID,
	PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL,
} from "../src/builtin-extensions/connectors/catalog.js";
describe("connector policy compatibility", () => {
	it("preserves GitHub public-client defaults across official resource paths and undefined legacy fields", () => {
		const oauth = resolveConnectorOAuth({
			name: "github",
			source: "global",
			config: {
				url: "https://api.githubcopilot.com/mcp/readonly",
				oauth: { clientId: PIZZA_GITHUB_MCP_OAUTH_CLIENT_ID, deviceAuthorizationUrl: undefined, scope: undefined },
			},
		});
		expect(oauth).toMatchObject({ deviceAuthorizationUrl: PIZZA_GITHUB_MCP_OAUTH_DEVICE_URL, scope: "repo read:user" });
	});
	it("does not apply product registration or flow defaults to a custom app", () => {
		const configured = { clientId: "custom-app", clientSecret: "fixture" };
		expect(
			resolveConnectorOAuth({
				name: "github",
				source: "global",
				config: { url: "https://api.githubcopilot.com/mcp/readonly", oauth: configured },
			}),
		).toEqual(configured);
	});
});
