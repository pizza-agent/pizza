/**
 * Direct coverage for the POSIX-aware shell-word splitter
 * (src/core/shell-words.ts).
 *
 * The splitter's *meta* (quote-delimiter accounting) is covered by
 * builtin-quote-stripping.test.ts, but the core splitting/escaping semantics
 * documented in the module's header comment were previously exercised only
 * indirectly, through the command parser. These tests lock the documented
 * POSIX quoting behavior in place so a future change can't silently regress it.
 *
 * Quoting semantics under test:
 *   - single quotes: every character literal; backslash never escapes
 *   - double quotes: backslash special only before $ ` " \ and newline; before
 *     any other char the backslash is kept literally
 *   - unquoted: backslash escapes the next char (a trailing backslash is kept
 *     literally)
 *   - whitespace outside quotes separates words
 *   - an empty quoted region (`''` / `""`) yields a single empty-string word
 */

import { describe, it, expect } from "vitest";
import { splitShellWords, splitShellWordsWithMeta, hasShellControlSyntax, splitShellSegments } from "../src/core/exec/shell-words.js";

describe("splitShellWords — unquoted splitting", () => {
	it("splits on runs of whitespace", () => {
		expect(splitShellWords("a b c")).toEqual(["a", "b", "c"]);
		expect(splitShellWords("a    b\t\tc")).toEqual(["a", "b", "c"]);
	});

	it("collapses leading, trailing, and repeated whitespace into no empty words", () => {
		expect(splitShellWords("   a   ")).toEqual(["a"]);
		expect(splitShellWords("    ")).toEqual([]);
		expect(splitShellWords("  a  b  ")).toEqual(["a", "b"]);
	});

	it("returns an empty array for empty input", () => {
		expect(splitShellWords("")).toEqual([]);
	});

	it("returns a single word with well-formed meta", () => {
		const { words, meta } = splitShellWordsWithMeta("hello");
		expect(words).toEqual(["hello"]);
		expect(meta.quoteDelimitersConsumed).toBe(0);
	});

	it("treats a tab and newline as whitespace separators", () => {
		expect(splitShellWords("a\tb\nc")).toEqual(["a", "b", "c"]);
	});
});

describe("splitShellWords — single quotes", () => {
	it("keeps everything literally, including backslash, and preserves spaces", () => {
		expect(splitShellWords("a 'b c' d")).toEqual(["a", "b c", "d"]);
		// backslash is literal inside single quotes — it does NOT escape the
		// closing quote, so 'a\b c' is one word "a\b c".
		expect(splitShellWords("'a\\b c'")).toEqual(["a\\b c"]);
	});

	it("preserves double-quote characters inside single quotes", () => {
		expect(splitShellWords("'say \"hi\"'")).toEqual(['say "hi"']);
	});

	it("counts both single-quote delimiters", () => {
		const { meta } = splitShellWordsWithMeta("'word'");
		expect(meta.quoteDelimitersConsumed).toBe(2);
	});
});

describe("splitShellWords — double quotes", () => {
	it("preserves internal spaces", () => {
		expect(splitShellWords('a "b c" d')).toEqual(["a", "b c", "d"]);
	});

	it("escapes backslash before $ ` \" \\ and newline, dropping the backslash", () => {
		// \" -> " ; \\ -> \ ; \` -> ` ; \$ -> $
		expect(splitShellWords(String.raw`"a\"b\\c\`d\$e"`)).toEqual(['a"b\\c`d$e']);
	});

	it("keeps a backslash literally before any other character", () => {
		// \n inside double quotes is NOT an escape; the backslash is literal.
		expect(splitShellWords('"a\\nb"')).toEqual(["a\\nb"]);
		expect(splitShellWords('"\\x"')).toEqual(["\\x"]);
	});

	it("allows an escaped double quote inside the quoted region", () => {
		expect(splitShellWords('"say \\"hi\\""')).toEqual(['say "hi"']);
	});

	it("concatenates adjacent quoted and unquoted runs into one word", () => {
		expect(splitShellWords('pre"mid"post')).toEqual(["premidpost"]);
		expect(splitShellWords('a"x"y')).toEqual(["axy"]);
	});

	it("counts both double-quote delimiters", () => {
		const { meta } = splitShellWordsWithMeta('"word"');
		expect(meta.quoteDelimitersConsumed).toBe(2);
	});
});

