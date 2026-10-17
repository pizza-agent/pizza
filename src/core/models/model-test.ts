/**
 * One-shot model connectivity test backing the `test_model` RPC command
 * (settings UI per-model "test" buttons).
 *
 * The request goes through pi-ai's `completeSimple` with the registry's
 * resolved auth, so everything real chat traffic applies — OAuth token
 * refresh, per-credential baseUrl (GitHub Copilot), custom headers, compat
 * fixes like forceAdaptiveThinking — also applies here. A direct HTTP probe
 * would silently miss all of that.
 */

import { completeSimple, type Api, type Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "./model-registry.js";

export interface ModelTestResult {
	ok: boolean;
	provider: string;
	modelId: string;
	/** First text snippet from the reply on success, else null. */
	response?: string | null;
	/** Human-readable failure reason. Absent/null on success. */
	error?: string | null;
	latencyMs: number;
}

/** Cap on the reply snippet returned to the UI. */
const MAX_RESPONSE_CHARS = 200;
/**
 * Output budget for the probe. Reasoning models (GLM, MiniMax M2.x, ...)
 * think by default before answering; a small cap gets fully consumed by the
 * thinking phase and the reply ends truncated (stopReason "length") with no
 * text block at all. 2048 leaves room for thinking plus a short answer while
 * staying a negligible-cost request — providers bill actual usage, not the cap.
 */
const TEST_MAX_TOKENS = 2048;

export async function testModel(registry: ModelRegistry, model: Model<Api>): Promise<ModelTestResult> {
	const base: ModelTestResult = {
		ok: false,
		provider: model.provider,
		modelId: model.id,
		response: null,
		error: null,
		latencyMs: 0,
	};

	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { ...base, error: auth.error };
	}

	const started = Date.now();
	try {
		const message = await completeSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: started }] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: TEST_MAX_TOKENS,
				cacheRetention: registry.getCacheRetention(model),
			},
		);
		const latencyMs = Date.now() - started;
		// pi-ai reports provider/protocol failures on the message rather than
		// by throwing: stopReason "error" carries the reason in errorMessage.
		if (message.stopReason === "error") {
			return { ...base, error: message.errorMessage ?? "provider returned an error", latencyMs };
		}
		// Prefer the answer text; fall back to the thinking excerpt for the rare
		// case where the thinking phase still ate the whole budget (stopReason
		// "length") so the UI always shows what the model actually produced.
		const text = message.content.find((c) => c.type === "text")?.text?.trim() ?? "";
		const thinking = message.content.find((c) => c.type === "thinking")?.thinking?.trim() ?? "";
		const shown = (text || thinking).slice(0, MAX_RESPONSE_CHARS);
		return {
			...base,
			ok: true,
			response: shown || null,
			latencyMs,
		};
	} catch (error) {
		return {
			...base,
			error: error instanceof Error ? error.message : String(error),
			latencyMs: Date.now() - started,
		};
	}
}
