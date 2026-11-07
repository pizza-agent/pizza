import { describe, expect, it } from "vitest";
import { detectChainedBuiltin } from "../src/core/tools/shell.js";
import { BUILTIN_COMMANDS } from "../src/core/tools/builtin-cli-commands.js";

const TOKENS = [...BUILTIN_COMMANDS, "_echotest"];

describe("detectChainedBuiltin", () => {
	it("detects a built-in command chained after &&", () => {
		expect(detectChainedBuiltin("sed -i '' x && _read src/main.ts 88 8", TOKENS)).toBe("_read");
	});

	it("detects a built-in command after ;", () => {
		expect(detectChainedBuiltin("echo hi; _write out.txt hello", TOKENS)).toBe("_write");
	});

	it("detects a built-in command after |", () => {
		expect(detectChainedBuiltin("echo hi | _edit f.ts replace 1#a x", TOKENS)).toBe("_edit");
	});

	it("detects other built-ins in chains", () => {
		expect(detectChainedBuiltin("false || _history_tree list", TOKENS)).toBe("_history_tree");
		expect(detectChainedBuiltin("a && b && _session_split topic", TOKENS)).toBe("_session_split");
		expect(detectChainedBuiltin("foo && _tell list", TOKENS)).toBe("_tell");
	});

	it("returns null when the built-in leads the command", () => {
		expect(detectChainedBuiltin("_read src/main.ts", TOKENS)).toBeNull();
	});

	it("ignores _-tokens that are not the first word of a later segment", () => {
		expect(detectChainedBuiltin("grep _read file.txt", TOKENS)).toBeNull();
		expect(detectChainedBuiltin("echo '_read is great' && true", TOKENS)).toBeNull();
		expect(detectChainedBuiltin("printf '%s' _read", TOKENS)).toBeNull();
	});

	it("is case-insensitive", () => {
		expect(detectChainedBuiltin("foo && _READ x", TOKENS)).toBe("_read");
	});

	it("ignores _-tokens inside quoted strings", () => {
		expect(detectChainedBuiltin("echo 'a && _read'", TOKENS)).toBeNull();
	});

	it("covers dynamic extension command tokens", () => {
		expect(detectChainedBuiltin("sed -i '' x && _echotest ping", TOKENS)).toBe("_echotest");
	});

	it("returns null for commands with no command-table names", () => {
		expect(detectChainedBuiltin("grep -rn foo . | head", TOKENS)).toBeNull();
		expect(detectChainedBuiltin("git status && git diff", TOKENS)).toBeNull();
	});
});