describe("splitShellWords — backslash escaping (unquoted)", () => {
	it("escapes the next character", () => {
		expect(splitShellWords("a\\ b c")).toEqual(["a b", "c"]); // escaped space
		expect(splitShellWords("a\\b")).toEqual(["ab"]);
	});

	it("escapes a quote so it is kept literally and not counted as a delimiter", () => {
		const { words, meta } = splitShellWordsWithMeta('a\\"b');
		expect(words).toEqual(['a"b']);
		expect(meta.quoteDelimitersConsumed).toBe(0);
	});

	it("keeps a trailing backslash literally", () => {
		expect(splitShellWords("\\")).toEqual(["\\"]);
		expect(splitShellWords("x\\")).toEqual(["x\\"]);
		expect(splitShellWords("a\\")).toEqual(["a\\"]);
	});
});

describe("splitShellWords — empty quoted regions yield empty words (POSIX)", () => {
	// Regression: previously empty quotes were dropped entirely, so `a "" b`
	// wrongly split into ["a","b"] instead of the 3-arg ["a","","b"] a real
	// shell produces.
	it("single empty quotes between words keep an empty-string argument", () => {
		expect(splitShellWords("a '' b")).toEqual(["a", "", "b"]);
	});

	it("double empty quotes between words keep an empty-string argument", () => {
		expect(splitShellWords('a "" b')).toEqual(["a", "", "b"]);
	});

	it("a sole empty-quoted value yields one empty word", () => {
		expect(splitShellWords("''")).toEqual([""]);
		expect(splitShellWords('""')).toEqual([""]);
	});

	it("an empty-quoted value adjacent to a literal concatenates", () => {
		expect(splitShellWords("''hello")).toEqual(["hello"]);
		expect(splitShellWords('x""')).toEqual(["x"]);
	});
});

describe("splitShellWords — the documented quote-stripping footgun", () => {
	// `secret("X", "Y")` written WITHOUT an enclosing quote pair: the inner
	// quotes are consumed as quoting and the value is corrupted. This is the
	// exact case the builtin-command parser detects and rejects. The splitter's
	// own job is to do the (spec-correct) stripping; here we just pin it.
	it("strips the inner quotes and splits at the now-unquoted space", () => {
		const { words, meta } = splitShellWordsWithMeta(`secret("X", "Y")`);
		expect(words).toEqual(["secret(X,", "Y)"]);
		expect(meta.quoteDelimitersConsumed).toBe(4);
	});
});

describe("splitShellWords — unterminated quotes (best-effort)", () => {
	it("keeps whatever was collected for an unterminated single quote", () => {
		expect(splitShellWords("'abc def")).toEqual(["abc def"]);
		expect(splitShellWords("'unterminated")).toEqual(["unterminated"]);
	});

	it("keeps whatever was collected for an unterminated double quote", () => {
		expect(splitShellWords('"abc def')).toEqual(["abc def"]);
		expect(splitShellWords('"unterminated')).toEqual(["unterminated"]);
	});
});

describe("splitShellWordsWithMeta — quote delimiter accounting", () => {
	it("counts every consumed quote delimiter", () => {
		// 4 delimiters (2 pairs) inside one word
		expect(splitShellWordsWithMeta('secret("X", "Y")').meta.quoteDelimitersConsumed).toBe(4);
	});

	it("counts zero for bare unquoted words", () => {
		expect(splitShellWordsWithMeta("hello world foo").meta.quoteDelimitersConsumed).toBe(0);
	});

	it("counts a fully-quoted single word's pair as 2", () => {
		const { words, meta } = splitShellWordsWithMeta('"hello world"');
		expect(words).toEqual(["hello world"]);
		expect(meta.quoteDelimitersConsumed).toBe(2);
	});

	it("still accounts for an empty-quoted pair", () => {
		expect(splitShellWordsWithMeta('""').meta.quoteDelimitersConsumed).toBe(2);
	});
});

