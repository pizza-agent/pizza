/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import {
	type Api,
	type OAuthAuth,
	type AssistantMessageEventStream,
	type BuiltinProvider,
	type CacheRetention,
	type Context,
	getModels,
	getProviders,
	type Model,
	type OpenAICompletionsCompat,
	type OpenAIResponsesCompat,
	registerApiProvider,
	resetApiProviders,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type Static, Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { APP_NAME, getAgentDir, VERSION } from "../config.js";
import type { AuthStorage } from "./auth-storage.js";
import {
	clearConfigValueCache,
	collectConfigCommands,
	registerTrustedConfigCommands,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "./resolve-config-value.js";
import { getOAuthFlows, getOAuthRequestAuth, registerOAuthFlow, resetOAuthFlows } from "./oauth.js";
import { DEVIN_DEFAULT_API_SERVER_URL, devinProviderConfig, fetchDevinCatalog } from "./devin/index.js";

const Ajv = (AjvModule as any).default || AjvModule;
const ajv = new Ajv();

/**
 * Display-name overrides for providers where pizza wants a different label
 * than pi-ai built-in `Provider.name`, and names for pizza-native providers
 * that don't exist in pi-ai's catalog at all.
 */
const PROVIDER_NAME_OVERRIDES: Record<string, string> = {
	// Pizza-native provider (not part of pi-ai's catalog).
	devin: "Devin (Devin CLI account)",
};

/** Lazily-built map of provider id -> display name from pi-ai built-ins. */
let providerNameMap: Map<string, string> | undefined;

function getProviderNameMap(): Map<string, string> {
	if (!providerNameMap) {
		providerNameMap = new Map<string, string>();
		for (const provider of builtinProviders()) {
			providerNameMap.set(provider.id, provider.name);
		}
	}
	return providerNameMap;
}

/**
 * Resolve a display name for a provider id.
 * Priority: pizza override > pi-ai built-in name > raw id.
 */
export function getProviderDisplayName(providerId: string): string {
	return PROVIDER_NAME_OVERRIDES[providerId] ?? getProviderNameMap().get(providerId) ?? providerId;
}

// Schema for OpenRouter routing preferences
const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

// Schema for Vercel AI Gateway routing preferences
const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

// Schema for OpenAI compatibility settings
const ReasoningEffortMapSchema = Type.Object({
	minimal: Type.Optional(Type.String()),
	low: Type.Optional(Type.String()),
	medium: Type.Optional(Type.String()),
	high: Type.Optional(Type.String()),
	xhigh: Type.Optional(Type.String()),
});

const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	reasoningEffortMap: Type.Optional(ReasoningEffortMapSchema),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("qwen-chat-template"),
		]),
	),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsStrictMode: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
	// Reserved for future use
});

// Schema for Anthropic Messages compatibility settings (api: "anthropic-messages").
// Mirrors pi-ai AnthropicMessagesCompat; see pi-ai types for field semantics.
const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	supportsTemperature: Type.Optional(Type.Boolean()),
	/** Force adaptive thinking (thinking.type: "adaptive" + output_config.effort)
	 * instead of budget-based thinking (thinking.type: "enabled"). Required by
	 * newer Claude models (Opus 4.6+/5, Sonnet 4.6/5, Fable 5) which reject
	 * "thinking.type.enabled" with a 400 error. */
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
	allowEmptySignature: Type.Optional(Type.Boolean()),
	supportsStrictTools: Type.Optional(Type.Boolean()),
	supportsToolReferences: Type.Optional(Type.Boolean()),
});

/** Compat settings for models.json. Fields of both API families are accepted;
 * only the ones relevant to the model/provider api apply. */
const OpenAICompatSchema = Type.Union([OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema]);

/** Compat settings for models.json. Fields of both API families are accepted;
 * only the ones relevant to the model/provider api apply. */
const ModelCompatSchema = Type.Intersect([OpenAICompatSchema, AnthropicMessagesCompatSchema]);

type ModelCompat = Static<typeof ModelCompatSchema>;

