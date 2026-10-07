/**
 * Regression coverage for the "positional new/content value got its inner
 * quotes silently stripped" footgun.
 *
 * Background: the shell-word splitter (correctly) treats `"` / `'` as quoting.
 * So a positional argument written WITHOUT an enclosing pair of quotes — e.g.
 * the edit `new` text `secret("X", "Y")` — has its inner quotes consumed as
 * quoting and dropped, and the surviving fragments get rejoined into a WRONG
 * value that the tool would otherwise apply silently.
 *
 * The fix: when a positional new/content value is reconstructed from MORE THAN
 * ONE word AND the splitter consumed at least one quote delimiter, the parser
 * throws a guided error instead of applying corrupted content. Correctly-formed
 * inputs (whole value quoted, --edits JSON, heredoc, bare multi-word without
 * quotes) are unaffected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBashTool } from "../src/core/tools/bash.js";
import { parseBuiltinCommand, parseBuiltinToolInput } from "../src/core/tools/builtin-commands.js";
import { splitShellWordsWithMeta } from "../src/core/shell-words.js";

function parseEdit(cmd: string) {
	const parsed = parseBuiltinCommand(cmd);
	return parseBuiltinToolInput("_edit", parsed.args, parsed.heredoc, {
		quoteDelimitersConsumed: parsed.quoteDelimitersConsumed,
	});
}

function parseWrite(cmd: string) {
	const parsed = parseBuiltinCommand(cmd);
	return parseBuiltinToolInput("_write", parsed.args, parsed.heredoc, {
		quoteDelimitersConsumed: parsed.quoteDelimitersConsumed,
	});
}

describe("splitShellWordsWithMeta — quote delimiter accounting", () => {
	it("counts quote characters consumed as quoting", () => {
		// `secret("X", "Y")` → 4 quote delimiters consumed (2 pairs).
		const { meta } = splitShellWordsWithMeta(`secret("X", "Y")`);
		expect(meta.quoteDelimitersConsumed).toBe(4);
	});
	it("reports zero for bare unquoted words", () => {
		const { meta } = splitShellWordsWithMeta("hello world foo");
		expect(meta.quoteDelimitersConsumed).toBe(0);
	});
	it("reports the delimiters for one fully-quoted value", () => {
		// `"hello world"` → 2 delimiters consumed, but it is a SINGLE word.
		const { words, meta } = splitShellWordsWithMeta(`"hello world"`);
		expect(words).toEqual(["hello world"]);
		expect(meta.quoteDelimitersConsumed).toBe(2);
	});
});

describe("edit — quote-stripping guard (parser level)", () => {
	it("REJECTS an unquoted positional `new` whose inner quotes would be stripped", () => {
		// This is the exact footgun: the inner " were consumed as quoting.
		expect(() =>
			parseEdit(`_edit src/c.ts replace 80#e6   x: secret("S", "d"),`),
		).toThrow(/quote-stripped/);
	});

	it("preserves a correctly whole-quoted `new` value (quotes kept)", () => {
		// The whole value is wrapped in double quotes; inner quotes are backslash-escaped
		// so the shell-word splitter keeps them as literal quote characters.
		// Build the command from parts so the quote escaping is unambiguous and
		// survives the file round-trip. We want the splitter to see, verbatim:
		//   replace 80#e6 "secret(\"S\", \"d\")"
		const q = String.fromCharCode(34); // "
		const cmd = `_edit src/c.ts replace 80#e6 ${q}secret(\\${q}S\\${q}, \\${q}d\\${q})${q}`;
		const r = parseEdit(cmd);
		expect(r.input.edits[0]?.new).toBe('secret("S", "d")');
	});

	it("preserves quotes/spaces/indent via --edits JSON", () => {
		// Build the JSON from an object so the quote escaping is unambiguous.
		const editsJson = JSON.stringify([
			{ op: "replace", range: "80#e6", new: '  call("S", "d")' },
		]);
		const r = parseEdit(`_edit src/c.ts --edits '${editsJson}'`);
		expect(r.input.edits[0]?.new).toBe('  call("S", "d")');
	});

	it("does NOT reject a bare multi-word `new` with no quotes (legitimate)", () => {
		const r = parseEdit(`_edit src/c.ts replace 80#e6 const a = 2`);
		expect(r.input.edits[0]?.new).toBe("const a = 2");
	});

	it("does NOT reject a single-quoted value", () => {
		const r = parseEdit(`_edit src/c.ts replace 80#e6 "const a = 2"`);
		expect(r.input.edits[0]?.new).toBe("const a = 2");
	});

	it("does NOT reject the --new flag form", () => {
		const r = parseEdit(`_edit src/c.ts --op replace --range 80#e6 --new 'has "quotes" inside'`);
		expect(r.input.edits[0]?.new).toBe('has "quotes" inside');
	});

	it("also guards the search form", () => {
		expect(() =>
			parseEdit(`_edit src/c.ts search const a = call("x", "y")`),
		).toThrow(/quote-stripped/);
	});
});

describe("write — quote-stripping guard (parser level)", () => {
	it("REJECTS unquoted positional content with inner quotes", () => {
		expect(() => parseWrite(`_write f.txt prefix("a", "b")`)).toThrow(/quote-stripped/);
	});

	it("preserves content via --content", () => {
		const r = parseWrite(`_write f.txt --content 'prefix("a", "b")'`);
		expect(r.input.content).toBe('prefix("a", "b")');
	});

	it("preserves content via a quoted heredoc", () => {
		const r = parseWrite(`_write f.txt <<'EOF'\nprefix("a", "b")\nEOF`);
		expect(r.input.content).toBe('prefix("a", "b")');
	});

	it("does NOT reject bare multi-word content without quotes", () => {
		const r = parseWrite(`_write notes.txt hello world`);
		expect(r.input.content).toBe("hello world");
	});
});

describe("cli tool — end-to-end (no silent file corruption)", () => {
	let testDir: string;
	let file: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pizza-quote-guard-"));
		file = join(testDir, "c.ts");
		writeFileSync(file, '  x: secret("OLD", "old"),\n');
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns a guidance error AND leaves the file unchanged for the footgun input", async () => {
		const bash = createBashTool(testDir);
		const result = await bash.execute("guard-1", { command: `_edit ${file.replace(/\\/g, "/")} replace 1#xx x: secret("S", "d"),` });

		const out = (result.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
		expect(out).toMatch(/quote-stripped/);
		expect(out).toMatch(/--new|--edits|heredoc/);
		// The guidance must include a concrete, copy-pasteable rewrite (a JSON
		// --edits template for edit), not just "use --edits".
		expect(out).toMatch(/--edits '\[\{"op":"replace"/);
		// Crucially: the file was NOT modified.
		expect(readFileSync(file, "utf-8")).toBe('  x: secret("OLD", "old"),\n');
	});

	it("applies the edit correctly via --edits JSON (quotes/spaces preserved)", async () => {
		const bash = createBashTool(testDir);
		// Anchor the only line. Use search-free JSON edit with a stable range.
		const result = await bash.execute("guard-2", {
			command: `_edit ${file.replace(/\\/g, "/")} --edits '[{"op":"search","old":"secret(\\"OLD\\", \\"old\\")","new":"secret(\\"S\\", \\"d\\")"}]'`,
		});
		const out = (result.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
		expect(out).toContain("Successfully applied 1 edit(s)");
		expect(readFileSync(file, "utf-8")).toBe('  x: secret("S", "d"),\n');
	});

	it("points edit/write multi-line rejection at the verbatim channels", async () => {
		const bash = createBashTool(testDir);
		// A literal newline in an unquoted positional new value.
		const cmd = `_edit ${file.replace(/\\/g, "/")} replace 1#xx line one\nline two`;
		const result = await bash.execute("guard-3", { command: cmd });
		const out = (result.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
		expect(out).toMatch(/does not support shell operators/);
		expect(out).toMatch(/--edits|heredoc|quotes/);
	});
});

