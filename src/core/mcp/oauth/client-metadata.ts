import { createHash } from "node:crypto";
import type { OAuthClientMetadata } from "./types.js";

/** Public HTTPS document family: /oauth/client.json and /oauth/<callback-id>/client.json. */
export function clientMetadataBaseUrl(value: string): URL {
	const url = new URL(value);
	if (
		url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
		!url.pathname.endsWith("/client.json")
	) throw new Error("OAuth client metadata URL must be an HTTPS URL ending in /client.json without credentials, query or fragment");
	return url;
}

export function oauthCallbackId(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

export function clientMetadataDocumentUrl(base: string, callbackId?: string): string {
	const url = clientMetadataBaseUrl(base);
	if (callbackId) {
		if (!/^[A-Za-z0-9_-]{12}$/.test(callbackId)) throw new Error("Invalid OAuth callback ID");
		url.pathname = url.pathname.replace(/client\.json$/, `${callbackId}/client.json`);
	}
	return url.href;
}

/** Public native-client metadata. No tokens, client secret, or user data belong here. */
export function createNativeClientMetadata(base: string, callbackId?: string): OAuthClientMetadata & { client_id: string } {
	const clientId = clientMetadataDocumentUrl(base, callbackId);
	const path = `/callback${callbackId ? `/${callbackId}` : ""}`;
	return {
		client_id: clientId,
		client_name: "Pizza",
		application_type: "native",
		redirect_uris: [`http://127.0.0.1${path}`, `http://localhost${path}`],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
}