// Maps pi thinking levels ("off", "low", ..., "max") to provider/model-specific
// effort values. null marks a level as unsupported.
const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	minimal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	low: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	medium: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	high: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	xhigh: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	max: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/**
 * Prompt cache retention preference, forwarded to pi-ai as
 * `SimpleStreamOptions.cacheRetention`.
 *
 * `"none"` suppresses `cache_control` blocks entirely. That matters for relay
 * gateways that reject cached requests for specific models, e.g. new-api
 * answering `cache endpoint request without claude trace cli is not allowed
 * for this model` with a 403.
 */
const CacheRetentionSchema = Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]);

// Schema for custom model definition
// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Number(),
			output: Type.Number(),
			cacheRead: Type.Number(),
			cacheWrite: Type.Number(),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ModelCompatSchema),
	cacheRetention: Type.Optional(CacheRetentionSchema),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
});

// Schema for per-model overrides (all fields optional, merged with built-in model)
const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ModelCompatSchema),
	cacheRetention: Type.Optional(CacheRetentionSchema),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
});

type ModelOverride = Static<typeof ModelOverrideSchema>;

const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ModelCompatSchema),
	cacheRetention: Type.Optional(CacheRetentionSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema),
});

ajv.addSchema(ModelsConfigSchema, "ModelsConfig");

type ModelsConfig = Static<typeof ModelsConfigSchema>;

/** Provider override config (baseUrl, compat) without request auth/headers */
interface ProviderOverride {
	baseUrl?: string;
	compat?: Model<Api>["compat"];
}

interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	cacheRetention?: CacheRetention;
}

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
			/** Per-credential baseUrl override (e.g., GitHub Copilot enterprise endpoints) */
			baseUrl?: string;
		  }
	| {
			ok: false;
			error: string;
	  };

/** Result of loading custom models from models.json */
interface CustomModelsResult {
	models: Model<Api>[];
	/** Providers with baseUrl/headers/apiKey overrides for built-in models */
	overrides: Map<string, ProviderOverride>;
	/** Per-model overrides: provider -> modelId -> override */
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelCompat | undefined,
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;

	const base = baseCompat as ModelCompat | undefined;
	const override = overrideCompat as ModelCompat;
	const merged = { ...base, ...override } as ModelCompat;

	const baseCompletions = base as OpenAICompletionsCompat | undefined;
	const overrideCompletions = override as OpenAICompletionsCompat;
	const mergedCompletions = merged as OpenAICompletionsCompat;

	if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
		mergedCompletions.openRouterRouting = {
			...baseCompletions?.openRouterRouting,
			...overrideCompletions.openRouterRouting,
		};
	}

	if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
		mergedCompletions.vercelGatewayRouting = {
			...baseCompletions?.vercelGatewayRouting,
			...overrideCompletions.vercelGatewayRouting,
		};
	}

	return merged as Model<Api>["compat"];
}

/**
 * Deep merge a model override into a model.
 * Handles nested objects (cost, compat) by merging rather than replacing.
 */
function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	// Simple field overrides
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

	// Merge cost (partial override)
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
		};
	}

	// Merge thinkingLevelMap (partial override)
	if (override.thinkingLevelMap) {
		result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap } as ThinkingLevelMap;
	}

	// Deep merge compat
	result.compat = mergeCompat(model.compat, override.compat);

	return result;
}

/**
 * Built-in models that require adaptive thinking (thinking.type: "adaptive" +
 * output_config.effort) instead of budget-based thinking (thinking.type:
 * "enabled"). Derived from pi-ai metadata so new models are picked up
 * automatically. Maps known model id -> its thinkingLevelMap (if any).
 */
let adaptiveThinkingModelIndex: Map<string, ThinkingLevelMap | undefined> | undefined;

