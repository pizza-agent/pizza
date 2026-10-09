/**
 * Devin provider: Cognition's Cascade inference API accessed with the
 * `devin-session-token$` produced by `devin auth login` (Devin CLI).
 */

import type { ProviderConfig, ProviderModelConfig } from "../extensions/types.js";
import { DEVIN_DEFAULT_API_SERVER_URL } from "./credentials.js";
import { DEVIN_FALLBACK_MODELS } from "./catalog.js";
import { devinOAuth } from "./oauth.js";
import { devinStreamSimple } from "./stream.js";

export const DEVIN_PROVIDER_ID = "devin";

export {
	DEVIN_DEFAULT_API_SERVER_URL,
	DEVIN_SESSION_TOKEN_PREFIX,
	devinCredentialsPath,
	devinDataDir,
	normalizeDevinSessionToken,
	readDevinCliCredentials,
} from "./credentials.js";
export { devinOAuth } from "./oauth.js";
export { devinStreamSimple } from "./stream.js";
export { DEVIN_FALLBACK_MODELS, fetchDevinCatalog } from "./catalog.js";
export type { DevinCliCredentials } from "./credentials.js";
export type { DevinCatalog } from "./catalog.js";

/**
 * Provider registration config. `models` is the static fallback list —
 * callers that have a stored credential should replace it with
 * `fetchDevinCatalog()` output when available.
 */
export function devinProviderConfig(models: ProviderModelConfig[] = DEVIN_FALLBACK_MODELS): ProviderConfig {
	return {
		baseUrl: DEVIN_DEFAULT_API_SERVER_URL,
		api: "devin",
		authHeader: false,
		oauth: devinOAuth,
		streamSimple: devinStreamSimple,
		models,
	};
}
