import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { cliArguments } from "../packages/cli/argv.js";

describe("CLI argv", () => {
	test("keeps the version flag when the CLI is imported from node -e", () => {
		const output = execFileSync(process.execPath, [
			"-e", "console.log(JSON.stringify({argv: process.argv, execArgv: process.execArgv}))",
			"--", "--version",
		], { encoding: "utf8", timeout: 5000 });
		const { argv, execArgv } = JSON.parse(output);
		expect(cliArguments(argv, execArgv)).toEqual(["--version"]);
	});

	test("skips the script path for normal and compiled CLI entry points", () => {
		expect(cliArguments(["node", "/pizza/cli.js", "--version"], [])).toEqual(["--version"]);
		expect(cliArguments(["bun", "/pizza", "--mode", "rpc"], [])).toEqual(["--mode", "rpc"]);
	});

	test("keeps positional arguments and handles eval/print aliases", () => {
		for (const flag of ["-e", "--eval", "--eval=code", "-p", "--print", "--print=code"]) {
			expect(cliArguments(["node", "hello"], [flag])).toEqual(["hello"]);
		}
	});
});
