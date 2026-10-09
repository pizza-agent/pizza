/**
 * Built-in extension: devin
 *
 * Registers Cognition's Devin (Cascade) as a first-class model provider:
 *
 * - Auth: reuses the Devin CLI session token (`devin auth login` →
 *   `<data-dir>/devin/credentials.toml`). `pizza auth login --provider devin`
 *   validates that token and stores it like any other OAuth credential.
 * - Inference: Connect JSON streaming via `ApiServerService/GetChatMessage`
 *   at `server.codeium.com` (`devinStreamSimple`).
 * - Models: a static fallback list is registered immediately; when a Devin
 *   credential exists, the live `GetCliModelConfigs` catalog replaces it.
 */

import {
	DEVIN_PROVIDER_ID,
	devinProviderConfig,
	fetchDevinCatalog,
} from "../../core/devin/index.js";
import { AuthStorage } from "../../core/auth-storage.js";
import { getOAuthRequestAuth } from "../../core/oauth.js";
import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.js";

export const DEVIN_EXTENSION_ID = "devin";

export const createDevinExtension: ExtensionFactory = (pizza: ExtensionAPI) => {
	pizza.registerProvider(DEVIN_PROVIDER_ID, devinProviderConfig());

	// Refresh the model list from the live catalog when signed in. The provider
	// is already registered with the fallback list, so failures are silent.
	const cred = AuthStorage.create().get(DEVIN_PROVIDER_ID);
	if (cred?.type !== "oauth") return;
	void (async () => {
		try {
			const auth = await getOAuthRequestAuth(DEVIN_PROVIDER_ID, cred);
			if (!auth?.apiKey) return;
			const catalog = await fetchDevinCatalog(
				auth.baseUrl ?? "https://server.codeium.com",
				auth.apiKey,
				{ signal: AbortSignal.timeout(15_000) },
			);
			if (catalog.models.length > 0) {
				pizza.registerProvider(DEVIN_PROVIDER_ID, devinProviderConfig(catalog.models));
			}
		} catch {
			// Offline or token invalid — keep the fallback model list.
		}
	})();
};
