import { setTimeout as delay } from "node:timers/promises";
import type { McpFetch } from "../auth-provider.js";
import { isObject } from "../protocol/jsonrpc.js";
import { OAuthError, OAuthInsecureEndpointError } from "./errors.js";
import { parseOAuthTokens, type OAuthTokens } from "./types.js";

export interface OAuthDevicePrompt {
	userCode: string;
	verificationUri: string;
	expiresAt: number;
}

function endpoint(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
		throw new OAuthInsecureEndpointError(value);
	}
	return url;
}

/** RFC 8628: a native client never needs to distribute a GitHub client secret. */
export async function authorizeDevice(options: {
	clientId: string;
	deviceAuthorizationUrl: string;
	tokenUrl: string;
	scope?: string;
	fetch?: McpFetch;
	signal?: AbortSignal;
	onPrompt(prompt: OAuthDevicePrompt): void;
}): Promise<OAuthTokens> {
	const deviceUrl = endpoint(options.deviceAuthorizationUrl);
	const tokenUrl = endpoint(options.tokenUrl);
	const request = async (url: URL, params: Record<string, string>, signal?: AbortSignal) => {
		const response = await (options.fetch ?? globalThis.fetch)(url, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(params), signal,
		});
		const value = await response.json();
		if (!isObject(value)) throw new Error("Invalid OAuth response");
		if (typeof value.error === "string") {
			const message = value.error === "device_flow_disabled"
				? "Enable Device Flow in the Pizza GitHub OAuth App settings, then try signing in again."
				: typeof value.error_description === "string" ? value.error_description : value.error;
			throw new OAuthError(value.error, message);
		}
		if (!response.ok) throw new OAuthError("server_error", `OAuth request failed (HTTP ${response.status})`);
		return value;
	};
	const device = await request(deviceUrl, {
		client_id: options.clientId, ...(options.scope ? { scope: options.scope } : {}),
	}, options.signal);
	if (!device || typeof device.device_code !== "string" || !device.device_code ||
		typeof device.user_code !== "string" || !device.user_code || typeof device.verification_uri !== "string" ||
		typeof device.expires_in !== "number" || !Number.isFinite(device.expires_in) || device.expires_in <= 0 || device.expires_in > 86400 ||
		(device.interval !== undefined && (typeof device.interval !== "number" || !Number.isFinite(device.interval) || device.interval <= 0))) {
		throw new Error("Invalid OAuth device authorization response");
	}
	const verificationUri = endpoint(device.verification_uri).href;
	const expiresAt = Date.now() + device.expires_in * 1000;
	const signal = AbortSignal.any([
		...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.ceil(device.expires_in * 1000)),
	]);
	options.onPrompt({ userCode: device.user_code, verificationUri, expiresAt });
	let interval = (device.interval ?? 5) * 1000;
	try {
		while (true) {
			await delay(interval, undefined, { signal });
			try {
				return parseOAuthTokens(await request(tokenUrl, {
					client_id: options.clientId, device_code: device.device_code,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}, signal));
			} catch (error) {
				if (!(error instanceof OAuthError)) throw error;
				if (error.code === "slow_down") interval += 5000;
				else if (error.code !== "authorization_pending") throw error;
			}
		}
	} catch (error) {
		if (!options.signal?.aborted && signal.aborted) throw new OAuthError("expired_token", "Device code expired. Sign in again to get a new code.");
		throw error;
	}
}
