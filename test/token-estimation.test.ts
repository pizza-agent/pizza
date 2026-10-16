import { describe, expect, it } from "vitest";
import { estimateStringTokens, estimateTokens } from "../src/core/compaction/compaction.js";
import { estimateMessageStringTokens } from "../src/core/compaction/compaction-engine.js";

describe("shared token estimation", () => {
	it.each([
		["", 0],
		["abcdefgh", 2],
		["中文测试汉字", 4],
		["abcd中文测", 3],
		["😀😀😀", 4],
	])("keeps context and compaction estimates consistent for %j", (text, expected) => {
		expect(estimateStringTokens(text)).toBe(expected);
		expect(estimateMessageStringTokens(text)).toBe(expected);
		expect(estimateTokens({ role: "user", content: text, timestamp: 0 })).toBe(expected);
	});
});
