import { parseMcpDevicePrompt, type McpDevicePrompt } from "./mcp-signin";
import { samePath } from "./platform";
import { getRpcWorkspace, subscribeExtensionUi } from "./transport";
export type McpAuthUpdate = { device: McpDevicePrompt } | { authUrl: string };
/** One scoped subscription per attempt, shared by any UI that initiates sign-in. */
export async function subscribeMcpAuthSession(server: string, update: (value: McpAuthUpdate) => void) {
	const workspace = getRpcWorkspace();
	return subscribeExtensionUi((request) => {
		if (workspace !== getRpcWorkspace() || (request._cwd && workspace && !samePath(request._cwd, workspace))) return;
		const value = parseMcpAuthStatus(server, request);
		if (value) update(value);
	});
}
export function parseMcpAuthStatus(server: string, request: Record<string, unknown>): McpAuthUpdate | undefined {
	if (request.method !== "setStatus" || typeof request.statusText !== "string") return;
	if (request.statusKey === `mcp-login-device:${server}`) {
		const device = parseMcpDevicePrompt(request.statusText);
		return device ? { device } : undefined;
	}
	if (request.statusKey !== `mcp-login:${server}`) return;
	try {
		const url = new URL(request.statusText);
		if (
			url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		)
			return;
		return { authUrl: url.href };
	} catch {
		return;
	}
}
