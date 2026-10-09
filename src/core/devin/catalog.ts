/**
 * Devin model catalog: `GetCliModelConfigs` → pizza provider model configs,
 * plus a static fallback list used before the first successful fetch.
 */

import type { ProviderModelConfig } from "../extensions/types.js";
import { GET_CLI_MODEL_CONFIGS_PATH, connectUnaryJson, devinDiscoveryMetadata } from "./client.js";

// --- Wire shapes (subset we consume) -----------------------------------------

interface DevinModelFeatures {
	supportsImages?: boolean;
	supportsDocuments?: boolean;
	supportsToolCalls?: boolean;
	supportsParallelToolCalls?: boolean;
	supportsThinking?: boolean;
}

interface DevinModelInfo {
	modelUid?: string;
	maxTokens?: number;
	maxOutputTokens?: number;
	modelFeatures?: DevinModelFeatures;
	inferenceServerUrl?: string;
	harnessUids?: string[];
}

interface DevinModelDimension {
	label?: string;
	value?: number;
	denominator?: string;
	kind?: string;
}

interface DevinClientModelConfig {
	label?: string;
	modelUid?: string;
	disabled?: boolean;
	isNew?: boolean;
	isBeta?: boolean;
	isRecommended?: boolean;
	description?: string;
	supportsImages?: boolean;
	maxTokens?: number;
	modelInfo?: DevinModelInfo;
	modelDimensions?: DevinModelDimension[];
}

interface DevinModelConfigsResponse {
	clientModelConfigs?: DevinClientModelConfig[];
	defaultOverrideModelConfig?: { modelUid?: string };
	subagentDefaultModelUid?: string;
}

export interface DevinCatalog {
	models: ProviderModelConfig[];
	defaultModelUid?: string;
	fetchedAt: number;
}

// --- Mapping ---------------------------------------------------------------

const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;

function supportsThinking(config: DevinClientModelConfig): boolean {
	const features = config.modelInfo?.modelFeatures;
	if (features !== undefined) return features.supportsThinking === true;
	if (NO_REASONING_LABEL_PATTERN.test(config.label ?? "")) return false;
	return REASONING_LABEL_PATTERN.test(config.label ?? "");
}

const COST_DENOMINATOR_PATTERN = /(\d+(?:\.\d+)?)\s*([kmb])?/i;
const COST_DENOMINATOR_SCALE: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/** Per-million-token rates from the config's cost dimensions. */
function modelCost(config: DevinClientModelConfig): ProviderModelConfig["cost"] {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const dimension of config.modelDimensions ?? []) {
		const label = (dimension.label ?? "").trim().toLowerCase();
		if (label === "sidekick") break; // composite (fusion) component cards follow this marker
		if (dimension.kind !== "MODEL_DIMENSION_KIND_COST" && dimension.kind !== "MODEL_DIMENSION_KIND_COST_FUZZY") {
			continue;
		}
		const match = COST_DENOMINATOR_PATTERN.exec(dimension.denominator ?? "");
		const tokens = match
			? Number(match[1]) * (COST_DENOMINATOR_SCALE[(match[2] ?? "").toLowerCase()] ?? 1)
			: 1_000_000;
		const perMillion =
			Math.round((((dimension.value ?? 0) * 1_000_000) / (tokens > 0 ? tokens : 1_000_000)) * 1e6) / 1e6;
		if (label === "input") cost.input = perMillion;
		else if (label === "cached input") cost.cacheRead = perMillion;
		else if (label === "output") cost.output = perMillion;
	}
	return cost;
}

function toModelConfig(config: DevinClientModelConfig): ProviderModelConfig | undefined {
	const uid = config.modelUid ?? config.modelInfo?.modelUid;
	if (!uid) return undefined;
	const features = config.modelInfo?.modelFeatures;
	const supportsImages =
		(features !== undefined ? features.supportsImages === true : config.supportsImages === true);
	return {
		id: uid,
		name: (config.label ?? "").trim() || uid,
		reasoning: supportsThinking(config),
		input: supportsImages ? ["text", "image"] : ["text"],
		cost: modelCost(config),
		contextWindow:
			(config.modelInfo?.maxTokens ?? 0) > 0
				? config.modelInfo!.maxTokens!
				: (config.maxTokens ?? 0) > 0
					? config.maxTokens!
					: DEFAULT_CONTEXT_WINDOW,
		maxTokens: (config.modelInfo?.maxOutputTokens ?? 0) > 0 ? config.modelInfo!.maxOutputTokens! : DEFAULT_MAX_TOKENS,
	};
}

/** Fetch the account's Devin model catalog. Throws on network/auth failure. */
export async function fetchDevinCatalog(
	apiServerUrl: string,
	apiKey: string,
	options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<DevinCatalog> {
	const response = await connectUnaryJson<DevinModelConfigsResponse>(
		apiServerUrl,
		GET_CLI_MODEL_CONFIGS_PATH,
		{ metadata: devinDiscoveryMetadata(apiKey) },
		{ signal: options?.signal, fetch: options?.fetch },
	);
	const models = (response.clientModelConfigs ?? [])
		.filter((config) => !config.disabled)
		.map(toModelConfig)
		.filter((model): model is ProviderModelConfig => model !== undefined);
	return {
		models,
		defaultModelUid: response.defaultOverrideModelConfig?.modelUid,
		fetchedAt: Date.now(),
	};
}

/**
 * Static fallback catalog, used to register the provider before credentials
 * exist (or when catalog fetch fails). Kept intentionally small — a signed-in
 * user's full catalog replaces it via `fetchDevinCatalog`.
 */
export const DEVIN_FALLBACK_MODELS: ProviderModelConfig[] = [
	{
		id: "swe-2-high",
		name: "SWE-2 High",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262000,
		maxTokens: 128000,
	},
	{
		id: "swe-2-medium",
		name: "SWE-2 Medium",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262000,
		maxTokens: 128000,
	},
	{
		id: "swe-2-max",
		name: "SWE-2 Max",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262000,
		maxTokens: 128000,
	},
	{
		id: "claude-opus-5-5-medium",
		name: "Claude Opus 5.5 Medium",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-fable-5-1-medium",
		name: "Claude Fable 5.1 Medium",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "gpt-6-sol-medium",
		name: "GPT-6 Sol Medium Thinking",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "gpt-6-astra-medium",
		name: "GPT-6 Astra Medium Thinking",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "kimi-k3-high",
		name: "Kimi K3 High",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
	},
	{
		id: "swe-1-7-lightning",
		name: "SWE-1.7 Lightning Max",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 12.5, cacheRead: 1, cacheWrite: 0 },
		contextWindow: 202752,
		maxTokens: 96000,
	},
	{
		id: "adaptive",
		name: "Adaptive",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
	},
];
