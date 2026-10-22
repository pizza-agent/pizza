import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../packages/tui/interactive-mode.js";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat from the projection (which already carries the summary)", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			ui: { requestRender: vi.fn() },
		};

		const handleModeEvent = Reflect.get(InteractiveMode.prototype, "handleModeEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_finished";
				eventId: string;
				summary: string;
				firstKeptEventId: string;
				tokensBefore: number;
				tokensAfter?: number;
			},
		) => Promise<void>;

		await handleModeEvent.call(fakeThis, {
			type: "compaction_finished",
			eventId: "evt-1",
			summary: "summary",
			firstKeptEventId: "kept-1",
			tokensBefore: 123,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		// The summary must NOT be appended on top of the rebuild — the
		// projection already injects it at the boundary; adding it again
		// rendered the [compaction] block twice (verified live).
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
});
