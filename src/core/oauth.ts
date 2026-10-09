/**
 * OAuth flow registry for pizza.
 *
 * pi-ai 0.84 removed its global OAuth provider registry; OAuth flows now live
 * on `Provider.auth.oauth` (`OAuthAuth`). Pizza discovers built-in flows from
 * the provider catalog and lets extensions register additional ones.
 * Credentials are persisted by AuthStorage (auth.json); request auth
 * (apiKey / headers / baseUrl) is derived per credential via `toAuth()`.
 */

import type { ApiKeyAuth, ModelAuth, OAuthAuth } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { devinOAuth } from "./devin/oauth.js";

/** A login-able OAuth flow: pi-ai `OAuthAuth` plus pizza display metadata. */
export interface OAuthFlow {
	id: string;
	name: string;
	oauth: OAuthAuth;
	/** Whether login spins up a local callback server (manual paste supported) */
	usesCallbackServer: boolean;
}

/** A provider that can be configured with a manually entered API key. */
export interface ApiKeyOption {
	id: string;
	name: string;
	auth: ApiKeyAuth;
}

/** Flows whose login uses a local callback server. Device-code flows: github-copilot, kimi-coding, xai. */
const CALLBACK_SERVER_PROVIDERS = new Set(["anthropic", "openai-codex", "openrouter", "radius"]);

/** Cached `builtinProviders()` — cheap to construct but avoid rebuilding on every request. */
let builtinProvidersCache: ReturnType<typeof builtinProviders> | undefined;
function getBuiltinProvidersCached(): ReturnType<typeof builtinProviders> {
	return (builtinProvidersCache ??= builtinProviders());
}

/** Built-in flows derived from pi-ai's provider catalog (lazily built). */
let builtinFlowsCache: OAuthFlow[] | undefined;

function getBuiltinFlows(): OAuthFlow[] {
	if (!builtinFlowsCache) {
		builtinFlowsCache = getBuiltinProvidersCached().flatMap((provider) => {
			const oauth = provider.auth.oauth;
			if (!oauth) return [];
			const name =
				oauth.isSubscription && oauth.loginLabel ? oauth.loginLabel : oauth.name || provider.name;
			return [
				{
					id: provider.id,
					name,
					oauth,
					usesCallbackServer: CALLBACK_SERVER_PROVIDERS.has(provider.id),
				},
			];
		});
		// Devin lives in pizza's own provider layer (not pi-ai's catalog) so it
		// can be registered alongside the pi-ai flows.
		builtinFlowsCache.push({
			id: "devin",
			name: devinOAuth.name,
			oauth: devinOAuth,
			usesCallbackServer: false,
		});
	}
	return builtinFlowsCache;
}

/** Extension-registered flows, overriding built-ins by id. */
const customFlows = new Map<string, OAuthFlow>();

/**
 * Get all registered OAuth flows (built-ins + extension-registered).
 * Custom flows replace built-ins with the same id.
 */
export function getOAuthFlows(): OAuthFlow[] {
	const byId = new Map<string, OAuthFlow>();
	for (const flow of getBuiltinFlows()) {
		byId.set(flow.id, flow);
	}
	for (const [id, flow] of customFlows) {
		byId.set(id, flow);
	}
	return [...byId.values()];
}

/** Get an OAuth flow by provider ID. */
export function getOAuthFlow(id: string): OAuthFlow | undefined {
	return customFlows.get(id) ?? getBuiltinFlows().find((f) => f.id === id);
}

/**
 * Register an extension OAuth flow (replaces a built-in with the same id).
 * `oauth.name` is used as the display name.
 */
export function registerOAuthFlow(id: string, oauth: OAuthAuth): void {
	customFlows.set(id, {
		id,
		name: oauth.name,
		oauth,
		usesCallbackServer: CALLBACK_SERVER_PROVIDERS.has(id),
	});
}

/** Unregister an extension flow. No effect on built-ins. */
export function unregisterOAuthFlow(id: string): void {
	customFlows.delete(id);
}

/** Remove all extension flows, restoring built-ins. */
export function resetOAuthFlows(): void {
	customFlows.clear();
}

/**
 * Derive request auth (apiKey / headers / per-credential baseUrl) from a
 * stored OAuth credential via the flow's `toAuth()`. Returns undefined when
 * no flow is registered for the provider.
 */
export async function getOAuthRequestAuth(providerId: string, credentials: object): Promise<ModelAuth | undefined> {
	const flow = getOAuthFlow(providerId);
	if (!flow) return undefined;
	return flow.oauth.toAuth(credentials as never);
}

/** Cached API-key login options (providers whose `auth.apiKey` has a login). */
let apiKeyOptionsCache: ApiKeyOption[] | undefined;

/**
 * All providers that support "Sign in with an API key" (interactive key entry),
 * derived from pi-ai's provider catalog.
 */
export function getApiKeyOptions(): ApiKeyOption[] {
	if (!apiKeyOptionsCache) {
		apiKeyOptionsCache = getBuiltinProvidersCached().flatMap((provider) => {
			const auth = provider.auth.apiKey;
			if (!auth?.login) return [];
			return [{ id: provider.id, name: auth.name || provider.name, auth }];
		});
	}
	return apiKeyOptionsCache;
}
