import { describe, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({
	workspace: "/a" as string | null,
	handler: undefined as undefined | ((v: Record<string, unknown>) => void),
	un: vi.fn(),
}));
vi.mock("../apps/web/src/lib/transport", () => ({
	getRpcWorkspace: () => state.workspace,
	subscribeExtensionUi: async (handler: (v: Record<string, unknown>) => void) => {
		state.handler = handler;
		return state.un;
	},
}));
import { subscribeMcpAuthSession, parseMcpAuthStatus } from "../apps/web/src/lib/mcp-auth-session";
const event = { method: "setStatus", statusKey: "mcp-login:github", statusText: "https://github.com/login/device" };
describe("scoped auth sessions", () => {
	it("filters other workspaces and stops adopting events after a workspace switch", async () => {
		state.workspace = "/a";
		const update = vi.fn();
		const un = await subscribeMcpAuthSession("github", update);
		state.handler!({ ...event, _cwd: "/b" });
		expect(update).not.toHaveBeenCalled();
		state.handler!({ ...event, _cwd: "/a" });
		expect(update).toHaveBeenCalledOnce();
		state.workspace = "/b";
		state.handler!({ ...event, _cwd: "/a" });
		expect(update).toHaveBeenCalledOnce();
		un();
		expect(state.un).toHaveBeenCalled();
	});
	it("validates status kinds, server identity and authorization URLs", () => {
		expect(parseMcpAuthStatus("notion", event)).toBeUndefined();
		expect(parseMcpAuthStatus("github", { ...event, statusText: "javascript:alert(1)" })).toBeUndefined();
		expect(parseMcpAuthStatus("github", { ...event, statusText: "http://untrusted.example/login" })).toBeUndefined();
		expect(parseMcpAuthStatus("github", event)).toEqual({ authUrl: event.statusText });
	});
});
