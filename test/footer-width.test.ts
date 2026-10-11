import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/context/footer-data-provider.js";
import type { FooterSessionInfo } from "../packages/tui/components/footer.js";
import { FooterComponent } from "../packages/tui/components/footer.js";
import { initTheme } from "../packages/tui/theme/theme.js";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
}): FooterSessionInfo {
	const usage = options.usage;
	return {
		getModel: () => ({
			id: options.modelId ?? "test-model",
			provider: options.provider ?? "test",
			contextWindow: 200_000,
			reasoning: options.reasoning ?? false,
		}),
		getThinkingLevel: () => options.thinkingLevel ?? "off",
		getTokenUsage: () => ({
			totalInput: usage?.input ?? 0,
			totalOutput: usage?.output ?? 0,
			totalCacheRead: usage?.cacheRead ?? 0,
			totalCacheWrite: usage?.cacheWrite ?? 0,
			totalCost: usage?.cost.total ?? 0,
		}),
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		getCwd: () => "/tmp/project",
		isUsingOAuthSubscription: () => false,
	};
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width", () => {
		const width = 93;
		const session = createSession({ modelId: "mod".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
