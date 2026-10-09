/**
 * OAuth flow for the "devin" provider: reuse the session token created by
 * `devin auth login` (Devin CLI) instead of running a separate browser flow.
 * The token is a long-lived `devin-session-token$<jwt>` stored in
 * `<data-dir>/devin/credentials.toml`.
 */

import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai/compat";
import {
	DEVIN_DEFAULT_API_SERVER_URL,
	devinCredentialsPath,
	readDevinCliCredentials,
} from "./credentials.js";
import { DevinApiError, connectUnaryJson, devinChatMetadata, GET_USER_STATUS_PATH } from "./client.js";

/** Extra fields persisted on the stored credential. */
export interface DevinCredentialExtras {
	apiServerUrl?: string;
	devinApiUrl?: string;
	devinWebappHost?: string;
	userName?: string;
}

async function fetchDevinUserName(
	apiServerUrl: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const status = await connectUnaryJson<{
		userStatus?: { name?: string; email?: string };
	}>(apiServerUrl, GET_USER_STATUS_PATH, { metadata: devinChatMetadata(apiKey) }, { signal });
	return status.userStatus?.name || status.userStatus?.email;
}

export const devinOAuth: OAuthAuth = {
	name: "Devin (Devin CLI account)",
	isSubscription: true,
	loginLabel: "Sign in with Devin (uses Devin CLI credentials)",

	async login(interaction) {
		interaction.notify({ type: "progress", message: "Reading Devin CLI credentials…" });
		const path = devinCredentialsPath();
		const credentials = readDevinCliCredentials(path);
		if (!credentials) {
			throw new Error(
				`No Devin CLI credentials found at ${path}.\nRun \`devin auth login\` first, then try again.`,
			);
		}
		let userName: string | undefined;
		try {
			userName = await fetchDevinUserName(
				credentials.apiServerUrl,
				credentials.apiKey,
				interaction.signal,
			);
		} catch (error) {
			const detail = error instanceof DevinApiError ? ` (${error.message})` : "";
			throw new Error(
				`The Devin CLI session token was rejected${detail}.\nRun \`devin auth login\` to refresh it, then try again.`,
			);
		}
		interaction.notify({
			type: "info",
			message: `Using Devin CLI credentials${userName ? ` — signed in as ${userName}` : ""}`,
		});
		return {
			type: "oauth",
			access: credentials.apiKey,
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
			apiServerUrl: credentials.apiServerUrl,
			devinApiUrl: credentials.devinApiUrl,
			devinWebappHost: credentials.devinWebappHost,
			userName,
		} satisfies OAuthCredential & DevinCredentialExtras;
	},

	async refresh(credential) {
		// Devin session tokens are long-lived and carry no refresh token; the
		// best we can do is pick up a newer token if `devin auth login` ran again.
		const latest = readDevinCliCredentials();
		if (latest && latest.apiKey !== credential.access) {
			return {
				...credential,
				access: latest.apiKey,
				apiServerUrl: latest.apiServerUrl,
				devinApiUrl: latest.devinApiUrl,
				devinWebappHost: latest.devinWebappHost,
			};
		}
		return credential;
	},

	async toAuth(credential) {
		const extras = credential as OAuthCredential & DevinCredentialExtras;
		return {
			apiKey: credential.access,
			baseUrl: extras.apiServerUrl || DEVIN_DEFAULT_API_SERVER_URL,
		};
	},
};
