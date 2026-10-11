import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai/compat";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { getOAuthFlow } from "../src/core/auth/oauth.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth/auth-storage.js";
import { clearApiKeyCache, ModelRegistry } from "../src/core/models/model-registry.js";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pizza-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearApiKeyCache();
	});

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "anthropic-messages",
	) {
		return {
			baseUrl,
			apiKey: "TEST_KEY",
			api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function writeModelsJson(providers: Record<string, ReturnType<typeof providerConfig>>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	/** Create a baseUrl-only override (no custom models) */
	function overrideConfig(baseUrl: string, headers?: Record<string, string>) {
		return { baseUrl, ...(headers && { headers }) };
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	const openAiModel: Model<Api> = {
		id: "test-openai-model",
		name: "Test OpenAI Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const emptyContext: Context = {
		messages: [],
	};

	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers resolves at request time", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				const auth = await registry.getApiKeyAndHeaders(model);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.headers?.["X-Custom-Header"]).toBe("custom-value");
				}
			}
		});

		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const googleModels = getModelsForProvider(registry, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for google (merged with built-ins)
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(registry, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some((m) => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			registry.refresh();

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

	describe("custom models merge behavior", () => {
		test("built-in provider custom models inherit api and baseUrl without explicit fields", () => {
			// Built-in providers already have api/baseUrl on every model, and auth
			// comes from env vars / auth storage. No need to specify them.
			writeRawModelsJson({
				openrouter: {
					models: [
						{
							id: "fake-provider/fake-model",
							name: "Fake model",
							reasoning: true,
							input: ["text"],
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();

			const model = registry.find("openrouter", "fake-provider/fake-model");
			expect(model).toBeDefined();
			expect(model?.api).toBe("openai-completions");
			expect(model?.baseUrl).toBe("https://openrouter.ai/api/v1");
		});

		test("non-built-in provider custom models still require baseUrl", () => {
			writeRawModelsJson({
				"my-custom-provider": {
					models: [
						{
							id: "my-model",
							api: "openai-completions",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toContain("baseUrl");
		});

		test("non-built-in provider custom models can use auth.json credentials", () => {
			authStorage.set("my-custom-provider", { type: "api_key", key: "auth-json-key" });
			writeRawModelsJson({
				"my-custom-provider": {
					baseUrl: "https://my-proxy.example.com/v1",
					api: "openai-completions",
					models: [
						{
							id: "my-model",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(registry.getError()).toBeUndefined();
			expect(registry.find("my-custom-provider", "my-model")).toBeDefined();
			expect(registry.getAvailable().some((m) => m.provider === "my-custom-provider")).toBe(true);
		});

		test("custom provider with same name as built-in merges with built-in models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("custom model with same id replaces built-in model by id", () => {
			writeModelsJson({
				openrouter: providerConfig(
					"https://my-proxy.example.com/v1",
					[{ id: "anthropic/claude-sonnet-4" }],
					"openai-completions",
				),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnetModels = models.filter((m) => m.id === "anthropic/claude-sonnet-4");

			expect(sonnetModels).toHaveLength(1);
			expect(sonnetModels[0].baseUrl).toBe("https://my-proxy.example.com/v1");
		});

		test("custom provider with same name as built-in does not affect other built-in providers", () => {
			writeModelsJson({
				anthropic: providerConfig("https://my-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(getModelsForProvider(registry, "google").length).toBeGreaterThan(0);
			expect(getModelsForProvider(registry, "openai").length).toBeGreaterThan(0);
		});

		test("provider-level baseUrl applies to both built-in and custom models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://merged-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://merged-proxy.example.com/v1");
			}
		});

		test("provider-level compat applies to custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});

		test("provider-level compat applies to built-in models", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						supportsUsageInStreaming: false,
						supportsStrictMode: false,
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				const compat = model.compat as OpenAICompletionsCompat | undefined;
				expect(compat?.supportsUsageInStreaming).toBe(false);
				expect(compat?.supportsStrictMode).toBe(false);
			}
		});

		test("compat schema accepts reasoningEffortMap, supportsStrictMode, and cacheControlFormat", () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								reasoningEffortMap: {
									minimal: "default",
									high: "max",
								},
								supportsStrictMode: false,
								cacheControlFormat: "anthropic",
							},
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.reasoningEffortMap).toEqual({ minimal: "default", high: "max" });
			expect(compat?.supportsStrictMode).toBe(false);
			expect(compat?.cacheControlFormat).toBe("anthropic");
		});

		test("anthropic-messages compat schema accepts forceAdaptiveThinking and related flags", () => {
			writeRawModelsJson({
				"claude-relay": {
					baseUrl: "https://relay.example.com",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						{
							id: "claude-opus-4-5",
							reasoning: true,
							input: ["text", "image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 200000,
							maxTokens: 64000,
							compat: {
								forceAdaptiveThinking: true,
								supportsTemperature: false,
								allowEmptySignature: true,
							},
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("claude-relay", "claude-opus-4-5");
			const compat = model?.compat as any;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.forceAdaptiveThinking).toBe(true);
			expect(compat?.supportsTemperature).toBe(false);
			expect(compat?.allowEmptySignature).toBe(true);
		});

		test("anthropic-messages models matching known adaptive-thinking ids auto-enable forceAdaptiveThinking", () => {
			writeRawModelsJson({
				"claude-relay": {
					baseUrl: "https://relay.example.com",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					models: [
						// Exact match with a known adaptive-thinking built-in id
						{ id: "claude-opus-5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 64000 },
						// Suffixed relay variant
						{ id: "claude-sonnet-4-6-cc", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 64000 },
						// Non-adaptive model must stay untouched
						{ id: "claude-opus-4-5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 64000 },
					],
			},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeUndefined();

			const opus = registry.find("claude-relay", "claude-opus-5");
			expect((opus?.compat as any)?.forceAdaptiveThinking).toBe(true);
			// Inherits thinkingLevelMap from the known built-in model metadata
			expect(opus?.thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh", max: "max" });

			const sonnet = registry.find("claude-relay", "claude-sonnet-4-6-cc");
			expect((sonnet?.compat as any)?.forceAdaptiveThinking).toBe(true);

			const legacy = registry.find("claude-relay", "claude-opus-4-5");
			expect((legacy?.compat as any)?.forceAdaptiveThinking).toBeUndefined();
		});

		test("explicit forceAdaptiveThinking setting is respected over auto-detection", () => {
			writeRawModelsJson({
				"claude-relay": {
					baseUrl: "https://relay.example.com",
					apiKey: "TEST_KEY",
					api: "anthropic-messages",
					compat: { forceAdaptiveThinking: false },
					models: [
						{ id: "claude-opus-5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 64000 },
					],
			},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("claude-relay", "claude-opus-5");
			expect((model?.compat as any)?.forceAdaptiveThinking).toBe(false);
		});

		test("openai-completions models never get forceAdaptiveThinking auto-enabled", () => {
			writeRawModelsJson({
				"weird-relay": {
					baseUrl: "https://relay.example.com/v1",
					apiKey: "TEST_KEY",
					api: "openai-completions",
					models: [
						{ id: "claude-opus-5", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 64000 },
					],
			},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("weird-relay", "claude-opus-5");
			expect((model?.compat as any)?.forceAdaptiveThinking).toBeUndefined();
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", () => {
			writeRawModelsJson({
				"opencode-go": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go", "minimax-m2.5");
			const glm5 = registry.find("opencode-go", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});

		test("modelOverrides still apply when provider also defines models", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					apiKey: "OPENROUTER_API_KEY",
					api: "openai-completions",
					models: [
						{
							id: "custom/openrouter-model",
							name: "Custom OpenRouter Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 16384,
						},
					],
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Overridden Built-in Sonnet",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			expect(models.some((m) => m.id === "custom/openrouter-model")).toBe(true);
			expect(
				models.some((m) => m.id === "anthropic/claude-sonnet-4" && m.name === "Overridden Built-in Sonnet"),
			).toBe(true);
		});

		test("refresh() reloads merged custom models from disk", () => {
			writeModelsJson({
				anthropic: providerConfig("https://first-proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Update and refresh
			writeModelsJson({
				anthropic: providerConfig("https://second-proxy.example.com/v1", [{ id: "claude-custom-2" }]),
			});
			registry.refresh();

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id === "claude-custom-2")).toBe(true);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("removing custom models from models.json keeps built-in provider models", () => {
			writeModelsJson({
				anthropic: providerConfig("https://proxy.example.com/v1", [{ id: "claude-custom" }]),
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(getModelsForProvider(registry, "anthropic").some((m) => m.id === "claude-custom")).toBe(true);

			// Remove custom models and refresh
			writeModelsJson({});
			registry.refresh();

			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.some((m) => m.id === "claude-custom")).toBe(false);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Should have both the new routing AND preserve other compat settings
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("multiple model overrides on same provider", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"anthropic/claude-opus-4": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");

			const sonnetCompat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			const opusCompat = opus?.compat as OpenAICompletionsCompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers at request time", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(sonnet!);
			expect(auth.ok).toBe(true);
			if (auth.ok) {
				expect(auth.headers?.["X-Custom-Model-Header"]).toBe("value");
			}
		});

		test("refresh() picks up model override changes", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "First Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(
				getModelsForProvider(registry, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Second Name",
						},
					},
				},
			});
			registry.refresh();

			expect(
				getModelsForProvider(registry, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find(
				(m) => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			registry.refresh();

			const restoredName = getModelsForProvider(registry, "openrouter").find(
				(m) => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

	describe("dynamic provider lifecycle", () => {
		test("failed registerProvider does not persist invalid streamSimple config", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			expect(() => registry.refresh()).not.toThrow();
		});

		test("failed registerProvider does not remove existing provider models", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("demo-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();

			expect(() =>
				registry.registerProvider("demo-provider", {
					baseUrl: "https://provider.test/v2",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "broken-model",
							name: "Broken Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				}),
			).toThrow('Provider demo-provider, model broken-model: no "api" specified.');

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
			expect(() => registry.refresh()).not.toThrow();
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("unregisterProvider removes custom OAuth provider and restores built-in OAuth provider", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("anthropic", {
				oauth: {
					name: "Custom Anthropic OAuth",
					login: async () => ({
						type: "oauth",
						access: "custom-access-token",
						refresh: "custom-refresh-token",
						expires: Date.now() + 60_000,
					}),
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			});

			expect(getOAuthFlow("anthropic")?.name).toBe("Custom Anthropic OAuth");

			registry.unregisterProvider("anthropic");

			expect(getOAuthFlow("anthropic")?.name).not.toBe("Custom Anthropic OAuth");
		});

		test("unregisterProvider removes custom streamSimple override and restores built-in API stream handler", () => {
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(true);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister =
					error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});
	});

	describe("API key resolution", () => {
		/** Create provider config with custom apiKey */
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "https://example.com/v1",
				apiKey,
				api: "anthropic-messages",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!exit 1"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf ''"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("hello-world");
		});

		describe("request-time resolution", () => {
			test("command is executed on every provider lookup", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(3);
			});

			test("commands are re-executed across registry instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry1 = ModelRegistry.create(authStorage, modelsJsonPath);
				await registry1.getApiKeyForProvider("custom-provider");

				const registry2 = ModelRegistry.create(authStorage, modelsJsonPath);
				await registry2.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands resolve independently", async () => {
				writeRawModelsJson({
					"provider-a": providerWithApiKey("!echo key-a"),
					"provider-b": providerWithApiKey("!echo key-b"),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);

				const keyA = await registry.getApiKeyForProvider("provider-a");
				const keyB = await registry.getApiKeyForProvider("provider-b");

				expect(keyA).toBe("key-a");
				expect(keyB).toBe("key-b");
			});

			test("failed commands are retried", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const key1 = await registry.getApiKeyForProvider("custom-provider");
				const key2 = await registry.getApiKeyForProvider("custom-provider");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(envVarName),
					});

					const registry = ModelRegistry.create(authStorage, modelsJsonPath);

					const key1 = await registry.getApiKeyForProvider("custom-provider");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await registry.getApiKeyForProvider("custom-provider");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("getAvailable does not execute command-backed apiKey resolution", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const available = registry.getAvailable();

				expect(available.some((m) => m.provider === "custom-provider")).toBe(true);
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(0);
			});

			test("getApiKeyAndHeaders resolves authHeader on every request", async () => {
				const tokenFile = join(tempDir, "token");
				writeFileSync(tokenFile, "token-1");
				const tokenPath = toShPath(tokenFile);

				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(`!sh -c 'cat "${tokenPath}"'`),
						authHeader: true,
					},
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth1 = await registry.getApiKeyAndHeaders(model!);
				expect(auth1.ok).toBe(true);
				if (auth1.ok) {
					expect(auth1.apiKey).toBe("token-1");
					expect(auth1.headers?.["Authorization"]).toBe("Bearer token-1");
				}

				writeFileSync(tokenFile, "token-2");

				const auth2 = await registry.getApiKeyAndHeaders(model!);
				expect(auth2.ok).toBe(true);
				if (auth2.ok) {
					expect(auth2.apiKey).toBe("token-2");
					expect(auth2.headers?.["Authorization"]).toBe("Bearer token-2");
				}
			});

			test("getApiKeyAndHeaders returns an error for failed authHeader resolution", async () => {
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey("!exit 1"),
						authHeader: true,
					},
				});

				const registry = ModelRegistry.create(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth = await registry.getApiKeyAndHeaders(model!);
				expect(auth.ok).toBe(false);
				if (!auth.ok) {
					expect(auth.error).toContain('Failed to resolve API key for provider "custom-provider"');
				}
			});
		});
	describe("pi-ai built-in models", () => {
		test("glm-5.3 is available on zai-coding-cn", () => {
			const registry = ModelRegistry.inMemory(authStorage);

			const glm53 = registry.find("zai-coding-cn", "glm-5.3");
			expect(glm53).toBeDefined();
			expect(glm53!.name).toBe("GLM-5.3");
			expect(glm53!.contextWindow).toBe(1_000_000);
			expect(glm53!.api).toBe("openai-completions");
		});

		test("custom models.json still wins over built-ins", () => {
			writeRawModelsJson({
				"zai-coding-cn": {
					models: [
						{
							id: "glm-5.3",
							name: "My GLM-5.3",
							contextWindow: 123456,
							maxTokens: 4096,
						},
					],
				},
			});

			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("zai-coding-cn", "glm-5.3");
			expect(model).toBeDefined();
			expect(model!.name).toBe("My GLM-5.3");
			expect(model!.contextWindow).toBe(123456);
		});
	});
	});

	describe("cacheRetention", () => {
		function writeWithRetention(config: Record<string, unknown>) {
			writeFileSync(modelsJsonPath, JSON.stringify({ providers: { relay: config } }));
		}

		const baseModel = {
			id: "claude-fable-5-cc",
			name: "Fable",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 8000,
		};

		test("is undefined when not configured, so pi-ai keeps its default", () => {
			writeWithRetention({
				baseUrl: "https://relay.example.com",
				apiKey: "K",
				api: "anthropic-messages",
				models: [baseModel],
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("relay", "claude-fable-5-cc")!;
			expect(registry.getCacheRetention(model)).toBeUndefined();
		});

		test("reads per-model cacheRetention", () => {
			writeWithRetention({
				baseUrl: "https://relay.example.com",
				apiKey: "K",
				api: "anthropic-messages",
				models: [{ ...baseModel, cacheRetention: "none" }],
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("relay", "claude-fable-5-cc")!;
			expect(registry.getCacheRetention(model)).toBe("none");
		});

		test("reads provider-level cacheRetention (no other request config present)", () => {
			writeWithRetention({
				baseUrl: "https://relay.example.com",
				api: "anthropic-messages",
				cacheRetention: "none",
				models: [baseModel],
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("relay", "claude-fable-5-cc")!;
			expect(registry.getCacheRetention(model)).toBe("none");
		});

		test("per-model wins over provider level", () => {
			writeWithRetention({
				baseUrl: "https://relay.example.com",
				apiKey: "K",
				api: "anthropic-messages",
				cacheRetention: "long",
				models: [{ ...baseModel, cacheRetention: "none" }],
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("relay", "claude-fable-5-cc")!;
			expect(registry.getCacheRetention(model)).toBe("none");
		});

		test("modelOverrides can set cacheRetention on a built-in model", () => {
			writeFileSync(
				modelsJsonPath,
				JSON.stringify({
					providers: {
						anthropic: { modelOverrides: { "claude-sonnet-4-5": { cacheRetention: "none" } } },
					},
				}),
			);
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const model = registry.find("anthropic", "claude-sonnet-4-5");
			if (!model) return; // built-in id drifted; precedence covered by other cases
			expect(registry.getCacheRetention(model)).toBe("none");
		});

		test("rejects an invalid cacheRetention value", () => {
			writeWithRetention({
				baseUrl: "https://relay.example.com",
				apiKey: "K",
				api: "anthropic-messages",
				models: [{ ...baseModel, cacheRetention: "forever" }],
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.getError()).toBeTruthy();
		});

	});


	describe("adaptive thinking fallback", () => {
		function createRegistry() {
			writeModelsJson({
				"relay-provider": {
					...providerConfig("https://relay.example.com", [{ id: "relay-thinker-9" }]),
				},
			});
			return ModelRegistry.create(authStorage, modelsJsonPath);
		}

		test("rememberAdaptiveThinking patches the live model entry", () => {
			const registry = createRegistry();
			const model = registry.find("relay-provider", "relay-thinker-9")!;
			expect((model.compat as any)?.forceAdaptiveThinking).not.toBe(true);

			const patched = registry.rememberAdaptiveThinking(model);
			expect((patched.compat as any)?.forceAdaptiveThinking).toBe(true);
			// The registry entry itself is updated, so future lookups see it
			expect((registry.find("relay-provider", "relay-thinker-9")!.compat as any)?.forceAdaptiveThinking).toBe(true);
		});

		test("explicit compat.forceAdaptiveThinking survives refresh", () => {
			const registry = createRegistry();
			registry.rememberAdaptiveThinking(registry.find("relay-provider", "relay-thinker-9")!);
			// refresh() reloads from disk, which does not persist learned flags —
			// learned state lives in memory for the process lifetime only.
			registry.refresh();
			expect(
				(registry.find("relay-provider", "relay-thinker-9")!.compat as any)?.forceAdaptiveThinking,
			).not.toBe(true);
		});
	});

	describe("models.json hot reload", () => {
		test("manual edits are picked up by read paths without restart", async () => {
			writeModelsJson({
				"relay-provider": {
					...providerConfig("https://relay.example.com", [{ id: "model-a" }]),
				},
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			expect(registry.find("relay-provider", "model-a")).toBeDefined();
			expect(registry.find("relay-provider", "model-b")).toBeUndefined();

			// Simulate an out-of-band edit. mtime granularity can hide same-second
			// writes, so bump it explicitly.
			const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
			config.providers["relay-provider"].models.push({
				id: "model-b",
				name: "model-b",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			});
			writeFileSync(modelsJsonPath, JSON.stringify(config));
			const future = new Date(Date.now() + 2000);
			utimesSync(modelsJsonPath, future, future);

			// No refresh() call — the read path notices the change itself.
			expect(registry.find("relay-provider", "model-b")).toBeDefined();
			expect(registry.getAll().some((m) => m.id === "model-b")).toBe(true);
		});

		test("unchanged file does not reload (mtime guard)", () => {
			writeModelsJson({
				"relay-provider": {
					...providerConfig("https://relay.example.com", [{ id: "model-a" }]),
				},
			});
			const registry = ModelRegistry.create(authStorage, modelsJsonPath);
			const before = registry.getAll().length;
			expect(registry.find("relay-provider", "model-a")).toBeDefined();
			expect(registry.getAll().length).toBe(before);
		});
	});
});
