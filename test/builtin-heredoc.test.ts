/**
 * Tests for parseBuiltinCommandWithHeredoc.
 *
 * Regression coverage for quoted heredoc delimiters (<<'EOF' / <<"EOF"),
 * which previously fell through to the system shell's `write` utility.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createBashTool } from "../src/core/tools/bash.js";
import { parseBuiltinCommandWithHeredoc, parseBuiltinCommand } from "../src/core/tools/builtin-commands.js";

describe("parseBuiltinCommandWithHeredoc", () => {
	it("parses an unquoted heredoc delimiter", () => {
		const result = parseBuiltinCommandWithHeredoc("write /tmp/a.txt <<EOF\nhello\nworld\nEOF");
		expect(result).not.toBeNull();
		expect(result!.command).toBe("write");
		expect(result!.args).toEqual(["/tmp/a.txt"]);
		expect(result!.heredoc).toBe("hello\nworld");
	});

	it("parses a single-quoted heredoc delimiter (<<'EOF')", () => {
		const result = parseBuiltinCommandWithHeredoc("write /tmp/a.txt <<'EOF'\nhello\nworld\nEOF");
		expect(result).not.toBeNull();
		expect(result!.command).toBe("write");
		expect(result!.args).toEqual(["/tmp/a.txt"]);
		expect(result!.heredoc).toBe("hello\nworld");
	});

	it("parses a double-quoted heredoc delimiter (<<\"EOF\")", () => {
		const result = parseBuiltinCommandWithHeredoc('write /tmp/a.txt <<"EOF"\nhello\nworld\nEOF');
		expect(result).not.toBeNull();
		expect(result!.heredoc).toBe("hello\nworld");
	});

	it("preserves content verbatim, including special characters", () => {
		const result = parseBuiltinCommandWithHeredoc(
			"write /tmp/a.txt <<EOF\nline1\nline2 with $var and `cmd`\nline3\nEOF",
		);
		expect(result!.heredoc).toBe("line1\nline2 with $var and `cmd`\nline3");
	});

	it("supports a custom delimiter word", () => {
		const result = parseBuiltinCommandWithHeredoc(
			"write /tmp/a.txt <<DONE\nfoo\nDONE",
		);
		expect(result!.heredoc).toBe("foo");
	});

	it("supports an empty heredoc body", () => {
		const result = parseBuiltinCommandWithHeredoc("write /tmp/a.txt <<EOF\n\nEOF");
		expect(result!.heredoc).toBe("");
	});

	it("returns null when the heredoc is not closed", () => {
		const result = parseBuiltinCommandWithHeredoc("write /tmp/a.txt <<EOF\nhello\nworld");
		expect(result).toBeNull();
	});

	it("requires the closing delimiter to be the bare word (not quoted)", () => {
		// Body closes with 'EOF' (quoted) instead of EOF → not a valid close.
		const result = parseBuiltinCommandWithHeredoc("write /tmp/a.txt <<'EOF'\nhi\n'EOF'");
		expect(result).toBeNull();
	});

	it("returns null for a non-heredoc command", () => {
		const result = parseBuiltinCommandWithHeredoc("read /tmp/a.txt");
		expect(result).toBeNull();
	});
});

describe("parseBuiltinCommand (heredoc integration)", () => {
	it("routes a quoted-heredoc write as a builtin (content in heredoc field)", () => {
		const result = parseBuiltinCommand("write /tmp/a.txt <<'EOF'\nhello\nEOF");
		expect(result.heredoc).toBe("hello");
		expect(result.command).toBe("write");
		expect(result.args).toEqual(["/tmp/a.txt"]);
	});

	it("still parses a plain (non-heredoc) command normally", () => {
		const result = parseBuiltinCommand("read /tmp/a.txt");
		expect(result.command).toBe("read");
		expect(result.args).toEqual(["/tmp/a.txt"]);
		expect(result.heredoc).toBeUndefined();
	});
});
describe("parseBuiltinCommand (backslash in quoted write content)", () => {
	it("preserves a literal backslash inside double quotes", () => {
		// Regression: backslash was dropped before the quote check, so "a\nb"
		// (4 chars) became "anb" (3 chars). POSIX keeps the backslash here.
		const result = parseBuiltinCommand('_write f.txt "a' + String.fromCharCode(0x5c) + 'nb"');
		expect(result.command).toBe("_write");
		expect(result.args).toEqual(["f.txt", "a" + String.fromCharCode(0x5c) + "nb"]);
	});

	it("preserves a literal backslash inside single quotes", () => {
		// Single quotes keep everything literally, including the backslash.
		const result = parseBuiltinCommand("_write f.txt 'a" + String.fromCharCode(0x5c) + "nb'");
		expect(result.args).toEqual(["f.txt", "a" + String.fromCharCode(0x5c) + "nb"]);
	});

	it("still treats a backslash as an escape when unquoted", () => {
		// Unquoted, backslash escapes the next char (shell semantics).
		const result = parseBuiltinCommand("_write f.txt a" + String.fromCharCode(0x5c) + "nb");
		expect(result.args).toEqual(["f.txt", "anb"]);
	});

	it("escapes a double-quote inside double quotes (\"a\\\"b\" -> a\"b)", () => {
		const result = parseBuiltinCommand('_write f.txt "a' + String.fromCharCode(0x5c) + '"b"');
		expect(result.args).toEqual(["f.txt", 'a"b']);
	});
});

/**
 * End-to-end routing: a quoted-heredoc write must be routed as a builtin
 * (writing the file) rather than falling through to the system shell's
 * `write` utility (which would error with "<path> is not logged in").
 */
describe("heredoc write routing via cli", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pizza-heredoc-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("writes a file via a quoted heredoc (<<'EOF') through the cli tool", async () => {
		const testFile = join(testDir, "soul.md");
		const bashTool = createBashTool(testDir);
		const command = `_write ${testFile.replace(/\\/g, "/")} <<'EOF'\n---\nname: Pizza\n---\nHello, world!\nEOF`;

		const result = await bashTool.execute("heredoc-quoted", { command });
		const out = (result.content ?? [])
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");

		expect(out).toContain("Successfully wrote");
		expect(existsSync(testFile)).toBe(true);
		expect(readFileSync(testFile, "utf-8")).toBe("---\nname: Pizza\n---\nHello, world!");
	});

	it("writes a file via a double-quoted heredoc (<<\"EOF\") through the cli tool", async () => {
		const testFile = join(testDir, "quoted.md");
		const bashTool = createBashTool(testDir);
		const command = `_write ${testFile.replace(/\\/g, "/")} <<"EOF"\nline one\nline two\nEOF`;

		await bashTool.execute("heredoc-double", { command });

		expect(readFileSync(testFile, "utf-8")).toBe("line one\nline two");
	});
});