// ============================================================================
// Shared scanner: hasShellControlSyntax / splitShellSegments
// ============================================================================

describe("hasShellControlSyntax", () => {
	it("detects bare control operators", () => {
		expect(hasShellControlSyntax("a | b")).toBe(true);
		expect(hasShellControlSyntax("a && b")).toBe(true);
		expect(hasShellControlSyntax("a; b")).toBe(true);
		expect(hasShellControlSyntax("a > f")).toBe(true);
		expect(hasShellControlSyntax("a < f")).toBe(true);
		expect(hasShellControlSyntax("a\nb")).toBe(true);
	});

	it("ignores operators inside quotes", () => {
		expect(hasShellControlSyntax("echo 'a | b'")).toBe(false);
		expect(hasShellControlSyntax('echo "a && b"')).toBe(false);
		expect(hasShellControlSyntax("echo 'x; y'")).toBe(false);
	});

	it("ignores escaped operators outside quotes", () => {
		expect(hasShellControlSyntax("echo a\\|b")).toBe(false);
		expect(hasShellControlSyntax("echo a\\;b")).toBe(false);
	});

	it("POSIX single quotes: backslash is literal, does NOT extend the quote", () => {
		// In POSIX sh, 'a\' closes at the second quote — the ; after it is a
		// REAL operator. The old scanner treated \' as an escape and stayed
		// "inside quotes", missing the operator (classification bypass).
		expect(hasShellControlSyntax("echo 'a\\' ; rm x")).toBe(true);
	});

	it("double quotes: backslash escapes the quote, keeping the ; inside the string", () => {
		// echo "a\" ; rm x" — the \" is an escaped quote, so the string runs to
		// the final quote and the ; is DATA (bash prints: a" ; rm x).
		expect(hasShellControlSyntax('echo "a\\" ; rm x"')).toBe(false);
	});

	it("clean builtin-style commands have no control syntax", () => {
		expect(hasShellControlSyntax("_read src/main.ts 10 50")).toBe(false);
		expect(hasShellControlSyntax('_write out.txt "hello world"')).toBe(false);
	});
});

describe("splitShellSegments", () => {
	it("splits on && || ; and |", () => {
		expect(splitShellSegments("a && b")).toEqual(["a ", " b"]);
		expect(splitShellSegments("a || b")).toEqual(["a ", " b"]);
		expect(splitShellSegments("a; b")).toEqual(["a", " b"]);
		expect(splitShellSegments("a | b")).toEqual(["a ", " b"]);
	});

	it("does not split on quoted operators", () => {
		expect(splitShellSegments("echo 'a && b'")).toEqual(["echo 'a && b'"]);
		expect(splitShellSegments('echo "x | y"')).toEqual(['echo "x | y"']);
	});

	it("does not split on escaped operators", () => {
		expect(splitShellSegments("echo a\\;b")).toEqual(["echo a\\;b"]);
	});

	it("single & (background) is not a separator", () => {
		expect(splitShellSegments("sleep 1 & wait")).toEqual(["sleep 1 & wait"]);
	});

	it("handles multi-operator chains", () => {
		expect(splitShellSegments("a && b; c | d")).toEqual(["a ", " b", " c ", " d"]);
	});

	it("single-quote backslash does not hide a following separator (POSIX)", () => {
		const segments = splitShellSegments("echo 'a\\' && _read f");
		expect(segments).toHaveLength(2);
		expect(segments[1].trim()).toBe("_read f");
	});
});