function getAdaptiveThinkingModelIndex(): Map<string, ThinkingLevelMap | undefined> {
	if (!adaptiveThinkingModelIndex) {
		adaptiveThinkingModelIndex = new Map<string, ThinkingLevelMap | undefined>();
		for (const provider of getProviders()) {
			for (const model of getModels(provider as BuiltinProvider) as Model<Api>[]) {
				if ((model.compat as ModelCompat | undefined)?.forceAdaptiveThinking === true && !adaptiveThinkingModelIndex.has(model.id)) {
						adaptiveThinkingModelIndex.set(model.id, model.thinkingLevelMap);
				}
			}
		}
	}
	return adaptiveThinkingModelIndex;
}

/**
 * Check whether a custom model id refers to a known adaptive-thinking model.
 * Anthropic-compatible relays often expose suffixed or date-stamped variants
 * ("claude-opus-5-cc", "claude-sonnet-4-6-20251201"), so match the known id
 * exactly or as a "<knownId>-..." prefix.
 */
function matchAdaptiveThinkingModel(
	modelId: string,
): { thinkingLevelMap: ThinkingLevelMap | undefined } | undefined {
	for (const [knownId, thinkingLevelMap] of getAdaptiveThinkingModelIndex()) {
		if (modelId === knownId || modelId.startsWith(`${knownId}-`)) {
			return { thinkingLevelMap };
		}
	}
	return undefined;
}

/**
 * Custom anthropic-messages models whose upstream requires adaptive thinking
 * (newer Claude models) reject budget-based thinking with a 400:
 * `"thinking.type.enabled" is not supported for this model. Use
 * "thinking.type.adaptive" and "output_config.effort"...`. Auto-enable the
 * adaptive format when the model id matches a known adaptive-thinking model
 * and the user has not set compat.forceAdaptiveThinking explicitly.
 */
