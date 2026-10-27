import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/exec/bash-executor.js";
import { executeBuiltinCommand, parseTellInput } from "../src/core/tools/builtin-commands.js";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.js";
import { formatLineAnchor } from "../src/core/tools/line-anchors.js";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.js";
import * as shellModule from "../src/utils/shell.js";
import { getToolPath } from "../src/utils/tools-manager.js";

const hasRipgrep = getToolPath("rg") !== null;

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const findTool = createFindTool(process.cwd());
const lsTool = createLsTool(process.cwd());

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function lineAnchor(lineNumber: number, text: string): string {
	return formatLineAnchor(lineNumber, text);
}

function lineRange(startLine: number, startText: string, endLine?: number, endText?: string): string {
	const start = lineAnchor(startLine, startText);
	if (endLine === undefined || endText === undefined || (endLine === startLine && endText === startText)) {
		return start;
	}
	return `${start}..${lineAnchor(endLine, endText)}`;
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(
				`${lineAnchor(1, "Hello, world!")} | Hello, world!\n${lineAnchor(2, "Line 2")} | Line 2\n${lineAnchor(3, "Line 3")} | Line 3`,
			);
			// No truncation message since file fits within limits
			expect(getTextOutput(result)).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
		});

		it("should read raw text when anchors are disabled", async () => {
			const testFile = join(testDir, "raw.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-raw-1", { path: testFile, anchors: "none" });

			expect(getTextOutput(result)).toBe(content);
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds 50KB byte limit but has fewer than 2000 lines
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});

		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(getTextOutput(result)).toContain(testFile);
			expect(result.details).toBeUndefined();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace an anchored line in a file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!\n";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ op: "replace", range: lineAnchor(1, "Hello, world!"), new: "Hello, testing!" }],
			});

			expect(getTextOutput(result)).toContain("Successfully applied 1 edit(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("Hello, testing!\n");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("Hello, testing!");
		});

		it("should fail if the range is stale", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ op: "replace", range: lineAnchor(1, "old content"), new: "Hello, testing!" }],
				}),
			).rejects.toThrow(/range .* is stale/);
		});

		it("should fail if a relocated range is ambiguous", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "header\nfoo\nbar\nfoo\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ op: "replace", range: lineAnchor(10, "foo"), new: "FOO" }],
				}),
			).rejects.toThrow(/ambiguous/);
		});

		it("should replace multiple disjoint ranges in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ op: "replace", range: lineAnchor(1, "alpha"), new: "ALPHA" },
					{ op: "replace", range: lineAnchor(3, "gamma"), new: "GAMMA" },
				],
			});

			expect(getTextOutput(result)).toContain("Successfully applied 2 edit(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		it("should insert before and after anchored lines without repeating the anchor line", async () => {
			const testFile = join(testDir, "edit-insert.txt");
			writeFileSync(testFile, "alpha\nbeta\n");

			const result = await editTool.execute("test-call-insert", {
				path: testFile,
				edits: [
					{ op: "insert_before", range: lineAnchor(1, "alpha"), new: "before alpha" },
					{ op: "insert_after", range: lineAnchor(2, "beta"), new: "after beta" },
				],
			});

			expect(getTextOutput(result)).toContain("Successfully applied 2 edit(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("before alpha\nalpha\nbeta\nafter beta\n");
		});

		it("should delete an anchored range without new text", async () => {
			const testFile = join(testDir, "edit-delete.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			await editTool.execute("test-call-delete", {
				path: testFile,
				edits: [{ op: "delete", range: lineRange(2, "beta", 3, "gamma") }],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("alpha\ndelta\n");
		});

		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			writeFileSync(testFile, `${lines.join("\n")}\n`);

			const result = await editTool.execute("test-call-8b", {
				path: testFile,
				edits: [
					{ op: "replace", range: lineAnchor(100, "line 100"), new: "LINE 100" },
					{ op: "replace", range: lineAnchor(300, "line 300"), new: "LINE 300" },
					{ op: "replace", range: lineAnchor(500, "line 500"), new: "LINE 500" },
				],
			});

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});

		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ op: "replace", range: lineAnchor(1, "foo"), new: "foo bar" },
					{ op: "replace", range: lineAnchor(2, "bar"), new: "BAR" },
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/edits must contain at least one edit/);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ op: "replace", range: lineRange(1, "one", 2, "two"), new: "ONE\nTWO" },
						{ op: "replace", range: lineRange(2, "two", 3, "three"), new: "TWO\nTHREE" },
					],
				}),
			).rejects.toThrow(/overlap/);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ op: "replace", range: lineAnchor(1, "alpha"), new: "ALPHA" },
						{ op: "replace", range: lineAnchor(2, "missing"), new: "MISSING" },
					],
				}),
			).rejects.toThrow(/stale/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});
	});

	describe("cli tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should show help for built-in commands", async () => {
			for (const command of ["_read", "_write", "_edit", "_session_split", "_history_tree", "_tell"]) {
				const result = await bashTool.execute(`test-help-${command}`, { command: `${command} -h` });
				const output = getTextOutput(result);

				expect(output).toContain(`${command} -`);
				expect(output).toContain("Description:");
				expect(output).toContain("Parameters:");
				expect(output).toContain("Examples:");
				expect(result.details).toBeUndefined();
			}
		});

		it("should show help from the direct builtin command entry point", async () => {
			const result = await executeBuiltinCommand("_edit", ["--help"], { cwd: testDir });

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("_edit - Edit a file with read range anchors or search-and-replace");
			expect(result.stdout).toContain("--edits, -e");
			expect(result.stdout).toContain("--range, -r");
			expect(result.stdout).toContain("Examples:");
		});

		it("parses tell send positionals without swallowing the first message word when --to is given", () => {
			// `_tell send --to X smoke test ...` — with `--to` as a flag, ALL
			// positionals after the action are the message ("smoke" must survive).
			const parsed = parseTellInput(["send", "--to", "/proj/web", "smoke", "test", "delivery"], undefined);
			expect(parsed.action).toBe("send");
			expect(parsed.to).toBe("/proj/web");
			expect(parsed.message).toBe("smoke test delivery");
		});

		it("parses tell send in the positional <to> <message...> form", () => {
			const parsed = parseTellInput(["send", "/proj/web", "hello", "there"], undefined);
			expect(parsed.action).toBe("send");
			expect(parsed.to).toBe("/proj/web");
			expect(parsed.message).toBe("hello there");
		});

		it("should route tell list through the cli tool when the tell option is set", async () => {
			// cli tool with tell option: tell routes to the tell definition.
			const tool = createBashTool(process.cwd(), { tell: { agentDir: "/tmp/no-such-agent-dir" } });
			const result = await tool.execute("test-tell-list", { command: "_tell list" });
			const output = getTextOutput(result);
			expect(output).toContain("No known workspace agents found");
			expect(result.details?.builtin?.name).toBe("tell");
		});

		it("should reject shell operators on built-in commands instead of falling back to the shell", async () => {
			const tool = createBashTool(process.cwd());
			// Pipe: read must NOT degrade to the shell (where `read` is the bash builtin).
			const piped = await tool.execute("test-read-pipe", { command: "_read src/main.ts | grep foo" });
			const pipedOut = getTextOutput(piped);
			expect(pipedOut).toContain("does not support shell operators");
			expect(pipedOut).toContain("_read");

			// Redirect on write: must NOT fall through to the shell (which would run chained cmds).
			const redirected = await tool.execute("test-write-redir", { command: "_write a.txt hi > out.txt" });
			expect(getTextOutput(redirected)).toContain("does not support shell operators");

			// Chaining: a `;` after a built-in must not execute the trailing shell command.
			const chained = await tool.execute("test-edit-chain", { command: "_edit x.ts search a b ; echo pwned" });
			const chainedOut = getTextOutput(chained);
			expect(chainedOut).toContain("does not support shell operators");
			expect(chainedOut).not.toContain("pwned");
		});

		it("should still route a pure built-in command (operators inside quoted args are fine)", async () => {
			const tool = createBashTool(process.cwd());
			// `;` is inside the quoted search text — not a shell operator, so it routes normally.
			const result = await tool.execute("test-help-quoted", { command: "_read -h" });
			expect(getTextOutput(result)).toContain("_read -");
		});

		it("should reject non-file commands from the direct builtin command entry point", async () => {
			const result = await executeBuiltinCommand("grep", ["--help"], { cwd: testDir });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Unknown builtin command: grep");
			expect(result.stderr).toContain("_read, _write, _edit");
		});

		it("should prefer bundled fd/rg binaries from the package", async () => {
			const originalPackageDir = process.env.PIZZA_PACKAGE_DIR;
			const packageDir = join(testDir, "package");
			const platformKey = `${process.platform}-${process.arch}`;
			const bundledBinDir = join(packageDir, "dist", "vendor", "bin", platformKey);
			const rgName = process.platform === "win32" ? "rg.exe" : "rg";
			const bundledRgPath = join(bundledBinDir, rgName);
			mkdirSync(bundledBinDir, { recursive: true });
			writeFileSync(bundledRgPath, "");

			try {
				process.env.PIZZA_PACKAGE_DIR = packageDir;
				expect(getToolPath("rg")).toBe(bundledRgPath);
			} finally {
				if (originalPackageDir === undefined) {
					delete process.env.PIZZA_PACKAGE_DIR;
				} else {
					process.env.PIZZA_PACKAGE_DIR = originalPackageDir;
				}
			}
		});

		it("should pass find, grep, and ls through the shell with native composition", async () => {
			writeFileSync(join(testDir, "alpha.txt"), "hello alpha\n", "utf-8");
			writeFileSync(join(testDir, "beta.md"), "hello beta\n", "utf-8");
			writeFileSync(join(testDir, "server.py"), "WORKER = 2\n", "utf-8");
			const localBashTool = createBashTool(testDir);

			const findResult = await localBashTool.execute("test-shell-find-pipeline", {
				command:
					"find . -name '*.py' | while IFS= read -r line; do case \"$line\" in *server.py) printf '%s\\n' \"$line\";; esac; done",
			});
			expect(findResult.details?.builtin).toBeUndefined();
			expect(getTextOutput(findResult)).toContain("server.py");

			const grepResult = await localBashTool.execute("test-shell-grep-pipeline", {
				command: "grep -rn 'WORKER' . | while IFS= read -r line; do printf '%s\\n' \"$line\"; break; done",
			});
			expect(grepResult.details?.builtin).toBeUndefined();
			expect(getTextOutput(grepResult)).toContain("server.py:1");

			const lsResult = await localBashTool.execute("test-shell-ls-glob", {
				command: "ls -1 *.py | while IFS= read -r line; do case \"$line\" in *server.py) printf '%s\\n' \"$line\";; esac; done",
			});
			expect(lsResult.details?.builtin).toBeUndefined();
			expect(getTextOutput(lsResult)).toContain("server.py");
		});

		it("should provide missing grep, find, and ls commands through temporary PATH shims", async () => {
			writeFileSync(join(testDir, "alpha.txt"), "hello alpha\nother\n", "utf-8");
			writeFileSync(join(testDir, "beta.md"), "hello beta\n", "utf-8");
			writeFileSync(join(testDir, "server.py"), "WORKER = 2\n", "utf-8");
			mkdirSync(join(testDir, "nested"));
			writeFileSync(join(testDir, "nested", "BETA.PY"), "print('beta')\n", "utf-8");
			writeFileSync(join(testDir, "nested", "empty.txt"), "", "utf-8");
			const shimOnlyBashTool = createBashTool(testDir, {
				spawnHook: (context) => ({
					...context,
					env: { ...context.env, PATH: "" },
				}),
			});

			const grepResult = await shimOnlyBashTool.execute("test-shim-grep-pipeline", {
				command: "printf 'foo\\nbar\\n' | grep foo",
			});
			expect(grepResult.details?.builtin).toBeUndefined();
			expect(getTextOutput(grepResult).trim()).toBe("foo");

			const findResult = await shimOnlyBashTool.execute("test-shim-find-pipeline", {
				command:
					"find . -name '*.py' | while IFS= read -r line; do case \"$line\" in *server.py) printf '%s\\n' \"$line\";; esac; done",
			});
			expect(findResult.details?.builtin).toBeUndefined();
			expect(getTextOutput(findResult)).toContain("server.py");

			const lsResult = await shimOnlyBashTool.execute("test-shim-ls-grep-pipeline", {
				command: "ls -1 *.py | grep server.py",
			});
			expect(lsResult.details?.builtin).toBeUndefined();
			expect(getTextOutput(lsResult).trim()).toBe("server.py");

			const commonArgsResult = await shimOnlyBashTool.execute("test-shim-common-args", {
				command: [
					"fail() { printf '%s\\n' \"$1\"; exit 1; }",
					"grep_count=$(grep -c -v alpha alpha.txt)",
					"[ \"$grep_count\" = \"1\" ] || fail \"grep -c -v mismatch: $grep_count\"",
					"grep_only=$(grep -oiw alpha alpha.txt)",
					"[ \"$grep_only\" = \"alpha\" ] || fail \"grep -o -i -w mismatch: $grep_only\"",
					"grep_files=$(grep -Rl --include '*.txt' alpha .)",
					"case \"$grep_files\" in *alpha.txt*) ;; *) fail \"grep --include mismatch: $grep_files\";; esac",
					"find_py=$(find . -maxdepth 2 -type f -iname '*.py')",
					"case \"$find_py\" in *server.py*BETA.PY*|*BETA.PY*server.py*) ;; *) fail \"find -iname mismatch: $find_py\";; esac",
					"find_not_md=$(find . -type f ! -name '*.md')",
					"case \"$find_not_md\" in *beta.md*) fail \"find ! -name included md\";; *) ;; esac",
					"find_or=$(find . -name '*.txt' -o -name '*.py')",
					"case \"$find_or\" in *alpha.txt*server.py*) ;; *) fail \"find -o mismatch: $find_or\";; esac",
					"find_empty=$(find . -type f -empty)",
					"case \"$find_empty\" in *nested/empty.txt*) ;; *) fail \"find -empty mismatch: $find_empty\";; esac",
					"ls_all=$(ls -1A)",
					"case \"$ls_all\" in *alpha.txt*nested*) ;; *) fail \"ls -A mismatch: $ls_all\";; esac",
					"ls_slash=$(ls -p .)",
					"case \"$ls_slash\" in *nested/*) ;; *) fail \"ls -p mismatch: $ls_slash\";; esac",
					"ls_recursive=$(ls -R nested)",
					"case \"$ls_recursive\" in *BETA.PY*empty.txt*) ;; *) fail \"ls -R mismatch: $ls_recursive\";; esac",
					"printf 'common-args-ok\\n'",
				].join("\n"),
			});
			expect(commonArgsResult.details?.builtin).toBeUndefined();
			expect(getTextOutput(commonArgsResult).trim()).toBe("common-args-ok");
		});

		it("should handle command errors", async () => {
			await expect(bashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/(Command failed|code 1)/,
			);
		});

		it("should respect timeout in milliseconds", async () => {
			await expect(bashTool.execute("test-call-10", { command: "sleep 5", timeout: 100 })).rejects.toThrow(
				"Command timed out after 100ms",
			);
		});

		it("should let a command finish within its millisecond timeout", async () => {
			const result = await bashTool.execute("test-timeout-completes", { command: "echo ok", timeout: 1000 });
			expect(getTextOutput(result).trim()).toBe("ok");
		});

		it("should pass milliseconds unchanged to custom command operations", async () => {
			const exec = vi.fn(async () => ({ exitCode: 0 }));
			const tool = createBashTool(testDir, { operations: { exec } });
			await tool.execute("test-custom-timeout", { command: "echo ok", timeout: 1500 });
			expect(exec).toHaveBeenCalledWith("echo ok", testDir, expect.objectContaining({ timeout: 1500 }));
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
			expect(output).not.toContain("Full output: undefined");

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});

	describe.skipIf(!hasRipgrep)("grep tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});
	});

	describe("find tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should surface fd glob parse errors", async () => {
			await expect(
				findTool.execute("test-call-15", {
					pattern: "[",
					path: testDir,
				}),
			).rejects.toThrow(/error parsing glob|fd exited with code 1|fd error/i);
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});

describe("edit tool line ending handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-line-ending-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should resolve LF ranges against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ op: "replace", range: lineAnchor(2, "line two"), new: "replaced line" }],
		});

		expect(getTextOutput(result)).toContain("Successfully applied");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ op: "replace", range: lineAnchor(2, "second"), new: "REPLACED" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ op: "replace", range: lineAnchor(2, "second"), new: "REPLACED" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should reject ambiguous relocated anchors across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ op: "replace", range: lineRange(10, "hello", 11, "world"), new: "replaced" }],
			}),
		).rejects.toThrow(/ambiguous/);
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ op: "replace", range: lineAnchor(2, "second"), new: "REPLACED" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ op: "replace", range: lineAnchor(2, "second"), new: "SECOND" },
				{ op: "replace", range: lineAnchor(4, "fourth"), new: "FOURTH" },
			],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
