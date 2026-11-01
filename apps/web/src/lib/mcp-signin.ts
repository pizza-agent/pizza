/**
 * Helpers for MCP sign-in prompts (Plugins → MCPs).
 * Kept outside the React view so unit tests can cover install → auto-auth decisions.
 */

export interface McpSignInServer {
	name: string;
	type: string;
	enabled: boolean;
	state: string;
	error?: string;
	oauth?: boolean;
	config?: Record<string, unknown>;
}

export interface McpDevicePrompt {
	userCode: string;
	verificationUri: string;
	expiresAt: number;
}

/** Manual redirects are an optional recovery path for an active authorization-code flow. */
export function canPasteMcpRedirect(login: { busy: boolean; error: string; authUrl: string; device?: McpDevicePrompt }): boolean {
	if (!login.busy || login.error || login.device || !login.authUrl) return false;
	try {
		const url = new URL(login.authUrl);
		const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
		return url.searchParams.get("response_type") === "code" && redirect.protocol === "http:" &&
			["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
	} catch { return false; }
}

export function parseMcpDevicePrompt(text: string): McpDevicePrompt | undefined {
	try {
		const value = JSON.parse(text);
		if (!value || typeof value.userCode !== "string" || !value.userCode ||
			typeof value.verificationUri !== "string" || !Number.isFinite(value.expiresAt)) return undefined;
		const url = new URL(value.verificationUri);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return undefined;
		return { userCode: value.userCode, verificationUri: url.href, expiresAt: value.expiresAt };
	} catch { return undefined; }
}

/** True when the server is explicitly waiting for (or failed with) auth. */
export function needsSignIn(server: McpSignInServer): boolean {
	if (server.state === "needs-auth") return true;
	if (server.state !== "failed" || server.type !== "http" || !server.error) return false;
	return /auth|oauth|401|unauthorized|sign[- ]?in|login required/i.test(server.error);
}

/**
 * Whether marketplace Install should open the existing Sign-in flow immediately.
 * Auth-free servers (connected, no oauth) return false. Login failures must not
 * roll back install — callers invoke sign-in after a successful add only.
 */
export function shouldAutoSignInAfterInstall(server: McpSignInServer): boolean {
	if (!server.enabled) return false;
	if (server.state === "connected" || server.state === "disabled") return false;
	if (needsSignIn(server)) return true;
	if (server.oauth) return true;
	// Catalog OAuth HTTP connectors include `oauth` in config before the
	// connection discovers an auth URL (state may still be "starting").
	const cfg = server.config;
	if (
		cfg &&
		typeof cfg === "object" &&
		!Array.isArray(cfg) &&
		"oauth" in cfg &&
		server.type === "http"
	) {
		return true;
	}
	return false;
}