function applyAdaptiveThinkingDefaults(
	api: string,
	modelId: string,
	compat: Model<Api>["compat"] | undefined,
): { compat: Model<Api>["compat"] | undefined; thinkingLevelMap?: ThinkingLevelMap } {
	if (api !== "anthropic-messages" || (compat as ModelCompat | undefined)?.forceAdaptiveThinking !== undefined) {
		return { compat };
	}
	const match = matchAdaptiveThinkingModel(modelId);
	if (!match) {
		return { compat };
	}
	return { compat: { ...compat, forceAdaptiveThinking: true }, thinkingLevelMap: match.thinkingLevelMap };
}

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
	private models: Model<Api>[] = [];
	private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
	private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
	/** provider:modelId -> cacheRetention (model level beats provider level) */
	private modelCacheRetentions: Map<string, CacheRetention> = new Map();
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private loadError: string | undefined = undefined;
	/** Live Devin catalog once fetched (replaces the static fallback list). */
	private devinCatalogModels: NonNullable<ProviderConfigInput["models"]> | undefined;
	private devinCatalogRequested = false;

	private constructor(
		readonly authStorage: AuthStorage,
		private modelsJsonPath: string | undefined,
	) {
		this.loadModels();
	}

	static create(authStorage: AuthStorage, modelsJsonPath: string = join(getAgentDir(), "models.json")): ModelRegistry {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.scheduleDevinCatalogRefresh();
		return registry;
	}

	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, undefined);
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	refresh(): void {
		this.providerRequestConfigs.clear();
		this.modelRequestHeaders.clear();
		this.modelCacheRetentions.clear();
		this.loadError = undefined;

		// Ensure dynamic API/OAuth registrations are rebuilt from current provider state.
		resetApiProviders();
		resetOAuthFlows();

		this.loadModels();

		for (const [providerName, config] of this.registeredProviders.entries()) {
			this.applyProviderConfig(providerName, config);
		}
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	private loadModels(): void {
		// Remember the file version we just loaded so refreshIfModelsJsonChanged()
		// only reacts to edits after this point.
		this.modelsJsonMtimeMs =
			this.modelsJsonPath && existsSync(this.modelsJsonPath)
				? statSync(this.modelsJsonPath).mtimeMs
				: undefined;
		// Load custom models and overrides from models.json
		const {
			models: customModels,
			overrides,
			modelOverrides,
			error,
		} = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();

		if (error) {
			this.loadError = error;
			// Keep built-in models even if custom models failed to load
		}

		const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
		let combined = this.mergeCustomModels(builtInModels, customModels);

		// Filter OAuth-account-restricted models (e.g. GitHub Copilot publishes
		// the account's available model ids on the credential). Per-credential
		// baseUrl is applied at request time via getOAuthRequestAuth().
		for (const oauthFlow of this.authStorage.getOAuthFlows()) {
			const cred = this.authStorage.get(oauthFlow.id);
			if (cred?.type !== "oauth") continue;
			const available = Array.isArray(cred.availableModelIds)
				? new Set<string>(cred.availableModelIds as string[])
				: undefined;
			if (!available) continue;
			combined = combined.filter((m) => m.provider !== oauthFlow.id || available.has(m.id));
		}

		this.models = combined;

		// Pizza-native providers that aren't in pi-ai's catalog. Applies the
		// OAuth flow, the custom Connect-JSON stream handler, and the current
		// model list (live catalog once fetched, static fallback otherwise).
		this.applyProviderConfig("devin", devinProviderConfig(this.devinCatalogModels));
	}

	/**
	 * Fetch the live Devin model catalog in the background when signed in,
	 * replacing the static fallback list. Runs at most once per registry
	 * lifetime; failures keep the fallback list.
	 */
	private scheduleDevinCatalogRefresh(): void {
		if (this.devinCatalogRequested) return;
		this.devinCatalogRequested = true;
		const cred = this.authStorage.get("devin");
		if (cred?.type !== "oauth") return;
		void (async () => {
			try {
				const auth = await getOAuthRequestAuth("devin", cred);
				if (!auth?.apiKey) return;
				const catalog = await fetchDevinCatalog(
					auth.baseUrl ?? DEVIN_DEFAULT_API_SERVER_URL,
					auth.apiKey,
					{ signal: AbortSignal.timeout(15_000) },
				);
				if (catalog.models.length > 0) {
					this.devinCatalogModels = catalog.models;
					this.refresh();
				}
			} catch {
				// Offline or invalid token — keep the fallback model list.
			}
		})();
	}

	/** Load built-in models and apply provider/model overrides */
	private loadBuiltInModels(
		overrides: Map<string, ProviderOverride>,
		modelOverrides: Map<string, Map<string, ModelOverride>>,
	): Model<Api>[] {
		return getProviders().flatMap((provider) => {
			const models = getModels(provider as BuiltinProvider) as Model<Api>[];

			const providerOverride = overrides.get(provider);
			const perModelOverrides = modelOverrides.get(provider);

			return models.map((m) => {
				let model = m;

				// Apply provider-level baseUrl/headers/compat override
				if (providerOverride) {
					model = {
						...model,
						baseUrl: providerOverride.baseUrl ?? model.baseUrl,
						compat: mergeCompat(model.compat, providerOverride.compat),
					};
				}

				// Apply per-model override
				const modelOverride = perModelOverrides?.get(m.id);
				if (modelOverride) {
					model = applyModelOverride(model, modelOverride);
				}

				return model;
			});
		});
	}

	/** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
	private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
		const merged = [...builtInModels];
		for (const customModel of customModels) {
			const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
			if (existingIndex >= 0) {
				merged[existingIndex] = customModel;
			} else {
				merged.push(customModel);
			}
		}
		return merged;
	}

	private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
		if (!existsSync(modelsJsonPath)) {
			return emptyCustomModelsResult();
		}

		try {
			const content = readFileSync(modelsJsonPath, "utf-8");
			const config: ModelsConfig = JSON.parse(content);

			// Register any "!command" config values while the trust window is open
			// (before createSessionFacade seals it). After sealing, commands added
			// to models.json mid-session are refused until a restart — see
			// resolve-config-value.ts (TOFU gate).
			registerTrustedConfigCommands(collectConfigCommands(config));

			// Validate schema
			const validate = ajv.getSchema("ModelsConfig")!;
			if (!validate(config)) {
				const errors =
					validate.errors?.map((e: any) => `  - ${e.instancePath || "root"}: ${e.message}`).join("\n") ||
					"Unknown schema error";
				return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
			}

			// Additional validation
			this.validateConfig(config);

			const overrides = new Map<string, ProviderOverride>();
			const modelOverrides = new Map<string, Map<string, ModelOverride>>();

			for (const [providerName, providerConfig] of Object.entries(config.providers)) {
				if (providerConfig.baseUrl || providerConfig.compat) {
					overrides.set(providerName, {
						baseUrl: providerConfig.baseUrl,
						compat: providerConfig.compat,
					});
				}

				this.storeProviderRequestConfig(providerName, providerConfig);

				if (providerConfig.modelOverrides) {
					modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
					for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
						this.storeModelHeaders(providerName, modelId, modelOverride.headers);
						this.storeModelCacheRetention(providerName, modelId, modelOverride.cacheRetention);
					}
				}
			}

			return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
		} catch (error) {
			if (error instanceof SyntaxError) {
				return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
			}
			return emptyCustomModelsResult(
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
			);
		}
	}

	private validateConfig(config: ModelsConfig): void {
		const builtInProviders = new Set<string>(getProviders());

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const isBuiltIn = builtInProviders.has(providerName);
			const hasProviderApi = !!providerConfig.api;
			const models = providerConfig.models ?? [];
			const hasModelOverrides =
				providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

			if (models.length === 0) {
				// Override-only config: needs baseUrl, compat, modelOverrides, or some combination.
				// Note: for built-in providers, "apiKey" alone is a valid override (auth-only
				// override on top of inherited baseUrl/compat). Only non-built-in providers
				// need to fully declare their endpoint.
				const hasAuthOnlyOverride = isBuiltIn && !!providerConfig.apiKey;
				if (!providerConfig.baseUrl && !providerConfig.compat && !hasModelOverrides && !hasAuthOnlyOverride) {
					throw new Error(
						`Provider ${providerName}: must specify "baseUrl", "compat", "modelOverrides", "models", or "apiKey" (apiKey only valid for built-in providers).`,
					);
				}
			} else if (!isBuiltIn) {
				// Non-built-in providers with custom models require an endpoint.
				// Auth can come from auth.json/env/runtime; do not force secrets
				// into models.json.
				if (!providerConfig.baseUrl) {
					throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
				}
			}
			// Built-in providers with custom models: baseUrl/apiKey/api are optional,
			// inherited from built-in models. Auth comes from env vars / auth storage.

			for (const modelDef of models) {
				const hasModelApi = !!modelDef.api;

				if (!hasProviderApi && !hasModelApi && !isBuiltIn) {
					throw new Error(
						`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
					);
				}
				// For built-in providers, api is optional — inherited from built-in models.

				if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
				// Validate contextWindow/maxTokens only if provided (they have defaults)
				if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
				if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}

	private parseModels(config: ModelsConfig): Model<Api>[] {
		const models: Model<Api>[] = [];
		const builtInProviders = new Set<string>(getProviders());

		// Cache built-in defaults (api, baseUrl) per provider. Providers can mix
		// APIs (e.g. openrouter serves native anthropic-messages endpoints
		// alongside openai-completions), so default to the provider's most
		// common api rather than its first model's, and let custom models whose
		// id matches a built-in inherit that model's endpoint.
		type BuiltInDefaults = { api: string; baseUrl: string; byId: Map<string, { api: string; baseUrl: string }> };
		const builtInDefaultsCache = new Map<string, BuiltInDefaults>();
		const getBuiltInDefaults = (providerName: string): BuiltInDefaults | undefined => {
			if (!builtInProviders.has(providerName)) return undefined;
			if (builtInDefaultsCache.has(providerName)) return builtInDefaultsCache.get(providerName);
			const builtIn = getModels(providerName as BuiltinProvider) as Model<Api>[];
			if (builtIn.length === 0) return undefined;
			const byId = new Map<string, { api: string; baseUrl: string }>();
			const apiCounts = new Map<string, number>();
			const apiBaseUrls = new Map<string, string>();
			for (const m of builtIn) {
				if (!m.api || !m.baseUrl) continue;
				byId.set(m.id, { api: m.api, baseUrl: m.baseUrl });
				apiCounts.set(m.api, (apiCounts.get(m.api) || 0) + 1);
				if (!apiBaseUrls.has(m.api)) apiBaseUrls.set(m.api, m.baseUrl);
			}
			let bestApi: string | undefined;
			let bestCount = 0;
			for (const [api, count] of apiCounts) {
				if (bestCount < count) {
					bestCount = count;
					bestApi = api;
				}
			}
			const defaults: BuiltInDefaults = { api: bestApi || builtIn[0].api, baseUrl: (bestApi && apiBaseUrls.get(bestApi)) || builtIn[0].baseUrl, byId };
			builtInDefaultsCache.set(providerName, defaults);
			return defaults;
		};

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models

			const builtInDefaults = getBuiltInDefaults(providerName);

			for (const modelDef of modelDefs) {
				// Custom model ids that match a built-in model inherit its endpoint
				const builtInMatch = builtInDefaults?.byId.get(modelDef.id);
				const api = modelDef.api ?? providerConfig.api ?? builtInMatch?.api ?? builtInDefaults?.api;
				if (!api) continue;

				const baseUrl =
					modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInMatch?.baseUrl ?? builtInDefaults?.baseUrl;
				if (!baseUrl) continue;

				let compat = mergeCompat(providerConfig.compat, modelDef.compat);
				// Auto-enable adaptive thinking for custom anthropic-messages models whose
				// id matches a known adaptive-thinking Claude model (e.g. relay models like
				// "claude-opus-5" or "claude-sonnet-4-6-cc"), unless explicitly configured.
				const adaptive = applyAdaptiveThinkingDefaults(api, modelDef.id, compat);
				compat = adaptive.compat;
				const thinkingLevelMap = modelDef.thinkingLevelMap ?? adaptive.thinkingLevelMap;
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
				this.storeModelCacheRetention(providerName, modelDef.id, modelDef.cacheRetention);

				const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				models.push({
					id: modelDef.id,
					name: modelDef.name ?? modelDef.id,
					api: api as Api,
					provider: providerName,
					baseUrl,
					reasoning: modelDef.reasoning ?? false,
					input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
					cost: modelDef.cost ?? defaultCost,
					contextWindow: modelDef.contextWindow ?? 128000,
					maxTokens: modelDef.maxTokens ?? 16384,
					headers: undefined,
					compat,
					thinkingLevelMap,
				} as Model<Api>);
			}
		}

		return models;
	}

	/** mtime of models.json at last load; manual edits are picked up lazily */
	private modelsJsonMtimeMs: number | undefined;

	/**
	 * Reload models.json if it changed on disk since the last load.
	 *
	 * Editors write models.json out-of-band; without this the registry serves
	 * stale in-memory config until restart. Called from the read paths
	 * (getAll/getAvailable/find) so any consumer — /model picker, RPC, gateway —
	 * sees hand-edits without a restart. A statSync per read is negligible and
	 * no-op when mtime is unchanged.
	 */
	private refreshIfModelsJsonChanged(): void {
		if (!this.modelsJsonPath || !existsSync(this.modelsJsonPath)) return;
		const mtimeMs = statSync(this.modelsJsonPath).mtimeMs;
		if (this.modelsJsonMtimeMs === mtimeMs) return;
		this.refresh();
	}

	/**
	 * Get all models (built-in + custom).
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		this.refreshIfModelsJsonChanged();
		return this.models;
	}

	/**
	 * Get only models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		this.refreshIfModelsJsonChanged();
		return this.models.filter((m) => this.hasConfiguredAuth(m));
	}

	/**
	 * Find a model by provider and ID.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		this.refreshIfModelsJsonChanged();
		return this.models.find((m) => m.provider === provider && m.id === modelId);
	}

	/**
	 * Get all known provider ids (built-in + custom from models/extensions).
	 */
	getProviderIds(): string[] {
		const ids = new Set<string>();
		for (const m of this.models) ids.add(m.provider);
		return [...ids];
	}

	/**
	 * Get a human-readable display name for a provider id.
	 * Uses pi-ai built-in names; falls back to the raw id.
	 */
	getProviderName(providerId: string): string {
		return getProviderDisplayName(providerId);
	}

	/**
	 * Get API key for a model.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		return (
			this.authStorage.hasAuth(model.provider) ||
			this.providerRequestConfigs.get(model.provider)?.apiKey !== undefined
		);
	}

	private getModelRequestKey(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private storeProviderRequestConfig(
		providerName: string,
		config: {
			apiKey?: string;
			headers?: Record<string, string>;
			authHeader?: boolean;
			cacheRetention?: CacheRetention;
		},
	): void {
		if (!config.apiKey && !config.headers && !config.authHeader && !config.cacheRetention) {
			return;
		}

		this.providerRequestConfigs.set(providerName, {
			apiKey: config.apiKey,
			headers: config.headers,
			authHeader: config.authHeader,
			cacheRetention: config.cacheRetention,
		});
	}

	private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!headers || Object.keys(headers).length === 0) {
			this.modelRequestHeaders.delete(key);
			return;
		}
		this.modelRequestHeaders.set(key, headers);
	}

	private storeModelCacheRetention(providerName: string, modelId: string, retention?: CacheRetention): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!retention) {
			this.modelCacheRetentions.delete(key);
			return;
		}
		this.modelCacheRetentions.set(key, retention);
	}

	/**
	 * Resolve the prompt cache retention configured for a model.
	 *
	 * Precedence: per-model `cacheRetention` > provider `cacheRetention`.
	 * Returns undefined when unset, so callers leave the option off and let
	 * pi-ai apply its own default ("short").
	 */
	getCacheRetention(model: Model<Api>): CacheRetention | undefined {
		return (
			this.modelCacheRetentions.get(this.getModelRequestKey(model.provider, model.id)) ??
			this.providerRequestConfigs.get(model.provider)?.cacheRetention
		);
	}

	/**
	 * Remember that a provider rejected budget-based thinking for this model
	 * ("\"thinking.type.enabled\" is not supported ...") so future requests use
	 * adaptive thinking without waiting for another 400. Learned at runtime
	 * from the provider's own error, so it works for any model id or relay.
	 *
	 * Mutates the live model entry so every consumer (context builder, UI,
	 * future requests) sees the corrected compat.
	 */
	rememberAdaptiveThinking(model: Model<Api>): Model<Api> {
		const index = this.models.findIndex((m) => m.provider === model.provider && m.id === model.id);
		const patched: Model<Api> = {
			...model,
			compat: { ...model.compat, forceAdaptiveThinking: true },
		};
		if (index >= 0) this.models[index] = patched;
		return patched;
	}

	/**
	 * Get API key and request headers for a model.
	 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const providerConfig = this.providerRequestConfigs.get(model.provider);
			const apiKeyFromAuthStorage = await this.authStorage.getApiKey(model.provider, { includeFallback: false });
			let apiKey =
				apiKeyFromAuthStorage ??
				(providerConfig?.apiKey
					? resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`)
					: undefined);

			const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
			const modelHeaders = resolveHeadersOrThrow(
				this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
				`model "${model.provider}/${model.id}"`,
			);

			let headers =
				model.headers || providerHeaders || modelHeaders
					? { ...model.headers, ...providerHeaders, ...modelHeaders }
					: undefined;

			// OAuth providers may derive a per-credential baseUrl (e.g. GitHub
			// Copilot enterprise) from the stored token.
			let baseUrl: string | undefined;
			const oauthCred = this.authStorage.get(model.provider);
			if (oauthCred?.type === "oauth") {
				try {
					const extras = await getOAuthRequestAuth(model.provider, oauthCred);
					if (extras) {
						baseUrl = extras.baseUrl;
						if (extras.headers) headers = { ...headers, ...extras.headers } as Record<string, string>;
						// Header-based flows (e.g. Kimi Coding: Authorization: Bearer)
						// authenticate via headers only — drop the raw access-token
						// apiKey so the request doesn't double-authenticate.
						apiKey = extras.apiKey ?? (extras.headers ? undefined : apiKey);
					}
				} catch {
					// Extra auth derivation is best-effort; the plain API key still works
				}
			}

			if (providerConfig?.authHeader) {
				if (!apiKey) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				headers = { ...headers, Authorization: `Bearer ${apiKey}` };
			}

			// Inject pizza's own identifying headers as defaults. Anything already
			// set by the model/provider/extension/OAuth/authHeader above takes
			// precedence. pi-ai may still override User-Agent for certain providers
			// (e.g. kimi-coding, codex) — that's expected.
			headers = {
				"User-Agent": `${APP_NAME}/${VERSION}`,
				...headers,
			};

			return {
				ok: true,
				apiKey,
				headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
				baseUrl,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Get API key for a provider.
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		const apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
		if (apiKey !== undefined) {
			return apiKey;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		const cred = this.authStorage.get(model.provider);
		return cred?.type === "oauth";
	}

	/**
	 * Register a provider dynamically (from extensions).
	 *
	 * If provider has models: replaces all existing models for this provider.
	 * If provider has only baseUrl/headers: overrides existing models' URLs.
	 * If provider has oauth: registers OAuth provider for /login support.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		this.validateProviderConfig(providerName, config);
		this.applyProviderConfig(providerName, config);
		this.registeredProviders.set(providerName, config);
	}

	/**
	 * Unregister a previously registered provider.
	 *
	 * Removes the provider from the registry and reloads models from disk so that
	 * built-in models overridden by this provider are restored to their original state.
	 * Also resets dynamic OAuth and API stream registrations before reapplying
	 * remaining dynamic providers.
	 * Has no effect if the provider was never registered.
	 */
	unregisterProvider(providerName: string): void {
		if (!this.registeredProviders.has(providerName)) return;
		this.registeredProviders.delete(providerName);
		this.refresh();
	}

	private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		if (!config.models || config.models.length === 0) {
			return;
		}

		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
		}
		if (!config.apiKey && !config.oauth) {
			throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
		}

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			if (!api) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
			}
		}
	}

	private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
		// Register extension OAuth flow (id = provider name)
		if (config.oauth) {
			registerOAuthFlow(providerName, config.oauth);
		}

		if (config.streamSimple) {
			const streamSimple = config.streamSimple;
			registerApiProvider(
				{
					api: config.api!,
					stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
					streamSimple,
				},
				`provider:${providerName}`,
			);
		}

		this.storeProviderRequestConfig(providerName, config);

		if (config.models && config.models.length > 0) {
			// Full replacement: remove existing models for this provider
			this.models = this.models.filter((m) => m.provider !== providerName);

			// Parse and add new models
			for (const modelDef of config.models) {
				const api = modelDef.api || config.api;
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
				this.storeModelCacheRetention(providerName, modelDef.id, modelDef.cacheRetention);

				this.models.push({
					id: modelDef.id,
					name: modelDef.name,
					api: api as Api,
					provider: providerName,
					baseUrl: config.baseUrl!,
					reasoning: modelDef.reasoning,
					input: modelDef.input as ("text" | "image")[],
					cost: modelDef.cost,
					contextWindow: modelDef.contextWindow,
					maxTokens: modelDef.maxTokens,
					headers: undefined,
					compat: modelDef.compat,
				} as Model<Api>);
			}

		} else if (config.baseUrl || config.headers) {
			// Override-only: update baseUrl for existing models. Request headers are resolved per request.
			this.models = this.models.map((m) => {
				if (m.provider !== providerName) return m;
				return {
					...m,
					baseUrl: config.baseUrl ?? m.baseUrl,
				};
			});
		}
	}
}

/**
 * Input type for registerProvider API.
 */
export interface ProviderConfigInput {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	/** Prompt cache retention for all models of this provider (model level wins) */
	cacheRetention?: CacheRetention;
	/** OAuth provider for /login support */
	oauth?: OAuthAuth;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
		cacheRetention?: CacheRetention;
	}>;
}
