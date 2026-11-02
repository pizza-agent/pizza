import { describe, expect, it } from "vitest";
import {
	needsSignIn,
	parseMcpDevicePrompt,
	canPasteMcpRedirect,
	shouldAutoSignInAfterInstall,
	type McpSignInServer,
} from "../apps/web/src/lib/mcp-signin";

function server(partial: Partial<McpSignInServer> & Pick<McpSignInServer, "name">): McpSignInServer {
	return {
		type: "http",
		enabled: true,
		state: "starting",
		...partial,
	};
}

describe("needsSignIn", () => {
	it("is true for needs-auth", () => {
		expect(needsSignIn(server({ name: "github", state: "needs-auth" }))).toBe(true);
	});

	it("is true for failed http with auth-shaped error", () => {
		expect(
			needsSignIn(
				server({ name: "notion", state: "failed", error: "Unauthorized — login required" }),
			),
		).toBe(true);
	});

	it("is false for connected auth-free servers", () => {
		expect(needsSignIn(server({ name: "deepwiki", state: "connected" }))).toBe(false);
	});
});

describe("device sign-in status", () => {
	it("reads the public code and expiry without exposing the device credential", () => {
		expect(parseMcpDevicePrompt(JSON.stringify({ userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: 123, device_code: "private" }))).toEqual({ userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: 123 });
	});
	it.each(["invalid json", "null", '{}', '{"userCode":"ABC","verificationUri":"javascript:alert(1)","expiresAt":123}'])("ignores malformed or unsafe UI events", (value) => {
		expect(parseMcpDevicePrompt(value)).toBeUndefined();
	});
});

describe("optional redirect recovery", () => {
	const active = { busy: true, error: "", authUrl: "https://github.com/login/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A64996%2Fcallback" };
	it("offers recovery only while a loopback authorization-code flow is waiting", () => {
		expect(canPasteMcpRedirect(active)).toBe(true);
	});
	it.each([
		{ ...active, busy: false, error: "The client_id and/or client_secret passed are incorrect." },
		{ ...active, authUrl: "" },
		{ ...active, authUrl: "https://github.com/login/device" },
		{ ...active, device: { userCode: "PZZA-TEST", verificationUri: "https://github.com/login/device", expiresAt: 123 } },
		{ ...active, authUrl: "https://example.com/authorize?response_type=code&redirect_uri=https://example.com/callback" },
	])("hides the input for failed, starting, and device sign-ins", (login) => {
		expect(canPasteMcpRedirect(login)).toBe(false);
	});
});

describe("shouldAutoSignInAfterInstall", () => {
	it("triggers for catalog OAuth HTTP while still starting", () => {
		expect(
			shouldAutoSignInAfterInstall(
				server({
					name: "github",
					state: "starting",
					config: { url: "https://api.githubcopilot.com/mcp/", oauth: {} },
				}),
			),
		).toBe(true);
	});

	it("triggers for needs-auth", () => {
		expect(
			shouldAutoSignInAfterInstall(server({ name: "notion", state: "needs-auth", oauth: true })),
		).toBe(true);
	});

	it("does not trigger for auth-free connected servers", () => {
		expect(
			shouldAutoSignInAfterInstall(
				server({ name: "deepwiki", state: "connected", config: { url: "https://mcp.deepwiki.com/mcp" } }),
			),
		).toBe(false);
	});

	it("does not trigger when disabled (e.g. x until env is set)", () => {
		expect(
			shouldAutoSignInAfterInstall(
				server({
					name: "x",
					type: "stdio",
					enabled: false,
					state: "disabled",
					config: { command: "npx", enabled: false },
				}),
			),
		).toBe(false);
	});

	it("does not trigger when already connected", () => {
		expect(
			shouldAutoSignInAfterInstall(
				server({
					name: "github",
					state: "connected",
					oauth: true,
					config: { url: "https://api.githubcopilot.com/mcp/", oauth: {} },
				}),
			),
		).toBe(false);
	});
});
