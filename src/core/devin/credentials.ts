/**
 * Devin CLI credential file access.
 *
 * `devin auth login` (Devin CLI) persists a long-lived session token at
 * `<data-dir>/devin/credentials.toml`. The pizza "devin" OAuth provider reuses
 * that file instead of running its own browser flow, so signing in with Devin
 * CLI once also signs pizza in.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";
export const DEVIN_DEFAULT_API_SERVER_URL = "https://server.codeium.com";

export interface DevinCliCredentials {
	/** Session token, normalized to always carry the `devin-session-token$` prefix. */
	apiKey: string;
	/** Connect API server used for inference (`api_server_url` in the file). */
	apiServerUrl: string;
	devinApiUrl?: string;
	devinWebappHost?: string;
}

/** Directory that holds `credentials.toml` (matches Devin CLI's data dir). */
export function devinDataDir(): string {
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg) return join(xdg, "devin");
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "devin");
	}
	return join(homedir(), ".local", "share", "devin");
}

export function devinCredentialsPath(): string {
	return join(devinDataDir(), "credentials.toml");
}

/** Minimal `key = "value"` TOML reader — the credentials file is flat. */
function parseFlatToml(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("[")) continue;
		const match = /^([A-Za-z0-9_.-]+)\s*=\s*"(.*)"\s*$/.exec(line);
		if (!match) continue;
		out[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return out;
}

/** Session tokens must carry the `devin-session-token$` scheme on the wire. */
export function normalizeDevinSessionToken(apiKey: string): string {
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX)
		? apiKey
		: `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

/**
 * Read the Devin CLI credentials file. Returns undefined when the file does
 * not exist, is unreadable, or carries no `windsurf_api_key`.
 */
export function readDevinCliCredentials(path = devinCredentialsPath()): DevinCliCredentials | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: Record<string, string>;
	try {
		parsed = parseFlatToml(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	const apiKey = parsed.windsurf_api_key;
	if (!apiKey) return undefined;
	return {
		apiKey: normalizeDevinSessionToken(apiKey),
		apiServerUrl: parsed.api_server_url || DEVIN_DEFAULT_API_SERVER_URL,
		devinApiUrl: parsed.devin_api_url || undefined,
		devinWebappHost: parsed.devin_webapp_host || undefined,
	};
}
