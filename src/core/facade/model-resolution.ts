/**
 * Model + thinking level resolution phase for createSessionFacade.
 */

import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { getDocsPath } from "../../config.js";
import type { ThinkingLevel } from "../agent/index.js";
import { DEFAULT_THINKING_LEVEL } from "../config/defaults.js";
import type { ModelRegistry } from "../models/model-registry.js";
import { findInitialModel } from "../models/model-resolver.js";
import type { SettingsManager } from "../config/settings-manager.js";

export interface ModelResolutionOptions {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	isContinuing?: boolean;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
}

export interface ModelResolutionResult {
	model: Model<any> | undefined;
	thinkingLevel: ThinkingLevel;
	/** Warning for the UI when no model could be resolved. */
	modelFallbackMessage: string | undefined;
}

export async function resolveInitialModel(options: ModelResolutionOptions): Promise<ModelResolutionResult> {
	const { settingsManager, modelRegistry } = options;
	let model = options.model;
	let modelFallbackMessage: string | undefined;

	if (!model) {
		const resolved = await findInitialModel({
			scopedModels: [],
			isContinuing: options.isContinuing ?? false,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = resolved.model;
		if (!model) {
			modelFallbackMessage = `No models available. Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}. Then use /model to select a model.`;
		}
	}

	let thinkingLevel: ThinkingLevel =
		options.thinkingLevel ?? settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	if (!model || !model.reasoning) {
		thinkingLevel = "off";
	}

	return { model, thinkingLevel, modelFallbackMessage };
}