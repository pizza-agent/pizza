import { describe, expect, it } from "vitest";
import {
	annotateTextWithLineAnchors,
	buildLineRecords,
	formatLineAnchor,
	formatRange,
	hashLine,
	looksLikeRange,
	parseRange,
	resolveRange,
} from "../src/core/tools/line-anchors.js";

describe("line-anchors", () => {
	describe("hashLine", () => {
		it("produces a 4-hex hash", () => {
			expect(hashLine("hello")).toMatch(/^[0-9a-f]{4}$/);
		});

		it("is deterministic for identical input", () => {
			expect(hashLine("abc")).toBe(hashLine("abc"));
		});

		it("is case-sensitive and distinguishes content", () => {
			expect(hashLine("a")).not.toBe(hashLine("b"));
		});

		it("hashes the empty string", () => {
			expect(hashLine("")).toMatch(/^[0-9a-f]{4}$/);
		});
	});

	describe("formatLineAnchor / formatRange", () => {
		it("formats a single line anchor as <line>#<hash>", () => {
			expect(formatLineAnchor(5, "hello")).toBe(`5#${hashLine("hello")}`);
		});

		it("formats a single-point range as just the start id", () => {
			const id = formatLineAnchor(3, "x");
			expect(formatRange({ line: 3, hash: hashLine("x") })).toBe(id);
		});

		it("formats a multi-line range as start..end", () => {
			const range = formatRange(
				{ line: 1, hash: hashLine("a") },
				{ line: 3, hash: hashLine("c") },
			);
			expect(range).toBe(`1#${hashLine("a")}..3#${hashLine("c")}`);
		});
	});

	describe("parseRange", () => {
		it("parses a single anchor", () => {
			const anchor = formatLineAnchor(7, "world");
			expect(parseRange(anchor)).toEqual({ start: { line: 7, hash: hashLine("world") }, end: { line: 7, hash: hashLine("world") } });
		});

		it("parses a start..end range", () => {
			const range = `${formatLineAnchor(2, "b")}..${formatLineAnchor(4, "d")}`;
			const parsed = parseRange(range);
			expect(parsed.start).toEqual({ line: 2, hash: hashLine("b") });
			expect(parsed.end).toEqual({ line: 4, hash: hashLine("d") });
		});

		it("rejects line number 0", () => {
			expect(() => parseRange("0#ab")).toThrow(/Invalid range/);
		});

		it("accepts 2-4 hex digits and rejects longer hashes", () => {
			expect(parseRange("5#ab").start.hash).toBe("ab");
			expect(parseRange("5#abc").start.hash).toBe("abc");
			expect(parseRange("5#abcd").start.hash).toBe("abcd");
			expect(() => parseRange("5#abcde")).toThrow(/Invalid range/);
		});

		it("rejects a reversed range (start line after end line)", () => {
			expect(() => parseRange("5#ab..3#cd")).toThrow(/Start line must be before/);
		});

		it("rejects an empty range", () => {
			expect(() => parseRange("   ")).toThrow(/must not be empty/);
		});

		it("rejects a range with more than two segments", () => {
			expect(() => parseRange("1#aa..2#bb..3#cc")).toThrow(/Invalid range/);
		});
	});

	describe("looksLikeRange", () => {
		it("returns true for a valid anchor", () => {
			expect(looksLikeRange(formatLineAnchor(1, "a"))).toBe(true);
		});

		it("returns false for arbitrary text", () => {
			expect(looksLikeRange("not-a-range")).toBe(false);
		});
	});

	describe("buildLineRecords", () => {
		it("returns a single empty record for empty content", () => {
			const records = buildLineRecords("");
			expect(records).toHaveLength(1);
			expect(records[0].lineNumber).toBe(1);
			expect(records[0].text).toBe("");
		});

		it("builds one record per line with sequential numbers", () => {
			const records = buildLineRecords("a\nb\nc");
			expect(records.map((r) => r.lineNumber)).toEqual([1, 2, 3]);
			expect(records.map((r) => r.text)).toEqual(["a", "b", "c"]);
		});

		it("does not emit a phantom trailing record after a final newline", () => {
			const records = buildLineRecords("a\n");
			expect(records).toHaveLength(1);
			expect(records[0].text).toBe("a");
		});
	});

	describe("annotateTextWithLineAnchors", () => {
		it("prefixes each line with its anchor", () => {
			const annotated = annotateTextWithLineAnchors("x\ny");
			expect(annotated).toBe(`1#${hashLine("x")} | x\n2#${hashLine("y")} | y`);
		});

		it("honors a custom start line number", () => {
			const annotated = annotateTextWithLineAnchors("z", 10);
			expect(annotated).toBe(`10#${hashLine("z")} | z`);
		});

		it("returns empty string for empty input", () => {
			expect(annotateTextWithLineAnchors("")).toBe("");
		});
	});

	describe("resolveRange", () => {
		it("resolves a direct anchor match", () => {
			const content = "alpha\nbeta\ngamma";
			const anchor = `${formatLineAnchor(2, "beta")}`;
			const resolved = resolveRange(content, anchor, "f.txt");
			expect(resolved.startLine).toBe(2);
			expect(resolved.endLine).toBe(2);
			expect(resolved.existingText).toBe("beta\n");
			expect(resolved.usedRelocation).toBe(false);
		});

		it("resolves a multi-line range and reports the joined text", () => {
			const content = "alpha\nbeta\ngamma";
			const range = `${formatLineAnchor(1, "alpha")}..${formatLineAnchor(2, "beta")}`;
			const resolved = resolveRange(content, range, "f.txt");
			expect(resolved.existingText).toBe("alpha\nbeta\n");
		});

		it("relocates by content hash when line numbers shifted but content matches uniquely", () => {
			const content = "intro\nalpha\nbeta"; // "alpha" now on line 2, "beta" on line 3
			// Anchor pretends "alpha" is line 1 (stale) — content match should relocate it.
			const anchor = formatLineAnchor(1, "alpha");
			const resolved = resolveRange(content, anchor, "f.txt");
			expect(resolved.startLine).toBe(2);
			expect(resolved.usedRelocation).toBe(true);
		});

		it("resolves legacy 2-hex anchors as hash prefixes", () => {
			const content = "alpha\nbeta\ngamma";
			const legacy = `2#${hashLine("beta").slice(0, 2)}`;
			const resolved = resolveRange(content, legacy, "f.txt");
			expect(resolved.startLine).toBe(2);
			expect(resolved.existingText).toBe("beta\n");
			expect(resolved.usedRelocation).toBe(false);
		});

		it("lists candidate locations in the ambiguous error", () => {
			const content = "alpha\nbeta\nalpha\nbeta\nalpha";
			const wrongLine = `1#${hashLine("beta")}`; // "beta" lives on 2 and 4
			expect(() => resolveRange(content, wrongLine, "f.txt")).toThrow(/ambiguous.*2#[0-9a-f]{4}.*4#[0-9a-f]{4}/);
		});

		it("throws a stale error when no candidate matches", () => {
			const content = "alpha\nbeta";
			// Valid legacy 2-hex hashes that do not match either lines content hash.
			expect(() => resolveRange(content, "1#aa..2#bb", "f.txt")).toThrow(/stale/);
		});
	});
});