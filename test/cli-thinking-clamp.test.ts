import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "../src/core/agent/types.js";
import type { CreateSessionFacadeResult } from "../src/core/session/session-facade-factory.js";
import { applyCliThinkingClampToFacade } from "../src/main.js";

function facadeWithThinking(
	model: Partial<Model<any>> | undefined,
	thinkingLevel: ThinkingLevel,
): { created: CreateSessionFacadeResult; setThinkingLevel: ReturnType<typeof vi.fn> } {
	const setThinkingLevel = vi.fn();
	return {
		setThinkingLevel,
		created: {
			model,
			thinkingLevel,
			facade: { runtime: { setThinkingLevel } },
		} as unknown as CreateSessionFacadeResult,
	};
}

describe("applyCliThinkingClampToFacade", () => {
	it("keeps xhigh when the model supports it", async () => {
		const { created, setThinkingLevel } = facadeWithThinking(
			{ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
			"xhigh",
		);

		await applyCliThinkingClampToFacade(created, true);

		expect(setThinkingLevel).not.toHaveBeenCalled();
	});

	it("clamps xhigh down to high when the model does not support xhigh", async () => {
		const { created, setThinkingLevel } = facadeWithThinking({ reasoning: true }, "xhigh");

		await applyCliThinkingClampToFacade(created, true);

		expect(setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(setThinkingLevel).toHaveBeenCalledWith("high");
	});

	it("clamps xhigh down to high when the model explicitly rejects xhigh", async () => {
		const { created, setThinkingLevel } = facadeWithThinking(
			{ reasoning: true, thinkingLevelMap: { xhigh: null } },
			"xhigh",
		);

		await applyCliThinkingClampToFacade(created, true);

		expect(setThinkingLevel).toHaveBeenCalledWith("high");
	});

	it("clamps thinking to off when the model cannot reason", async () => {
		const { created, setThinkingLevel } = facadeWithThinking(
			{ reasoning: false, thinkingLevelMap: { xhigh: "xhigh" } },
			"xhigh",
		);

		await applyCliThinkingClampToFacade(created, true);

		expect(setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(setThinkingLevel).toHaveBeenCalledWith("off");
	});

	it("leaves an unsupported xhigh alone when the CLI did not override thinking", async () => {
		const { created, setThinkingLevel } = facadeWithThinking({ reasoning: true }, "xhigh");

		await applyCliThinkingClampToFacade(created, false);

		expect(setThinkingLevel).not.toHaveBeenCalled();
	});
});
