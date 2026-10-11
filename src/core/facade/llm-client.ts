/**
 * LLM client construction phase for createSessionFacade.
 *
 * Builds the reactor-facing LLMClient from a live model getter. Exposed as a
 * factory so the client can be (re)created when a model becomes available
 * after startup (first-run setup: the sidecar boots with no API key → no
 * model → llmClient is null; reload_providers later resolves a real model and
 * injects a freshly-built client).
 */

import { type CacheRetention, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionRunner } from "../extensions/index.js";
import type { ModelRegistry } from "../models/model-registry.js";
import type { LLMClient } from "../runtime/llm-types.js";
import { buildLlmClientFromStreamFn } from "../runtime/ai-client.js";
import type { EventSourcedRuntime } from "../runtime/runtime.js";
import type { SettingsManager } from "../config/settings-manager.js";
import { streamWithAdaptiveThinkingFallback } from "./adaptive-thinking.js";

export interface LlmClientDeps {
	modelRegistry: ModelRegistry;
	settingsManager: SettingsManager;
	extensionRunner: ExtensionRunner;
	getModelLive: () => Model<any> | undefined;
	getRuntime: () => EventSourcedRuntime | undefined;
}

export type LlmClientFactory = () => LLMClient;

export function createLlmClientFactory(deps: LlmClientDeps): LlmClientFactory {
	const { modelRegistry, settingsManager, extensionRunner, getModelLive, getRuntime } = deps;

	return (): LLMClient =>
		buildLlmClientFromStreamFn(getModelLive, async (m, context, opts) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(m);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			// Prompt cache retention: per-model/provider models.json config wins,
			// then the global setting. Left undefined when nothing is configured
			// so pi-ai applies its own default ("short"). "none" suppresses
			// cache_control for relays that reject cached requests.
			const streamOptions = {
				...opts,
				apiKey: auth.apiKey,
				headers: auth.headers ?? opts?.headers,
				...((): { cacheRetention?: CacheRetention } => {
					const retention = modelRegistry.getCacheRetention(m) ?? settingsManager.getCacheRetention();
					return retention ? { cacheRetention: retention } : {};
				})(),
			};
			// OAuth providers may carry a per-credential baseUrl (e.g. GitHub Copilot)
			return streamWithAdaptiveThinkingFallback(m, modelRegistry, patched =>
				streamSimple(auth.baseUrl ? { ...patched, baseUrl: auth.baseUrl } : patched, context, streamOptions),
			);
		}, {
			thinkingBudgets: settingsManager.getThinkingBudgets(),
			transport: settingsManager.getTransport(),
			// Read the live thinking level from the runtime, which is the single
			// source of truth. Both `/thinking` (facade.thinkingLevel setter) and
			// the extensions setThinkingLevel() API end up calling
			// runtime.setThinkingLevel(), so this captures every update path.
			getThinkingLevel: () => getRuntime()?.getThinkingLevel(),
			onPayload: async (payload: unknown) => {
				if (!extensionRunner.hasHandlers("before_provider_request")) {
					return payload;
				}
				return extensionRunner.emitBeforeProviderRequest(payload);
			},
			onResponse: async (response: { status: number; headers: Record<string, string> }) => {
				if (!extensionRunner.hasHandlers("after_provider_response")) {
					return;
				}
				await extensionRunner.emit({
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
				});
			},
		});
}