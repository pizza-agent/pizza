/**
 * CLI entry point for the coding agent.
 * `pizza builtin _read|_write|_edit ...` runs a built-in cli command outside a
 * session through the same command-table entries the cli tool uses; commands
 * that need a session (_skill, _cron, ...) are rejected. Everything else goes
 * to main.ts.
 * Loaded dynamically by cli.ts — see that file for why this is not a
 * static import chain.
 */
import { writeFileSync } from "node:fs";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { executeCompatCommand, COMPAT_COMMANDS } from "./core/tools/compat-commands.js";
import { BUILTIN_COMMANDS, createBuiltinCliCommands } from "./core/tools/builtin-cli-commands.js";
import { isHelpRequest } from "./core/tools/builtin-commands.js";
import { getCliCommandHelp } from "./core/tools/command-resolve.js";
import { main } from "./main.js";
import { cliArguments } from "../packages/cli/argv.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

function writeCompatOutput(fd: 1 | 2, text: string): void {
	if (!text) return;
	try {
		writeFileSync(fd, text);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
	}
}
// Check if this is a built-in command call
const args = cliArguments(process.argv, process.execArgv);
const BUILTIN_EXTENSION_SUBCOMMANDS = new Set(["list", "enable", "disable"]);
// `pizza builtin list|enable|disable` manages built-in EXTENSIONS (in main.ts),
// not the built-in CLI commands (_read/_write/_edit/…). Route those to main() so
// cli.ts's built-in-command handling does not intercept them.
const isBuiltinExtensionCommand =
	args[0] === "builtin" && BUILTIN_EXTENSION_SUBCOMMANDS.has(args[1]);

if (args[0] === "__compat" && args.length >= 2) {
	const command = args[1];
	if (!COMPAT_COMMANDS.includes(command as any)) {
		console.error(`Unknown compat command: ${command}`);
		console.error(`Available compat commands: ${COMPAT_COMMANDS.join(", ")}`);
		process.exit(2);
	}

	const result = await executeCompatCommand(command, args.slice(2), { cwd: process.cwd() });
	writeCompatOutput(1, result.stdout);
	writeCompatOutput(2, result.stderr);
	process.exitCode = result.exitCode;
} else if (args[0] === "builtin" && args.length >= 2 && !isBuiltinExtensionCommand) {
	const command = args[1];
	const cwd = process.cwd();
	const spec = createBuiltinCliCommands(cwd).find((entry) => entry.name === command);
	if (!spec) {
		console.error(`Unknown builtin command: ${command}`);
		console.error(`Available commands: ${BUILTIN_COMMANDS.join(", ")}`);
		process.exit(1);
	}
	const commandArgs = args.slice(2);
	if (isHelpRequest(commandArgs)) {
		console.log(getCliCommandHelp(spec));
		process.exit(0);
	}
	// Outside a session only the file commands can run.
	if (!["_read", "_write", "_edit"].includes(command)) {
		console.error(`${command} requires an active agent session and is executed through the cli tool.`);
		process.exit(1);
	}
	try {
		const params = spec.parseArguments!(commandArgs, undefined, {});
		const result = await spec.execute(`builtin_${Date.now()}`, params, undefined, undefined, {} as never);
		const text = result.content
			.filter((block) => block.type === "text")
			.map((block) => (block as { text: string }).text)
			.join("\n");
		if (text) console.log(text);
		process.exit(0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
} else {
	main(args);
}
