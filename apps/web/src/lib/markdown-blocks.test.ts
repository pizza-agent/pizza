import { describe, it, expect } from "vitest";
import { splitBlocks } from "./markdown-blocks";

describe("splitBlocks", () => {
	it("returns one block for text without blank lines", () => {
		expect(splitBlocks("hello\nworld")).toEqual(["hello\nworld"]);
	});

	it("splits on a single blank line", () => {
		expect(splitBlocks("a\n\nb")).toEqual(["a", "b"]);
	});

	it("swallows runs of blank lines into one boundary", () => {
		expect(splitBlocks("a\n\n\n\nb")).toEqual(["a", "b"]);
	});

	it("ignores leading and trailing blank lines", () => {
		expect(splitBlocks("\n\na\n\n")).toEqual(["a"]);
	});

	it("returns an empty list for empty input", () => {
		expect(splitBlocks("")).toEqual([]);
		expect(splitBlocks("\n\n")).toEqual([]);
	});

	it("does not split inside a fenced code block", () => {
		const doc = "before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter";
		expect(splitBlocks(doc)).toEqual([
			"before",
			"```ts\nconst a = 1;\n\nconst b = 2;\n```",
			"after",
		]);
	});

	it("treats everything after an unclosed fence as one tail block", () => {
		expect(splitBlocks("intro\n\n```\nline 1\n\nline 2")).toEqual([
			"intro",
			"```\nline 1\n\nline 2",
		]);
	});

	it("a closing fence must match char and have length >= opener", () => {
		// ```` opens; ``` cannot close it
		expect(splitBlocks("````\nx\n```\ny")).toEqual(["````\nx\n```\ny"]);
		// tildes and backticks do not close each other
		expect(splitBlocks("~~~\nx\n```\ny")).toEqual(["~~~\nx\n```\ny"]);
	});

	it("supports tilde fences", () => {
		expect(splitBlocks("~~~\n\nx\n~~~\n\ny")).toEqual(["~~~\n\nx\n~~~", "y"]);
	});

	it("a fence with an info string still opens", () => {
		expect(splitBlocks("```js foo\n\nx")).toEqual(["```js foo\n\nx"]);
	});

	it("four-space-indented ``` is not a fence", () => {
		// Indented code: the blank line still splits.
		expect(splitBlocks("    ```\n\nx")).toEqual(["    ```", "x"]);
	});

	it("up to three spaces of indent still counts as a fence", () => {
		expect(splitBlocks("   ```\n\nx")).toEqual(["   ```\n\nx"]);
	});

	it("keeps a list with a blank line between items as two blocks", () => {
		expect(splitBlocks("- a\n\n- b")).toEqual(["- a", "- b"]);
	});

	it("block boundaries are append-stable", () => {
		const a = splitBlocks("intro\n\n```ts\nconst");
		const b = splitBlocks("intro\n\n```ts\nconst x = 1;\n\nmore code\n```\n\noutro");
		// appending never changes an earlier block's content or count
		expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, -1));
		expect(b[0]).toBe("intro");
	});
});